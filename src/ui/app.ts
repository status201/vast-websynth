import type { StudioApi } from './studio-api';
import type { ParamBus } from '../state/params';
import type { PresetSession } from '../state/preset-session';
import type { XyPadStore } from '../state/xy-pad';
import type { UiBridge } from './ui-bridge';
import { WAVE_LABELS, LFO_DEST_LABELS, VOICING_LABELS, GLIDE_MODE_LABELS } from '../state/params';
import { Knob } from './components/knob';
import { Switch } from './components/switch';
import { Segmented } from './components/segmented';
import { WAVE_ICONS } from './components/wave-icons';
import { ParamDropdown } from './components/param-dropdown';
import { createCollapseToggle } from './components/collapse-toggle';
import { Strip } from './components/strip';
import { Scope } from './components/scope';
import { Keyboard } from './components/keyboard';
import { TabContainer } from './components/tabs';
import { Dropdown } from './components/dropdown';
import { createButton, setButtonLabel } from './components/button';
import { promptDialog } from './components/dialog';
import switchStyles from './styles/switch.module.css';
import { createAboutButton } from './components/about';
import { createHelpButton } from './components/help';
import { createPerfSettingsButton } from './components/perf-settings';
import { createFullscreenButton } from './components/fullscreen-button';
import { PERF_PROFILES, resolveTier, type PerfTier } from '../state/perf-mode';
import { createOnboarding, type Onboarding } from './onboarding';
import type { TourCtx } from './onboarding/tour';
import styles from './styles/layout.module.css';
import { Presets } from '../state/preset';
import { Song, DEMO_SONGS } from '../state/song';
import { buildArpPanel } from './panels/arp-panel';
import { buildSeqPanel } from './panels/seq-panel';
import { buildDrumPanel } from './panels/drum-panel';
import { buildSamplerPanel } from './panels/sampler-panel';
import { buildSongPanel } from './panels/song-panel';

/**
 * True on viewports where the faceplate no longer fits one screen (≤1280px).
 * FX + pattern tabs auto-collapse here so the keyboard is reachable without
 * scrolling; an explicit user toggle is remembered and overrides this.
 * Evaluated once at mount (no resize re-mount in this app).
 */
const isCompact = (): boolean => window.matchMedia('(max-width: 1280px)').matches;

/** True on phone-sized viewports — keyboard drops to 2 octaves so the keys
 *  stay large enough to play. */
const isPhone = (): boolean => window.matchMedia('(max-width: 767px)').matches;

export function mountApp(
  root: HTMLElement, engine: StudioApi, bus: ParamBus, bridge: UiBridge, session: PresetSession, xy: XyPadStore,
): Onboarding {
  root.innerHTML = '';

  // Late-bound hooks, filled once their panels are built; the tour calls them.
  let fxExpand: () => void = () => {};
  // Scope fps + analyser fftSize are applied live when the perf tier changes;
  // bound once buildBottom runs.
  let setScopeFps: (fps: number) => void = () => {};
  let setScopeFft: (fftSize: number) => void = () => {};
  // Apply both live scope knobs for a tier (perf-mode: fps + fftSize are live).
  const previewScopeTier = (tier: PerfTier): void => {
    setScopeFps(PERF_PROFILES[tier].fps);
    setScopeFft(PERF_PROFILES[tier].analyserFftSize);
  };
  // Default loads a demo without UI sync; replaced by the Song panel's own
  // loader (which also syncs the slot dropdown) once buildPatternRow runs.
  let songLoadDemo: (name: string) => void = (name) => {
    const file = DEMO_SONGS[name] ?? Object.values(DEMO_SONGS)[0];
    if (file) { Song.apply(file, bus, engine.patterns, engine.arrangement, xy); session.setActive(file.name); }
  };

  // Runtime hooks for the tour. `bridge.toggleTransport` is set inside
  // buildHeader (runs before any tour starts), so reading it lazily is safe.
  const ctx: TourCtx = {
    bus,
    engine,
    toggleTransport: () => bridge.toggleTransport(),
    applyDemo: (name) => songLoadDemo(name),
    resumeAudio: () => engine.resume(),
    expandFx: () => fxExpand(),
  };
  const onboarding = createOnboarding(ctx);

  root.appendChild(buildHeader(engine, bus, bridge, onboarding, session, previewScopeTier));
  root.appendChild(buildMain(bus));
  const fx = buildFx(bus);
  fxExpand = fx.expand;
  root.appendChild(fx.el);
  const patternRow = buildPatternRow(engine, bus, session, xy);
  songLoadDemo = patternRow.loadDemo;
  // OS-launched song files (installed-PWA file_handlers) flow through the
  // same import path as the Song panel's Import button (pwa-install.md REQ-7).
  bridge.importSongBytes = patternRow.importSongBytes;
  root.appendChild(patternRow.el);
  const bottom = buildBottom(engine, bus, bridge);
  setScopeFps = (fps) => bottom.scope.setFps(fps);
  setScopeFft = (fftSize) => bottom.scope.setFftSize(fftSize);
  root.appendChild(bottom.el);

  return onboarding;
}

