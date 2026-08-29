import { Engine } from './audio/engine';
import { ParamBus } from './state/params';
import { PERF_PROFILES, resolveTier } from './state/perf-mode';
import { mountApp } from './ui/app';
import { installShortcuts } from './ui/shortcuts';
import { primeDetection } from './state/keyboard-layout';
import { initMIDI } from './audio/midi';
import { Presets } from './state/preset';
import { PresetSession, isPatchParam, patchSnapshot } from './state/preset-session';
import { SessionAutosave } from './state/session-autosave';
import { SampleAutosave, type StoredClip } from './state/sample-autosave';
import { PatternUndo } from './state/pattern-undo';
import { Song } from './state/song';
import { XyPadStore } from './state/xy-pad';
import { UiBridge } from './ui/ui-bridge';
import { parseSongLink, decodeSongPayload } from './state/song-link';
import { MAX_SONG_JSON_BYTES } from './state/limits';
import { Modal } from './ui/components/modal';
import { createBrand } from './ui/components/brand';
import { alertDialog, confirmDialog } from './ui/components/dialog';
import { WakeLockManager } from './utils/wake-lock';
import { showToast, type ToastHandle } from './ui/components/toast';
import { setClipStatsSource, setMidiStatsSource, setWakeLockSource } from './state/debug-sources';
import type { Onboarding } from './ui/onboarding';

// Injected by Vite's `define` (vite.config.ts) — same precedent as about.ts.
declare const __APP_VERSION__: string;

/** Bounded wait for a `#songUrl=` download, so a dead host can't hang boot. */
const SONG_FETCH_TIMEOUT_MS = 15_000;

