import { Engine } from './audio/engine';
import { ParamBus } from './state/params';
import { PERF_PROFILES, resolveTier } from './state/perf-mode';
import { mountApp } from './ui/app';
import { installShortcuts } from './ui/shortcuts';
import { initMIDI } from './audio/midi';
import { Presets } from './state/preset';
import { PresetSession, isPatchParam } from './state/preset-session';
import { UiBridge } from './ui/ui-bridge';
import { Modal } from './ui/components/modal';
import type { Onboarding } from './ui/onboarding';

async function boot() {
  // Build the synth and mount the full UI immediately. The AudioContext is
  // created suspended (no sound until a gesture), so everything can render
  // behind the start modal — audio is unlocked when the user taps it.
  const bus = new ParamBus();
  // Performance mode (device-aware, persisted outside the bus) trades a little
  // latency/polyphony/FX cost for a glitch-resistant graph on weak hardware.
  // The audio fields are read once here because they are fixed when the
  // AudioContext/graph are built (scope fps is applied live; see perf-mode.ts).
  const { latencyHint, voiceCount, scheduleAheadS, reverbIrMaxS, fxOversample } =
    PERF_PROFILES[resolveTier()];
  const engine = new Engine(bus, { latencyHint, voiceCount, scheduleAheadS, reverbIrMaxS, fxOversample });
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
  const onboarding = mountApp(document.getElementById('app')!, engine, bus, bridge, session);
  installShortcuts(engine, bus, bridge);
  initMIDI(engine, bus);

  // Dev-only debug bridge for E2E tests (Playwright drives the dev server, so
  // import.meta.env.DEV is true there). Lets specs read/drive state directly —
  // e.g. window.__synth.bus.get('filter.cutoff'). Absent in production builds.
  if (import.meta.env.DEV) {
    (window as unknown as { __synth?: unknown }).__synth = {
      engine,
      bus,
      patterns: engine.patterns,
      session,
    };
  }

  showStartModal(engine, onboarding);
}

/** "Tap to start" shown as a modal layover the synth (same as About etc.). */
function showStartModal(engine: Engine, onboarding: Onboarding): void {
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