function panel(title: string, build: (body: HTMLElement) => void, helpId?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = styles.panel!;
  const t = document.createElement('div');
  t.className = styles.panelTitle!;
  t.textContent = title;
  if (helpId) t.dataset.help = helpId;
  el.appendChild(t);
  const body = document.createElement('div');
  body.className = styles.panelBody!;
  build(body);
  el.appendChild(body);
  return el;
}

function buildHeader(
  engine: StudioApi, bus: ParamBus, bridge: UiBridge, onboarding: Onboarding, session: PresetSession,
  previewScopeTier: (tier: PerfTier) => void,
): HTMLElement {
  const el = document.createElement('div');
  el.className = styles.header!;
  el.dataset.testid = 'app-header';

  // Brand block: VAST G1-J5 / Vast Audio Synthesis Technology
  const brand = document.createElement('div');
  brand.className = styles.brand!;
  const brandRow = document.createElement('div');
  brandRow.className = styles.brandRow!;
  const brandName = document.createElement('span');
  brandName.className = styles.brandName!;
  brandName.textContent = 'VAST';
  const brandModel = document.createElement('span');
  brandModel.className = styles.brandModel!;
  brandModel.textContent = 'G1-J5';
  brandRow.appendChild(brandName);
  brandRow.appendChild(brandModel);
  const brandTag = document.createElement('div');
  brandTag.className = styles.brandTagline!;
  brandTag.textContent = 'Vast Audio Synthesis Technology';
  brand.appendChild(brandRow);
  brand.appendChild(brandTag);
  el.appendChild(brand);

  // Below 720px the preset cluster collapses behind this hamburger to keep the
  // sticky header compact; CSS parks it top-right and expands the cluster inline
  // while `.menuOpen` is set (see specs/features/responsive-header.md).
  const menuToggle = createButton({
    label: '☰',
    testId: 'header-menu',
    className: `${switchStyles.root!} ${styles.menuToggle!}`,
    onClick: () => {
      const open = el.classList.toggle(styles.menuOpen!);
      menuToggle.setAttribute('aria-expanded', String(open));
    },
  });
  menuToggle.setAttribute('aria-label', 'Toggle preset menu');
  menuToggle.setAttribute('aria-expanded', 'false');
  el.appendChild(menuToggle);

  const presetGroup = document.createElement('div');
  presetGroup.className = `${styles.headerGroup!} ${styles.presetGroup!}`;

  const dropdown = new Dropdown(Presets.list(), Presets.list()[0] ?? '');
  dropdown.el.dataset.testid = 'preset-select';
  // The selector mirrors the active sound (preset/song name + dirty marker).
  session.subscribe(() => dropdown.setValue(session.display));
  dropdown.onChange((name) => {
    const p = Presets.load(name);
    if (p) Presets.apply(bus, p);
    session.setActive(name);
  });

  const saveBtn = createButton({
    label: 'Save',
    testId: 'preset-save',
    onClick: async () => {
      const name = await promptDialog({
        title: 'Save preset',
        message: 'Preset name:',
        defaultValue: session.label,
        confirmLabel: 'Save',
      });
      if (!name) return;
      const snap = Presets.capture(bus);
      Presets.save(name, snap);
      // The saved patch becomes the new double-tap reset target.
      bus.setBaselines(snap);
      dropdown.setOptions(Presets.list());
      session.setActive(name);
    },
  });

  const presetLabel = document.createElement('span');
  presetLabel.textContent = 'Preset:';
  presetGroup.appendChild(presetLabel);
  presetGroup.appendChild(dropdown.el);
  presetGroup.appendChild(saveBtn);
  presetGroup.appendChild(
    createPerfSettingsButton({ onTierPreview: previewScopeTier }),
  );
  // Absent (null) where the Fullscreen API is missing — iPhone Safari.
  const fullscreenBtn = createFullscreenButton();
  if (fullscreenBtn) presetGroup.appendChild(fullscreenBtn);
  presetGroup.appendChild(createAboutButton(engine));
  presetGroup.appendChild(
    createHelpButton({
      startTour: onboarding.startTour,
      toggleHelpMode: onboarding.toggleHelpMode,
      isHelpModeActive: onboarding.isHelpModeActive,
      onHelpModeChange: onboarding.onHelpModeChange,
    }),
  );
  el.appendChild(presetGroup);

  const spacer = document.createElement('div');
  spacer.className = styles.headerSpacer!;
  el.appendChild(spacer);

  // Transport group
  const transport = document.createElement('div');
  transport.className = `${styles.headerGroup!} ${styles.transportGroup!}`;

  const playBtn = createButton({
    label: 'Play',
    className: `${switchStyles.root!} ${styles.playBtn!}`,
    led: true,
    testId: 'transport-play',
    onClick: () => {
      engine.clock.toggle();
      syncPlay();
    },
  });
  // Reflect the clock state so Panic/Esc (which stop the transport
  // directly) and the Space-bar shortcut all keep the button in sync.
  const syncPlay = () => {
    const playing = engine.clock.playing;
    playBtn.classList.toggle('on', playing); // keeps `on` global state class for :global(.on) selectors in CSS

    setButtonLabel(playBtn, playing ? 'Stop' : 'Play');
  };
  engine.clock.onStart(syncPlay);
  engine.clock.onStop(syncPlay);

  // --- Play-button LED blink ---
  let blinkVisible = true;

  const setBlink = (v: boolean) => {
    blinkVisible = v;
    playBtn.classList.toggle('blink', !v);
  };

  engine.clock.onTick((step) => {
    const nb = (step & 3) < 2;
    if (nb !== blinkVisible) setBlink(nb);
  });

  engine.clock.onStart(() => setBlink(true));
  engine.clock.onStop(() => setBlink(true));

  bridge.toggleTransport = () => playBtn.click();
  transport.appendChild(playBtn);
  // Capture the BPM knob so it can dim + refuse input while slaved — the tempo
  // is then driven by the sync master (midi-clock-sync REQ-14).
  const bpmKnob = new Knob({ bus, paramId: 'transport.bpm', label: 'BPM' });
  const applySlaved = (mode: string): void => {
    const slaved = mode === 'slave';
    bpmKnob.setDisabled(slaved);
    bpmKnob.el.title = slaved ? 'Tempo follows the sync master while slaved' : '';
  };
  applySlaved(engine.sync.mode);
  engine.sync.onStatus((s) => applySlaved(s.mode));
  transport.appendChild(bpmKnob.el);
  transport.appendChild(new Knob({ bus, paramId: 'transport.swing', label: 'SWING' }).el);

  el.appendChild(transport);

  const right = document.createElement('div');
  right.className = styles.headerGroup!;

  const voicing = new Segmented(bus, 'voicing.mode', VOICING_LABELS);
  right.appendChild(voicing.el);

  const panicBtn = createButton({ label: 'Panic', testId: 'panic', onClick: () => engine.panic() });
  right.appendChild(panicBtn);

  const masterKnob = new Knob({ bus, paramId: 'master.volume', label: 'VOL' });
  right.appendChild(masterKnob.el);

  el.appendChild(right);

  return el;
}