async function boot() {
  // Build the synth and mount the full UI immediately. Whether the AudioContext
  // comes back suspended is the *browser's* call, not ours — an autoplay-permitted
  // one is rendering from the moment it exists — so the boot does not assume it:
  // the master bus is seeded silent and only `Engine.resume()` raises it
  // (audio-lifecycle.md REQ-19). Which of the two start paths runs is decided at
  // the end of boot from `engine.autoplayAllowed` (REQ-20).
  const bus = new ParamBus();
  // Persisted sampler clips (sample-persistence.md REQ-5): kick the IndexedDB
  // read off FIRST — it needs no AudioContext, so its I/O overlaps the worklet
  // loading in engine.init() below and costs the boot ~nothing.
  const clipsPromise = SampleAutosave.loadAll();
  // Performance mode (device-aware, persisted outside the bus) trades a little
  // latency/polyphony/FX cost for a glitch-resistant graph on weak hardware.
  // The audio fields are read once here because they are fixed when the
  // AudioContext/graph are built (scope fps is applied live; see perf-mode.ts).
  const { latencyHint, voiceCount, scheduleAheadS, reverbIrMaxS, fxOversample, analyserFftSize, fps } =
    PERF_PROFILES[resolveTier()];

  // XY Pad axis assignment — pure state, persisted in songs (SongFile v3). Lives
  // outside the Engine (assignment survives while the pad window is closed) and
  // is shared by the UI *and* the motion sequencer (Engine reads it via opts.xy).
  const xy = new XyPadStore();

  const engine = new Engine(bus, {
    latencyHint, voiceCount, scheduleAheadS, reverbIrMaxS, fxOversample, analyserFftSize,
    xy, motionFps: fps,
  });
  await engine.init();

  // The selector reflects the active sound; a patch edit flips it to dirty.
  const session = new PresetSession();
  bus.onChange((id) => { if (isPatchParam(id)) session.markDirty(); });

  // Seed the boot patch before the UI mounts so controls construct reading the
  // applied values and the selector starts on a clean `basic`.
  Presets.ensureFactoryPresets();
  const basic = Presets.factory()['basic'];
  if (basic) Presets.apply(bus, basic);
  session.setActive('basic');

  // Silent session recovery (session-autosave.md REQ-5): restore the autosaved
  // working session over the boot patch, BEFORE the UI mounts so every control
  // constructs already reading the restored values.
  const restored = SessionAutosave.load();
  if (restored) {
    Song.apply(restored, bus, engine.patterns, engine.arrangement, xy, engine.sampler);
    // Same pin the Song panel's applySong makes (presets.md REQ-13) — which is
    // why the pinned sound needs no persistence of its own: restoring the song
    // restores it.
    session.setActiveSong(restored.name, patchSnapshot(bus.snapshot()));
  }

  // …and its sampler audio (sample-persistence.md). Awaited here, still before
  // mountApp, so the sampler panel constructs already seeing loaded slots — no
  // .needs-reload flash, and no race with the share-link / launchQueue
  // importers wired further down. A clip is restored only for a slot the
  // session names (REQ-6); orphans are dropped, undecodable ones skipped
  // (REQ-7) so the slot simply keeps its hint.
  const restoredClips = await restoreSamplerClips(engine, restored != null, clipsPromise);

  // Per-machine step-grid undo — pure state like session/xy, so it lives here
  // (not on StudioApi) and threads into the machine panels via mountApp.
  const patternUndo = new PatternUndo(engine.patterns);

  // Which characters this keyboard prints, before anything renders the note
  // mapping or binds to it (keyboard-layout.md REQ-3). Feature-detected and
  // failure-tolerant, so a browser without the API just costs one resolved
  // promise and leaves 'auto' reading as QWERTY.
  await primeDetection();

  const bridge = new UiBridge();
  const onboarding = mountApp(document.getElementById('app')!, engine, bus, bridge, session, xy, patternUndo);
  installShortcuts(engine, bus, bridge);

  // Continuous autosave — attached AFTER the restore so the restore itself
  // doesn't schedule a redundant rewrite. From here on, every param/pattern/
  // chain/xy edit re-arms a debounced full-session capture.
  const autosave = new SessionAutosave(() =>
    Song.capture(bus, engine.patterns, engine.arrangement, session.label || 'My Song', xy));
  autosave.attach({ bus, patterns: engine.patterns, arr: engine.arrangement, xy });

  // The audio sibling: one hook (SamplerMachine.onBufferChange) covers every
  // slot-filling path. Seeded with what the restore just handed back, so those
  // clips are not immediately re-encoded and re-written.
  const clipStore = new SampleAutosave(engine.sampler);
  clipStore.noteRestored(restoredClips, engine.sampler.buffers);
  clipStore.attach();
  setClipStatsSource(() => clipStore.stats());

  // Keep the display awake exactly while the synth can make sound: the wake
  // lock follows the AudioContext state (running from the Tap-to-start resume;
  // suspended/interrupted releases it). Platform concern, so it lives here and
  // not in Engine (pwa-install.md REQ-1).
  const wake = new WakeLockManager();
  engine.ctx.addEventListener('statechange', () => {
    if (engine.ctx.state === 'running') wake.enable();
    else wake.disable();
  });
  setWakeLockSource(() => ({ supported: wake.supported, held: wake.held }));

  // A resume the platform refused leaves the app silent with nothing to look at,
  // which is the worst thing an instrument can do (audio-lifecycle.md REQ-14).
  // The Engine has already armed a one-shot listener so *any* tap fixes it —
  // this only says so out loud, and gets out of the way the moment audio is back.
  // Engine → UI through a subscription, never the reverse (ADR-001).
  let suspendedToast: ToastHandle | null = null;
  engine.onAudioBlocked((blocked) => {
    if (!blocked) { suspendedToast?.dismiss(); suspendedToast = null; return; }
    if (suspendedToast) return;
    const toast = showToast({
      message: 'Audio is suspended — tap to resume.',
      actionLabel: 'Resume',
      onAction: () => { void engine.resume(); },
      durationMs: 0,   // sticky: it is true until the audio is actually back
      testId: 'audio-suspended-toast',
    });
    // Single-slot: another toast can evict this one. Harmless — the toast is
    // not what performs the recovery, so let the reference go with it.
    toast.onDismiss(() => { if (suspendedToast === toast) suspendedToast = null; });
    suspendedToast = toast;
  });

  // Dev-only debug bridge for E2E tests (Playwright drives the dev server, so
  // import.meta.env.DEV is true there). Lets specs read/drive state directly —
  // e.g. window.__synth.bus.get('filter.cutoff'). Absent in production builds.
  if (import.meta.env.DEV) {
    (window as unknown as { __synth?: unknown }).__synth = {
      engine,
      bus,
      patterns: engine.patterns,
      session,
      xy,
      patternUndo,
    };
  }

  // OS-launched song files (installed-PWA file_handlers; Chromium desktop
  // only today). Applying a song is pure state and decodeAudioData works on
  // a suspended context, so a file arriving before "Tap to start" applies
  // fine behind the start modal. See pwa-install.md REQ-5.
  if (window.launchQueue) {
    window.launchQueue.setConsumer((params) => {
      void (async () => {
        for (const handle of params.files) {
          const file = await handle.getFile();
          await bridge.importSongBytes(new Uint8Array(await file.arrayBuffer()), file.name);
        }
      })();
    });
  }

  // Shareable song links (song-share-link.md): #song=<payload> embeds the
  // song, #songUrl=<https url> points at a hosted song/project file. Both
  // funnel through the same import path as the Import button / launchQueue,
  // so parse errors surface in the normal import dialog. The hash is consumed
  // only on success (REQ-4), so a bad link stays visible in the address bar for
  // the user to inspect/copy.
  const link = parseSongLink(window.location.hash);

  const applySongLink = async (l: NonNullable<typeof link>): Promise<void> => {
    try {
      let bytes: Uint8Array;
      let name = 'shared-song.json';
      if (l.kind === 'data') {
        // Self-contained: no network, no third party. The payload is size-capped
        // in decodeSongPayload.
        bytes = new TextEncoder().encode(await decodeSongPayload(l.payload));
      } else {
        const fetched = await fetchSharedSong(l.url);
        if (!fetched) return; // declined — leave the hash for the user to inspect
        bytes = fetched;
        // Keep the URL's filename tail so a .zip project routes through the
        // magic-byte sniff with its extension fallback intact.
        name = l.url.replace(/[?#].*$/, '').replace(/^.*\//, '') || name;
      }
      const ok = await bridge.importSongBytes(bytes, name);
      if (ok) history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (e) {
      await alertDialog({
        title: 'Could not load the shared song',
        message: (e as Error).message,
      });
    }
  };

  // An embedded payload applies at boot: it is pure state, so it works behind
  // the start modal (like launchQueue above). A #songUrl= link cannot — it has
  // to ASK first (REQ-7), and a dialog raised now would render *under* the start
  // modal, unreachable. So it waits for the start gesture, the same reason the
  // restored-clips toast does.
  if (link?.kind === 'data') void applySongLink(link);

  // Everything the start gesture used to carry beyond unlocking the audio
  // itself (audio-lifecycle.md REQ-21). `deferPlatform` is the auto-start path:
  // there is no gesture yet, so the two pieces that genuinely want one wait for
  // the next real touch instead of demanding a dedicated tap.
  const onStart = ({ deferPlatform }: { deferPlatform: boolean }): void => {
    // MIDI is never initialized at boot: Chrome ≥124 gates all Web MIDI behind a
    // permission prompt, and prompting on page load is hostile to MIDI-less
    // visitors. The resolved access handle feeds the Debug panel's port counts;
    // it stays "n/a" until here, which is exactly when MIDI first exists.
    const platform = (): void => {
      void initMIDI(engine, bus).then((access) => {
        if (access) setMidiStatsSource(() => ({ inputs: access.inputs.size, outputs: access.outputs.size }));
      });
      // The Android keep-alive wants a gesture too, and an auto-start's own call
      // was made without one, so it may have been refused. `resume()` is the
      // door to both platform unlocks and is idempotent on a running context
      // (audio-lifecycle.md REQ-2 — no dip, no second ctx.resume), so re-running
      // it from inside a real gesture is all the retry needed.
      if (deferPlatform) void engine.resume();
    };
    if (deferPlatform) engine.onFirstGesture(platform);
    else platform();

    // Tell the user their sampler audio came back from storage rather than the
    // song file (sample-persistence.md REQ-8). Deferred off boot only because it
    // would otherwise have appeared *under* the start modal — with no modal it
    // has nothing to hide behind, so it runs here either way.
    if (restoredClips.length > 0) {
      showToast({
        message: `Restored ${restoredClips.length} sampler clip${restoredClips.length === 1 ? '' : 's'}`,
        testId: 'clips-restored-toast',
      });
    }
    // A #songUrl= link needs consent (song-share-link.md REQ-7); same reason it
    // waited — its dialog would have been trapped under the start modal.
    if (link?.kind === 'url') void applySongLink(link);
  };

  // The start modal exists to buy a user gesture, so it is shown only when the
  // browser actually demands one (audio-lifecycle.md REQ-20). A context created
  // `running` means the output stream is already open — audio is unblocked, and
  // resuming here takes REQ-19's fade, so the start is click-free without it.
  if (engine.autoplayAllowed) {
    await engine.resume();
    onStart({ deferPlatform: true });
    // First-visit only, and the same 350 ms beat the modal path uses so the
    // tour's interactive "press a key" step lands on unlocked audio.
    if (onboarding.shouldAutoLaunch()) setTimeout(() => onboarding.startTour(), 350);
  } else {
    showStartModal(engine, onboarding, () => onStart({ deferPlatform: false }));
  }

  // Offline support — PRODUCTION-ONLY: the dev server (and Playwright, which
  // drives it) must never run under a service worker or HMR breaks. The `?v=`
  // query names the cache and makes each release a fresh registration URL.
  // Deferred to `load` to stay off the boot critical path — but boot() is
  // async, so `load` may have ALREADY fired by this line; check readyState or
  // the listener (and the registration) would silently never run.
  // See pwa-install.md REQ-6.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    const register = () =>
      void navigator.serviceWorker.register(`/sw.js?v=${__APP_VERSION__}`).catch(() => {});
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register);
  }

  // The MP3 encoder (~153 kB of pre-minified lamejs) is split into its own
  // chunk and only imported when something actually encodes MP3, so it stays
  // off the boot critical path. Warm it once boot is idle: the service worker
  // has no precache manifest of hashed assets, so a chunk never fetched while
  // online would be missing offline. Failures are ignored — the real import
  // inside encodeMp3 retries. See audio-export.md REQ-7.
  const warmMp3 = () => void import('./vendor/lamejs').catch(() => {});
  // The onboarding body (tour + info badges + ~54 kB of help copy) is behind the
  // same kind of split, and help is exactly what a user reaches for when they
  // are stuck — including offline, on a revisit. Warming it also means the
  // first-visit tour is never still fetching when its 350 ms auto-launch fires.
  // pwa-install.md REQ-6, runtime-performance.md REQ-1.
  const warmOnboarding = () => void import('./ui/onboarding/onboarding-impl').catch(() => {});
  // The About card is the door those live behind — the app's single help
  // surface (onboarding.md REQ-20) — and warming the room but not the door left
  // the ? button dead offline, doing nothing at all. Same split, same warm.
  // onboarding.md REQ-24, pwa-install.md REQ-6.
  const warmAbout = () => void import('./ui/components/about-modal').catch(() => {});
  const warm = () => {
    warmMp3();
    warmOnboarding();
    warmAbout();
  };
  // requestIdleCallback only reached Safari in 17.4, and we target installed
  // iOS PWAs — fall back to a plain timeout. (A `'x' in window` guard would
  // narrow `window` itself to `never` in the else branch; probe the function.)
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(warm);
  else window.setTimeout(warm, 2000);
}

/**
 * Repopulate the sampler slots from the persisted clip store
 * (sample-persistence.md REQ-5..REQ-7). Returns the clips that actually landed,
 * so the autosaver can seed its identity table with them.
 *
 * Clips only make sense next to the session that named them: with no restored
 * session the whole store is orphaned and dropped, and within one, a clip whose
 * slot the session does not name is dropped too — keeping the invariant that a
 * named slot is either loaded or shows `.needs-reload`.
 */
async function restoreSamplerClips(
  engine: Engine,
  hasSession: boolean,
  clipsPromise: Promise<StoredClip[]>,
): Promise<StoredClip[]> {
  if (!hasSession) {
    void SampleAutosave.clear();
    return [];
  }
  const restored: StoredClip[] = [];
  // Sequentially, like the project-zip import: 8 × multi-MB decodes at once
  // is a needless memory spike (project-export.md REQ-8).
  for (const clip of await clipsPromise) {
    if (engine.patterns.sampleNames[clip.slot] == null) {
      void SampleAutosave.drop(clip.slot);
      continue;
    }
    try {
      // .slice() is mandatory: decodeAudioData detaches the buffer it is given
      // (the same gotcha as the zip import).
      engine.sampler.setBuffer(clip.slot, await engine.ctx.decodeAudioData(clip.data.slice().buffer));
      restored.push(clip);
    } catch {
      // Undecodable clip: skip it — the slot keeps its .needs-reload hint.
    }
  }
  return restored;
}

/** "Tap to start" shown as a modal layover the synth (same as About etc.). */
function showStartModal(engine: Engine, onboarding: Onboarding, onStart: () => void): void {
  const backdrop = document.createElement('div');
  backdrop.className = `${Modal.backdropClass} start-backdrop`;

  const card = document.createElement('div');
  card.className = `${Modal.cardClass} start-card`;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Start VAST G1-J8');

  // The first thing anyone sees, so it shows the real faceplate (brand.md).
  // `.start-card` centres it — the block itself has no alignment (REQ-4).
  const brand = createBrand();

  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'start-btn';
  startBtn.textContent = 'Tap to start';

  let started = false;
  const start = async () => {
    if (started) return;
    started = true;
    startBtn.removeEventListener('click', start);
    await engine.resume(); // invoked within the gesture → unlocks audio
    onStart(); // e.g. initMIDI — any permission prompt follows the gesture
    backdrop.classList.add('hidden');
    setTimeout(() => backdrop.remove(), 300);
    // First-visit only: launch the guided tour once the start modal is gone and
    // audio is unlocked (so the interactive "press a key" step makes sound).
    if (onboarding.shouldAutoLaunch()) {
      setTimeout(() => onboarding.startTour(), 350);
    }
  };
  startBtn.addEventListener('click', start);

  card.appendChild(brand);
  card.appendChild(startBtn);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  startBtn.focus();
}

/**
 * Fetch a `#songUrl=` target, but only with the user's say-so
 * (song-share-link.md REQ-7, untrusted-input.md REQ-7).
 *
 * Without consent, one link made any visitor's browser issue an attacker-chosen
 * GET the moment the page loaded — a beacon, or a probe of the visitor's own
 * LAN. `parseSongLink` already restricts the scheme to `https:`; this adds the
 * gate and the request hardening. Resolves `null` when the user declines.
 */
async function fetchSharedSong(url: string): Promise<Uint8Array | null> {
  const origin = new URL(url).origin;
  const ok = await confirmDialog({
    title: 'Load a song from the web?',
    message: `This link asks to download a song from ${origin}.`,
    detail: 'That site will see your IP address. Only continue if you trust whoever sent you the link.',
    confirmLabel: 'Download song',
  });
  if (!ok) return null;

  const resp = await fetch(url, {
    // No ambient credentials, no following a redirect somewhere else, and a
    // bounded wait — a hostile or merely dead host must not hang boot.
    credentials: 'omit',
    redirect: 'error',
    mode: 'cors',
    signal: AbortSignal.timeout(SONG_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`The download failed (HTTP ${resp.status}).`);

  // Refuse an oversized body before buffering it. `Content-Length` is advisory —
  // a hostile server can omit it — so the post-read length is checked too, and
  // a zip inside is capped again by the zip reader.
  const declared = Number(resp.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_SONG_JSON_BYTES) {
    throw new Error(`That song is larger than the ${MAX_SONG_JSON_BYTES} byte limit.`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.length > MAX_SONG_JSON_BYTES) {
    throw new Error(`That song is larger than the ${MAX_SONG_JSON_BYTES} byte limit.`);
  }
  return bytes;
}

boot().catch((err) => {
  console.error(err);
  // Deliberately the native alert(): this is the failure path for boot ITSELF,
  // so the app's own dialog component may be exactly what did not come up.
  alert('WebSynth failed to start: ' + (err as Error).message);
});
