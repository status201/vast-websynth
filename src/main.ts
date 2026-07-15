import { Engine } from './audio/engine';
import { ParamBus } from './state/params';
import { PERF_PROFILES, resolveTier } from './state/perf-mode';
import { mountApp } from './ui/app';
import { installShortcuts } from './ui/shortcuts';
import { initMIDI } from './audio/midi';
import { Presets } from './state/preset';
import { PresetSession, isPatchParam } from './state/preset-session';
import { XyPadStore } from './state/xy-pad';
import { UiBridge } from './ui/ui-bridge';
import { parseSongLink, decodeSongPayload } from './state/song-link';
import { Modal } from './ui/components/modal';
import { WakeLockManager } from './utils/wake-lock';
import type { Onboarding } from './ui/onboarding';

// Injected by Vite's `define` (vite.config.ts) — same precedent as about.ts.
declare const __APP_VERSION__: string;

async function boot() {
  // Build the synth and mount the full UI immediately. The AudioContext is
  // created suspended (no sound until a gesture), so everything can render
  // behind the start modal — audio is unlocked when the user taps it.
  const bus = new ParamBus();
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

  const bridge = new UiBridge();
  const onboarding = mountApp(document.getElementById('app')!, engine, bus, bridge, session, xy);
  installShortcuts(engine, bus, bridge);

  // Keep the display awake exactly while the synth can make sound: the wake
  // lock follows the AudioContext state (running from the Tap-to-start resume;
  // suspended/interrupted releases it). Platform concern, so it lives here and
  // not in Engine (pwa-install.md REQ-1).
  const wake = new WakeLockManager();
  engine.ctx.addEventListener('statechange', () => {
    if (engine.ctx.state === 'running') wake.enable();
    else wake.disable();
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
  // so parse errors surface in the normal import dialog. Applying is pure
  // state, so it works behind the start modal — like launchQueue above. The
  // hash is consumed only on success (REQ-4), so a bad link stays visible in
  // the address bar for the user to inspect/copy.
  const link = parseSongLink(window.location.hash);
  if (link) {
    void (async () => {
      try {
        let bytes: Uint8Array;
        let name = 'shared-song.json';
        if (link.kind === 'data') {
          bytes = new TextEncoder().encode(await decodeSongPayload(link.payload));
        } else {
          const resp = await fetch(link.url);
          if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
          bytes = new Uint8Array(await resp.arrayBuffer());
          // Keep the URL's filename tail so a .zip project routes through the
          // magic-byte sniff with its extension fallback intact.
          name = link.url.replace(/[?#].*$/, '').replace(/^.*\//, '') || name;
        }
        const ok = await bridge.importSongBytes(bytes, name);
        if (ok) history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch (e) {
        alert('Could not load the shared song: ' + (e as Error).message);
      }
    })();
  }

  // MIDI is initialized from the start gesture, not at boot: Chrome ≥124
  // gates all Web MIDI behind a permission prompt, and prompting on page
  // load (behind the start modal) is hostile to MIDI-less visitors.
  showStartModal(engine, onboarding, () => { void initMIDI(engine, bus); });

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
}

/** "Tap to start" shown as a modal layover the synth (same as About etc.). */
function showStartModal(engine: Engine, onboarding: Onboarding, onStart: () => void): void {
  const backdrop = document.createElement('div');
  backdrop.className = `${Modal.backdropClass} start-backdrop`;

  const card = document.createElement('div');
  card.className = `${Modal.cardClass} start-card`;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Start VAST G1-J5');

  const title = document.createElement('div');
  title.className = Modal.titleClass;
  title.textContent = 'VAST G1-J5';

  const tag = document.createElement('div');
  tag.className = Modal.tagClass;
  tag.textContent = 'Vast Audio Synthesis Technology';

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

  card.appendChild(title);
  card.appendChild(tag);
  card.appendChild(startBtn);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  startBtn.focus();
}

boot().catch((err) => {
  console.error(err);
  alert('WebSynth failed to start: ' + (err as Error).message);
});