function buildPatternRow(
  engine: StudioApi, bus: ParamBus, session: PresetSession, xy: XyPadStore,
): {
  el: HTMLElement;
  loadDemo: (name: string) => void;
  importSongBytes: (bytes: Uint8Array, name: string) => Promise<void>;
} {
  const song = buildSongPanel(bus, engine, session, xy);
  const tabs = new TabContainer([
    { id: 'arp', label: 'Arpeggiator', content: buildArpPanel(bus) },
    { id: 'seq', label: 'Sequencer', content: buildSeqPanel(bus, engine) },
    { id: 'drums', label: 'Drum Machine', content: buildDrumPanel(bus, engine) },
    { id: 'sampler', label: 'Sampler', content: buildSamplerPanel(bus, engine) },
    { id: 'song', label: 'Song', content: song.el },
  ], 'arp', {
    collapsibleStoreKey: 'websynth.ui.collapsed.pattern',
    collapsedByDefault: isCompact,
  });
  tabs.el.classList.add(styles.patternRow!);
  tabs.el.dataset.testid = 'pattern-row';
  return { el: tabs.el, loadDemo: song.loadDemo, importSongBytes: song.importBytes };
}

function buildMain(bus: ParamBus): HTMLElement {
  const main = document.createElement('div');
  main.className = styles.main!;

  main.appendChild(panel('OSC 1', (b) => {
    b.appendChild(new Segmented(bus, 'osc1.wave', WAVE_LABELS, WAVE_ICONS).el);
    b.appendChild(row([
      new Knob({ bus, paramId: 'osc1.octave', label: 'OCT' }).el,
      new Knob({ bus, paramId: 'osc1.detune', label: 'TUNE' }).el,
      new Knob({ bus, paramId: 'osc1.level', label: 'LEVEL' }).el,
    ]));
  }, 'oscillators'));

  main.appendChild(panel('OSC 2', (b) => {
    b.appendChild(new Segmented(bus, 'osc2.wave', WAVE_LABELS, WAVE_ICONS).el);
    b.appendChild(row([
      new Knob({ bus, paramId: 'osc2.octave', label: 'OCT' }).el,
      new Knob({ bus, paramId: 'osc2.detune', label: 'TUNE' }).el,
      new Knob({ bus, paramId: 'osc2.level', label: 'LEVEL' }).el,
    ]));
  }));

  main.appendChild(panel('SUB / UNI', (b) => {
    b.appendChild(new Segmented(bus, 'sub.wave', WAVE_LABELS, WAVE_ICONS).el);
    b.appendChild(row([
      new Knob({ bus, paramId: 'sub.octave', label: 'S.OCT' }).el,
      new Knob({ bus, paramId: 'sub.level', label: 'S.LVL' }).el,
    ]));
    b.appendChild(row([
      new Knob({ bus, paramId: 'unison.voices', label: 'UNISON' }).el,
      new Knob({ bus, paramId: 'unison.detune', label: 'SPREAD' }).el,
    ]));
  }, 'subuni'));

  main.appendChild(panel('MIXER', (b) => {
    b.appendChild(row([
      new Knob({ bus, paramId: 'mixer.noise', label: 'NOISE' }).el,
      new Knob({ bus, paramId: 'mixer.glide', label: 'GLIDE' }).el,
      new Knob({ bus, paramId: 'analog.drift', label: 'DRIFT' }).el,
    ]));
    b.appendChild(new Segmented(bus, 'glide.mode', GLIDE_MODE_LABELS).el);
  }, 'mixer'));

  main.appendChild(panel('FILTER', (b) => {
    b.appendChild(row([
      new Knob({ bus, paramId: 'filter.cutoff', label: 'CUTOFF' }).el,
      new Knob({ bus, paramId: 'filter.resonance', label: 'RESO' }).el,
    ]));
    b.appendChild(row([
      new Knob({ bus, paramId: 'filter.drive', label: 'DRIVE' }).el,
      new Knob({ bus, paramId: 'filter.envAmount', label: 'ENV' }).el,
    ]));
  }, 'filter'));

  main.appendChild(panel('AMP ENV', (b) => {
    b.appendChild(row([
      new Knob({ bus, paramId: 'env.amp.attack', label: 'A' }).el,
      new Knob({ bus, paramId: 'env.amp.decay', label: 'D' }).el,
      new Knob({ bus, paramId: 'env.amp.sustain', label: 'S' }).el,
      new Knob({ bus, paramId: 'env.amp.release', label: 'R' }).el,
    ]));
  }, 'ampenv'));

  main.appendChild(panel('FILTER ENV', (b) => {
    b.appendChild(row([
      new Knob({ bus, paramId: 'env.fil.attack', label: 'A' }).el,
      new Knob({ bus, paramId: 'env.fil.decay', label: 'D' }).el,
      new Knob({ bus, paramId: 'env.fil.sustain', label: 'S' }).el,
      new Knob({ bus, paramId: 'env.fil.release', label: 'R' }).el,
    ]));
  }, 'filterenv'));

  main.appendChild(panel('LFO', (b) => {
    b.appendChild(new Segmented(bus, 'lfo.wave', WAVE_LABELS, WAVE_ICONS).el);
    b.appendChild(row([
      new Knob({ bus, paramId: 'lfo.rate', label: 'RATE' }).el,
      new Knob({ bus, paramId: 'lfo.amount', label: 'AMT' }).el,
    ]));
    b.appendChild(new ParamDropdown(bus, 'lfo.dest', LFO_DEST_LABELS).el);
  }, 'lfo'));

  return main;
}

