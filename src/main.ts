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
  const { latencyHint, voiceCount, scheduleAheadS, reverbIrMaxS, fxOversample, analyserFftSize } =
    PERF_PROFILES[resolveTier()];
  const engine = new Engine(bus, { latencyHint, voiceCount, scheduleAheadS, reverbIrMaxS, fxOversample, analyserFftSize });
  await engine.init();

  // The selector reflects the active sound; a patch edit flips it to dirty.
  const session = new PresetSession();
  bus.onChange((id) => { if (isPatchParam(id)) session.markDirty(); });

  // XY Pad axis assignment — pure state, persisted in songs (SongFile v3). Lives
  // outside the Engine (assignment survives while the pad window is closed), so
  // it is threaded to the UI alongside the PresetSession.
  const xy = new XyPadStore();

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