function buildFx(bus: ParamBus): { el: HTMLElement; expand: () => void } {
  const section = document.createElement('div');
  section.className = styles.fxSection!;
  section.dataset.testid = 'fx';

  const bar = document.createElement('div');
  bar.className = styles.fxSectionBar!;
  const title = document.createElement('div');
  title.className = styles.fxSectionTitle!;
  title.textContent = 'FX';
  bar.appendChild(title);
  const collapse = createCollapseToggle(section, 'websynth.ui.collapsed.fx', {
    defaultCollapsed: isCompact,
    trigger: bar, // whole FX bar toggles, not just the chevron
  });
  bar.appendChild(collapse.el);
  section.appendChild(bar);

  const fx = document.createElement('div');
  fx.className = styles.fxRow!;

  fx.appendChild(fxPanel('Distortion', bus, 'fx.dist.on', [
    { id: 'fx.dist.drive', label: 'DRIVE' },
    { id: 'fx.dist.tone', label: 'TONE' },
    { id: 'fx.dist.mix', label: 'MIX' },
  ], 'fx.dist'));

  fx.appendChild(fxPanel('Wah', bus, 'fx.wah.on', [
    { id: 'fx.wah.rate', label: 'RATE' },
    { id: 'fx.wah.depth', label: 'DEPTH' },
    { id: 'fx.wah.q', label: 'Q' },
  ], 'fx.wah'));

  fx.appendChild(fxPanel('Phaser', bus, 'fx.phaser.on', [
    { id: 'fx.phaser.rate', label: 'RATE' },
    { id: 'fx.phaser.depth', label: 'DEPTH' },
    { id: 'fx.phaser.feedback', label: 'FB' },
    { id: 'fx.phaser.mix', label: 'MIX' },
  ], 'fx.phaser'));

  fx.appendChild(fxPanel('Delay', bus, 'fx.delay.on', [
    { id: 'fx.delay.time', label: 'TIME' },
    { id: 'fx.delay.feedback', label: 'FB' },
    { id: 'fx.delay.mix', label: 'MIX' },
  ], 'fx.delay'));

  fx.appendChild(fxPanel('Reverb', bus, 'fx.reverb.on', [
    { id: 'fx.reverb.size', label: 'SIZE' },
    { id: 'fx.reverb.damp', label: 'DAMP' },
    { id: 'fx.reverb.mix', label: 'MIX' },
  ], 'fx.reverb'));

  section.appendChild(fx);
  return { el: section, expand: collapse.expand };
}

function fxPanel(
  title: string,
  bus: ParamBus,
  onParam: string,
  knobs: Array<{ id: string; label: string }>,
  helpId: string,
): HTMLElement {
  const el = document.createElement('div');
  el.className = styles.fxPanel!;

  const header = document.createElement('div');
  header.className = styles.fxHeader!;
  const t = document.createElement('div');
  t.className = styles.fxTitle!;
  t.textContent = title;
  t.dataset.help = helpId;
  header.appendChild(t);
  header.appendChild(new Switch(bus, onParam, 'on').el);
  el.appendChild(header);

  const knobsEl = document.createElement('div');
  knobsEl.className = styles.fxKnobs!;
  for (const k of knobs) {
    knobsEl.appendChild(new Knob({ bus, paramId: k.id, label: k.label }).el);
  }
  el.appendChild(knobsEl);

  return el;
}

function buildBottom(engine: StudioApi, bus: ParamBus, bridge: UiBridge): { el: HTMLElement; scope: Scope } {
  const bottom = document.createElement('div');
  bottom.className = styles.bottom!;

  const top = document.createElement('div');
  top.className = styles.bottomTop!;

  const wheels = document.createElement('div');
  wheels.className = styles.wheels!;
  wheels.appendChild(new Strip({ bus, paramId: 'master.pitchBend', label: 'PITCH', springBack: true }).el);
  wheels.appendChild(new Strip({ bus, paramId: 'keyboard.transpose', label: 'OCT' }).el);
  wheels.appendChild(new Strip({ bus, paramId: 'master.modWheel', label: 'MOD' }).el);
  top.appendChild(wheels);

  const scopeWrap = document.createElement('div');
  scopeWrap.className = styles.scopeWrap!;
  // Static CRT screen underlay (gradient + inset vignette) behind the transparent
  // canvas, so the 60fps redraw never re-rasters the decoration. (scope REQ-16)
  const scopeScreen = document.createElement('div');
  scopeScreen.className = styles.scopeScreen!;
  scopeWrap.appendChild(scopeScreen);
  const scope = new Scope(
    { mono: engine.analyser, left: engine.analyserL, right: engine.analyserR },
    { fps: PERF_PROFILES[resolveTier()].fps },
  );
  scopeWrap.appendChild(scope.el);
  const toggle = document.createElement('button');
  toggle.className = `${switchStyles.root!} ${styles.scopeToggle!}`;
  toggle.dataset.testid = 'scope-toggle';
  toggle.textContent = 'Wave';
  let isWave = true;
  toggle.addEventListener('click', () => {
    isWave = !isWave;
    scope.setMode(isWave ? 'wave' : 'spectrum');
    toggle.textContent = isWave ? 'Wave' : 'Spectrum';
  });
  scopeWrap.appendChild(toggle);
  // Mono/Stereo toggle — orthogonal to Wave/Spectrum. Defaults to Mono.
  const chanToggle = document.createElement('button');
  chanToggle.className = `${switchStyles.root!} ${styles.scopeChannelsToggle!}`;
  chanToggle.dataset.testid = 'scope-channels-toggle';
  chanToggle.textContent = 'Mono';
  let isStereo = false;
  chanToggle.addEventListener('click', () => {
    isStereo = !isStereo;
    scope.setChannels(isStereo ? 'stereo' : 'mono');
    chanToggle.textContent = isStereo ? 'Stereo' : 'Mono';
  });
  scopeWrap.appendChild(chanToggle);
  top.appendChild(scopeWrap);

  bottom.appendChild(top);

  const kbWrap = document.createElement('div');
  kbWrap.className = styles.keyboardWrap!;
  kbWrap.dataset.testid = 'keyboard';
  // Phones get 2 octaves (centred higher) so individual keys stay tappable;
  // wider screens keep the full 3-octave C3–C6 range.
  const phone = isPhone();
  const keyboard = new Keyboard({
    bus,
    startOctave: phone ? 4 : 3,
    octaves: phone ? 2 : 3,
  });
  kbWrap.appendChild(keyboard.el);
  bottom.appendChild(kbWrap);

  // Visual-only: reflect computer-keyboard input on the on-screen keys. The note
  // itself is fired once by installShortcuts (bus.noteOn); highlighting here must
  // not also touch the bus or a single key double-fires. See input-control.md REQ-2.
  bridge.pressKey = (n) => keyboard.highlight(n, true);
  bridge.releaseKey = (n) => keyboard.highlight(n, false);

  // Light up the on-screen keys in time with the sequencer. The clock
  // schedules ~100 ms ahead, so defer each highlight to its audible moment.
  const seqTimers = new Set<number>();
  const at = (t: number, fn: () => void) => {
    const ms = Math.max(0, (t - engine.ctx.currentTime) * 1000);
    const id = window.setTimeout(() => { seqTimers.delete(id); fn(); }, ms);
    seqTimers.add(id);
  };
  engine.seq.onNote((note, when, releaseAt) => {
    at(when, () => keyboard.seqHighlight(note, true));
    at(releaseAt, () => keyboard.seqHighlight(note, false));
  });
  engine.clock.onStop(() => {
    for (const id of seqTimers) clearTimeout(id);
    seqTimers.clear();
    keyboard.clearSeqHighlights();
  });

  return { el: bottom, scope };
}

function row(children: HTMLElement[]): HTMLElement {
  const r = document.createElement('div');
  r.className = styles.panelRow!;
  for (const c of children) r.appendChild(c);
  return r;
}
