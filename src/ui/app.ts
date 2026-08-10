import type { StudioApi } from './studio-api';
import type { ParamBus } from '../state/params';
import type { PresetSession } from '../state/preset-session';
import type { XyPadStore } from '../state/xy-pad';
import type { PatternUndo, UndoMachine } from '../state/pattern-undo';
import type { UiBridge } from './ui-bridge';
import type { SyncStatus } from '../audio/transport/sync/sync-types';
import {
  WAVE_LABELS, LFO_DEST_LABELS, LFO_SYNC_LABELS, VOICING_LABELS, GLIDE_MODE_LABELS,
  FILTER_MODEL_LABELS,
} from '../state/params';
import { Knob } from './components/knob';
import { Switch } from './components/switch';
import { Segmented } from './components/segmented';
import { WAVE_ICONS } from './components/wave-icons';
import { HEADER_ICONS } from './components/header-icons';
import { fxPatchDecoration } from './components/fx-patch-decoration';
import { ParamDropdown } from './components/param-dropdown';
import { createCollapseToggle } from './components/collapse-toggle';
import { Strip } from './components/strip';
import { Scope } from './components/scope';
import { Keyboard } from './components/keyboard';
import { TabContainer } from './components/tabs';
import {
  ARP_TAB, MACHINE_IDS, MACHINE_TAB,
  readArpStatus, readMachineStatus, subscribeArpStatus, subscribeMachineStatus,
} from './machine-status';
import { Dropdown } from './components/dropdown';
import { createButton, setButtonLabel } from './components/button';
import { openEmptyPlayModal, emptyPlayHintDismissed } from './components/empty-play-modal';
import { anythingToPlay } from '../audio/transport/anything-to-play';
import { PWM_RATE_MAX } from '../audio/pwm';
import switchStyles from './styles/switch.module.css';
import { createAboutButton } from './components/about';
import { createBrand } from './components/brand';
import { createInfoBadgesButton } from './components/info-badges-button';
import { createPerfSettingsButton } from './components/perf-settings';
import { createFullscreenButton } from './components/fullscreen-button';
import { PERF_PROFILES, resolveTier, type PerfTier } from '../state/perf-mode';
import { createOnboarding, type Onboarding } from './onboarding';
import type { TourCtx } from './onboarding/tour';
import styles from './styles/layout.module.css';
import { Presets } from '../state/preset';
import { openPresetManagerModal } from './components/preset-manager-modal';
import { Song, DEMO_SONGS, demoNames } from '../state/song';
import { buildArpPanel } from './panels/arp-panel';
import { buildSeqPanel } from './panels/seq-panel';
import { buildDrumPanel } from './panels/drum-panel';
import { buildSamplerPanel } from './panels/sampler-panel';
import type { MachinePanel } from './panels/step-panel-scaffold';
import { buildMotionPanel } from './panels/motion-panel';
import { buildSongPanel } from './panels/song-panel';
import { createXyPadWindowController } from './components/xy-pad-window';
import { createEffectiveXy } from '../state/xy-effective';

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
  patternUndo: PatternUndo,
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
  // Only the built-ins are reachable here — the drop-in and zip demos are
  // fetched on click and so are inherently async (song-mode.md REQ-11) — but
  // this fallback is replaced a few lines below and never actually used.
  // The real unknown-name fallback lives in `resolveDemoName` (REQ-12, v18),
  // which `SongPanel.loadDemo` applies to every caller including the tour.
  let songLoadDemo: (name: string) => Promise<void> = async (name) => {
    const file = DEMO_SONGS[name] ?? Object.values(DEMO_SONGS)[0];
    if (file) {
      Song.apply(file, bus, engine.patterns, engine.arrangement, xy, engine.sampler);
      session.setActive(file.name);
    }
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

  // The header's empty-play hint loads a demo through the same late-bound
  // loader the tour uses (rebound to the Song panel's dropdown-syncing loader
  // once buildPatternRow runs below).
  root.appendChild(buildHeader(
    engine, bus, bridge, onboarding, session, previewScopeTier,
    (name) => songLoadDemo(name),
  ));
  root.appendChild(buildMain(bus));
  const fx = buildFx(bus);
  fxExpand = fx.expand;
  root.appendChild(fx.el);
  const patternRow = buildPatternRow(engine, bus, session, xy, bridge, patternUndo);
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
  previewScopeTier: (tier: PerfTier) => void, loadDemo: (name: string) => Promise<void>,
): HTMLElement {
  const el = document.createElement('div');
  el.className = styles.header!;
  el.dataset.testid = 'app-header';

  // Brand block (brand.md) — shared with the About and start modals. Only the
  // divider rule to its right is the header's own (brand.md REQ-3).
  const brand = createBrand();
  brand.classList.add(styles.headerBrand!);
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

  // One door for everything you can do with a sound — save, export a preset or
  // a bank, import (presets.md REQ-9). The header stays a single button.
  const saveBtn = createButton({
    label: 'Presets — save, export, import',
    icon: HEADER_ICONS.save,
    title: 'Presets — save, export, import',
    testId: 'preset-save',
    onClick: () => openPresetManagerModal({
      bus,
      session,
      onPresetsChanged: () => dropdown.setOptions(Presets.list()),
    }),
  });

  // The paste door lives in the Song panel but preset imports belong to this
  // manager (and must refresh the dropdown above) — so they meet on the bridge
  // (paste-import.md REQ-7).
  bridge.openPresetImport = (parse) => openPresetManagerModal({
    bus,
    session,
    onPresetsChanged: () => dropdown.setOptions(Presets.list()),
    initialImport: parse,
  });

  const presetLabel = document.createElement('span');
  presetLabel.className = styles.presetLabel!;
  presetLabel.textContent = 'Preset:';
  presetGroup.appendChild(presetLabel);
  presetGroup.appendChild(dropdown.el);
  presetGroup.appendChild(saveBtn);
  // Inner spacer, active at the ≤1140px wrap step: keeps the dropdown + Save
  // left-aligned while pushing the utility icon buttons to the far right.
  const presetSpacer = document.createElement('div');
  presetSpacer.className = styles.presetSpacer!;
  presetGroup.appendChild(presetSpacer);
  presetGroup.appendChild(
    createPerfSettingsButton({ onTierPreview: previewScopeTier }),
  );
  // ⓘ then ? — one toggles the badges, the other opens Help & About, and each
  // does only that (onboarding.md REQ-8/REQ-20).
  presetGroup.appendChild(
    createInfoBadgesButton({
      toggle: onboarding.toggleInfoBadges,
      isActive: onboarding.isInfoBadgesActive,
      onChange: onboarding.onInfoBadgesChange,
    }),
  );
  presetGroup.appendChild(
    createAboutButton(engine, { startTour: onboarding.startTour }),
  );
  // The `?` key's route to the badges (input-control.md REQ-9) — here rather
  // than in shortcuts.ts, which must not import the onboarding layer.
  bridge.toggleInfoBadges = onboarding.toggleInfoBadges;
  // Last in the row; absent (null) where the Fullscreen API is missing — iPhone Safari.
  const fullscreenBtn = createFullscreenButton();
  if (fullscreenBtn) presetGroup.appendChild(fullscreenBtn);
  el.appendChild(presetGroup);

  const spacer = document.createElement('div');
  spacer.className = styles.headerSpacer!;
  el.appendChild(spacer);

  // Zero-height flex line break, active whenever the header wraps (≤1140px):
  // the transport cluster always starts the second row (voicing right-aligns
  // via auto margin), and below 720px the hamburger's auto margin owns row 1.
  const headerBreak = document.createElement('div');
  headerBreak.className = styles.headerBreak!;
  el.appendChild(headerBreak);

  // Transport group
  const transport = document.createElement('div');
  transport.className = `${styles.headerGroup!} ${styles.transportGroup!}`;

  const playBtn = createButton({
    label: 'Play',
    className: `${switchStyles.root!} ${styles.playBtn!}`,
    led: true,
    testId: 'transport-play',
    onClick: () => {
      // Starting an all-silent transport helps nobody — explain instead
      // (empty-play-hint.md REQ-1). Stops are never intercepted, nor is a
      // sync master/slave (an empty clock legitimately drives external gear).
      if (!engine.clock.playing
        && !emptyPlayHintDismissed()
        && engine.sync.activeMode === 'off'
        && !anythingToPlay((id) => bus.get(id), engine.patterns, engine.arrangement, engine.sampler.buffers)) {
        openEmptyPlayModal({
          // Awaited: all but the two built-in demos are fetched (song-mode.md
          // REQ-12), and the re-entry below re-runs the has-anything-to-play
          // check — clicking Play before the song lands just reopens this modal.
          onPlayDemo: async () => {
            const names = demoNames();
            await loadDemo(names[Math.floor(Math.random() * names.length)]!);
            playBtn.click(); // re-entry: the demo gives the check something to play
          },
        });
        return;
      }
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

  // --- Play-button LED blink (specs/features/play-button-blink.md) ---
  // Playing: red, blinking with the beat. Stopped: a slow orange "attract"
  // pulse so the transport is discoverable; loading a demo escalates it to a
  // fast green cue until playback starts.
  let blinkVisible = true;

  const setBlink = (v: boolean) => {
    blinkVisible = v;
    playBtn.classList.toggle('blink', !v);
  };

  engine.clock.onTick((step) => {
    const nb = (step & 3) < 2;
    if (nb !== blinkVisible) setBlink(nb);
  });

  let cueArmed = false;
  const refreshIdleBlink = () => {
    const stopped = !engine.clock.playing;
    playBtn.classList.toggle('attract', stopped && !cueArmed);
    playBtn.classList.toggle('cue', stopped && cueArmed);
  };
  engine.clock.onStart(() => { setBlink(true); cueArmed = false; refreshIdleBlink(); });
  engine.clock.onStop(() => { setBlink(true); refreshIdleBlink(); });
  bridge.cuePlay = () => {
    if (engine.clock.playing) return; // already audible — nothing to nudge
    cueArmed = true;
    refreshIdleBlink();
  };
  // Turning a step machine on is silent until Play, so it cues too (REQ-3).
  // Listening on the bus catches every surface (panel switch, song apply,
  // author-dialect auto-enable). The arp is excluded: it auto-starts the
  // transport on a held key, so there is no silent dead-end.
  for (const id of ['seq.on', 'drum.on', 'sampler.on']) {
    bus.subscribe(id, (v) => { if (v >= 0.5) bridge.cuePlay(); });
  }
  refreshIdleBlink();

  bridge.toggleTransport = () => playBtn.click();
  transport.appendChild(playBtn);
  // Capture the BPM knob so it can dim + refuse input while slaved — the tempo
  // is then driven by the sync master (midi-clock-sync REQ-14). Keyed on the
  // *running* role, so a selected-but-disconnected Slave leaves the knob live
  // instead of freezing it at a vanished master's tempo (REQ-19/REQ-22).
  const bpmKnob = new Knob({ bus, paramId: 'transport.bpm', label: 'BPM' });
  const applySlaved = (s: SyncStatus): void => {
    const slaved = s.activeMode === 'slave';
    bpmKnob.setDisabled(slaved);
    bpmKnob.el.title = slaved
      ? 'Tempo follows the sync master while slaved'
      : s.mode !== 'off'
        ? 'Sync is armed but nothing is connected — the tempo is yours'
        : '';
  };
  applySlaved(engine.sync.status);
  engine.sync.onStatus(applySlaved);
  transport.appendChild(bpmKnob.el);
  transport.appendChild(new Knob({ bus, paramId: 'transport.swing', label: 'SWING' }).el);

  el.appendChild(transport);

  const right = document.createElement('div');
  right.className = `${styles.headerGroup!} ${styles.voicingGroup!}`;

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
  engine: StudioApi, bus: ParamBus, session: PresetSession, xy: XyPadStore, bridge: UiBridge,
  patternUndo: PatternUndo,
): {
  el: HTMLElement;
  loadDemo: (name: string) => Promise<void>;
  importSongBytes: (bytes: Uint8Array, name: string) => Promise<boolean>;
} {
  // One shared XY Pad window controller for every launcher (Song panel, LIVE FX
  // window, Motion panel) — they must all toggle the SAME window (xy-pad.md).
  // The pad's axes follow the *effective* assignment (a motion play bank's
  // override wins while motion is on), so its labels stay truthful per bar.
  const effectiveXy = createEffectiveXy(xy, engine.patterns, engine.arrangement, bus);
  const xyWin = createXyPadWindowController(bus, xy, effectiveXy);
  const song = buildSongPanel(bus, engine, session, xy, bridge, xyWin);
  // Hoisted out of the tabs array: the panel is built before the TabContainer
  // exists, so this is the only way to keep a handle on it (see below).
  const seq = buildSeqPanel(bus, engine, patternUndo, bridge);
  const drums = buildDrumPanel(bus, engine, patternUndo, bridge);
  const sampler = buildSamplerPanel(bus, engine, patternUndo, bridge);
  const motion = buildMotionPanel(bus, engine, xy, xyWin, patternUndo, bridge);
  const tabs = new TabContainer([
    { id: 'arp', label: 'Arpeggiator', content: buildArpPanel(bus), indicator: true },
    { id: 'seq', label: 'Sequencer', content: seq.el, indicator: true },
    { id: 'drums', label: 'Drum Machine', content: drums.el, indicator: true },
    { id: 'sampler', label: 'Sampler', content: sampler.el, indicator: true },
    { id: 'motion', label: 'Motion', content: motion.el, indicator: true },
    { id: 'song', label: 'Song', content: song.el },
  ], 'arp', {
    collapsibleStoreKey: 'websynth.ui.collapsed.pattern',
    collapsedByDefault: isCompact,
  });
  tabs.el.classList.add(styles.patternRow!);
  tabs.el.dataset.testid = 'pattern-row';

  // Ctrl/Cmd+Z routes to the machine behind the active tab (pattern-undo.md
  // REQ-10). Arp/Song (and empty stacks) return false so the key falls through.
  const TAB_MACHINE: Record<string, UndoMachine> = {
    seq: 'seq', drums: 'drum', sampler: 'sampler', motion: 'motion',
  };
  bridge.undoActiveMachine = () => {
    const m = TAB_MACHINE[tabs.activeId];
    if (!m || !patternUndo.canUndo(m)) return false;
    patternUndo.undo(m);
    return true;
  };

  // Delete/Backspace clears the selected step of the machine behind the active
  // tab (step-grid-editing.md REQ-5) — the same routing shape as Ctrl+Z above.
  // Motion is absent on purpose: it has no selection cursor (REQ-9).
  const TAB_PANEL: Record<string, MachinePanel> = { seq, drums, sampler };
  bridge.clearSelectedStep = () => {
    const panel = TAB_PANEL[tabs.activeId];
    if (!panel) return false;
    panel.clearSelectedStep();
    return true;
  };

  // Step Input is armed only while its own grid is on screen (sequencer.md
  // REQ-5): switching tabs or folding the row disarms it, so notes played
  // elsewhere — held chords on the Arpeggiator tab, say — can never overwrite
  // the sequencer bank behind the user's back.
  tabs.onViewChange(() => { if (!tabs.isVisible('seq')) seq.disarmStepInput(); });

  // A hidden panel keeps its subscriptions but does no repainting: all four
  // would otherwise sweep a playhead every 16th (and Motion re-project its SVG
  // graph every bar) against DOM nobody can see. `isVisible` is false for the
  // whole row when it is folded too, so a collapsed pattern row costs nothing.
  // Each gate replays the current state on reveal — see VisibilityGate.
  // (runtime-performance.md REQ-4)
  const gated: Array<[string, { gate: { set(v: boolean): void } }]> = [
    ['seq', seq], ['drums', drums], ['sampler', sampler], ['motion', motion],
  ];
  const syncGates = (): void => {
    for (const [id, panel] of gated) panel.gate.set(tabs.isVisible(id));
  };
  tabs.onViewChange(syncGates);
  syncGates(); // the panels were built before the tabs existed

  // The Song panel's lane titles navigate here (machine-status.md REQ-5).
  bridge.showTab = (id) => tabs.reveal(id);

  // Machine status LEDs (machine-status.md REQ-1/REQ-2). `subscribe` fires
  // immediately with the current value, so this also paints the initial state.
  subscribeMachineStatus(bus, () => {
    const status = readMachineStatus(bus);
    for (const m of MACHINE_IDS) tabs.setIndicator(MACHINE_TAB[m], status[m]);
  });
  // The arp is not a machine — no lane, so no mute or solo — but whether it is
  // armed changes what the keyboard does, which is worth reading at a glance
  // mid-performance (machine-status.md REQ-10).
  subscribeArpStatus(bus, () => tabs.setIndicator(ARP_TAB, readArpStatus(bus)));

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
    ], styles.spread!));
    b.appendChild(pulseWidthRow(bus, 'osc1'));
  }, 'oscillators'));

  main.appendChild(panel('OSC 2', (b) => {
    b.appendChild(new Segmented(bus, 'osc2.wave', WAVE_LABELS, WAVE_ICONS).el);
    b.appendChild(row([
      new Knob({ bus, paramId: 'osc2.octave', label: 'OCT' }).el,
      new Knob({ bus, paramId: 'osc2.detune', label: 'TUNE' }).el,
      new Knob({ bus, paramId: 'osc2.level', label: 'LEVEL' }).el,
    ], styles.spread!));
    b.appendChild(pulseWidthRow(bus, 'osc2'));
  }));

  main.appendChild(panel('SUB / UNI', (b) => {
    b.appendChild(new Segmented(bus, 'sub.wave', WAVE_LABELS, WAVE_ICONS).el);
    // One .quad grid: 2x2 above 1280px, a single row on wider tablet panels.
    b.appendChild(row([
      new Knob({ bus, paramId: 'sub.octave', label: 'S.OCT' }).el,
      new Knob({ bus, paramId: 'sub.level', label: 'S.LVL' }).el,
      new Knob({ bus, paramId: 'unison.voices', label: 'UNISON' }).el,
      new Knob({ bus, paramId: 'unison.detune', label: 'SPREAD' }).el,
    ], styles.quad!));
  }, 'subuni'));

  main.appendChild(panel('MIXER', (b) => {
    b.appendChild(row([
      new Knob({ bus, paramId: 'mixer.noise', label: 'NOISE' }).el,
      new Knob({ bus, paramId: 'mixer.glide', label: 'GLIDE' }).el,
      new Knob({ bus, paramId: 'analog.drift', label: 'DRIFT' }).el,
    ], styles.spread!));
    b.appendChild(new Segmented(bus, 'glide.mode', GLIDE_MODE_LABELS).el);
  }, 'mixer'));

  main.appendChild(panel('FILTER', (b) => {
    b.appendChild(new Segmented(bus, 'filter.model', FILTER_MODEL_LABELS).el);
    // One .hex grid: 3x2 above 1280px, a single row on wider tablet panels.
    // Row 1 shapes the tone, row 2 drives and modulates it.
    const shape = new Knob({ bus, paramId: 'filter.shape', label: 'SHAPE' });
    b.appendChild(row([
      new Knob({ bus, paramId: 'filter.cutoff', label: 'CUTOFF' }).el,
      new Knob({ bus, paramId: 'filter.resonance', label: 'RESO' }).el,
      shape.el,
      new Knob({ bus, paramId: 'filter.drive', label: 'DRIVE' }).el,
      new Knob({ bus, paramId: 'filter.envAmount', label: 'ENV' }).el,
      new Knob({ bus, paramId: 'filter.keytrack', label: 'KEYTRK' }).el,
    ], styles.hex!));
    // SHAPE belongs to POLY — the ladder's saturated taps cannot make a clean
    // high-pass, so the worklet ignores it there (filter-models.md REQ-7). Dim
    // rather than hide: the control keeps its place, so the switch reads as
    // "this model has more to offer", not as a jumping layout (ADR-014).
    bus.subscribe('filter.model', (m) => shape.setDisabled(Math.round(m) === 0));
  }, 'filter'));

  main.appendChild(panel('AMP ENV', (b) => {
    b.appendChild(row([
      new Knob({ bus, paramId: 'env.amp.attack', label: 'A' }).el,
      new Knob({ bus, paramId: 'env.amp.decay', label: 'D' }).el,
      new Knob({ bus, paramId: 'env.amp.sustain', label: 'S' }).el,
      new Knob({ bus, paramId: 'env.amp.release', label: 'R' }).el,
    ], styles.quad!));
  }, 'ampenv'));

  main.appendChild(panel('FILTER ENV', (b) => {
    // VEL sits with the filter envelope, not on the FILTER panel, because it
    // scales *this* envelope's depth (envelopes.md REQ-5) — the same pairing
    // hardware uses. At its default 0 it does nothing, so the panel reads
    // exactly as it did until someone reaches for it.
    b.appendChild(row([
      new Knob({ bus, paramId: 'env.fil.attack', label: 'A' }).el,
      new Knob({ bus, paramId: 'env.fil.decay', label: 'D' }).el,
      new Knob({ bus, paramId: 'env.fil.sustain', label: 'S' }).el,
      new Knob({ bus, paramId: 'env.fil.release', label: 'R' }).el,
      new Knob({ bus, paramId: 'filter.velAmount', label: 'VEL' }).el,
    ], styles.quint!));
  }, 'filterenv'));

  main.appendChild(panel('LFO', (b) => {
    b.appendChild(new Segmented(bus, 'lfo.wave', WAVE_LABELS, WAVE_ICONS).el);
    const rate = new Knob({ bus, paramId: 'lfo.rate', label: 'RATE' });
    b.appendChild(row([
      rate.el,
      new Knob({ bus, paramId: 'lfo.amount', label: 'AMT' }).el,
    ], styles.spread!));
    b.appendChild(new ParamDropdown(bus, 'lfo.dest', LFO_DEST_LABELS).el);
    b.appendChild(new ParamDropdown(bus, 'lfo.sync', LFO_SYNC_LABELS).el);
    // While the rate is tempo-locked the knob is not what sets it (lfo.md
    // REQ-9), so dim it — the same treatment the BPM knob gets while
    // clock-slaved and SHAPE gets on the LADDER model. Dim, never hide: the
    // control keeps its place and its value, which is what it returns to on
    // 'free' (ADR-014).
    bus.subscribe('lfo.sync', (s) => rate.setDisabled(Math.round(s) > 0));
    b.appendChild(pulseRateDisclosure(bus, rate));
  }, 'lfo'));

  return main;
}

const SQUARE_WAVE = WAVE_LABELS.indexOf('square');
const PULSE_DEST = LFO_DEST_LABELS.indexOf('pulse');

/**
 * The pulse-width knob, shown only while that oscillator is on `square` —
 * width is meaningless for the other waveforms (oscillators.md REQ-5).
 *
 * It gets its own row rather than joining the 3-knob `.spread` row above: a
 * fourth knob there would flex-wrap 3+1, which is the exact layout `.quad`
 * exists to prevent (responsive-synth-panels.md).
 */
function pulseWidthRow(bus: ParamBus, osc: 'osc1' | 'osc2'): HTMLElement {
  const el = row([new Knob({ bus, paramId: `${osc}.pulseWidth`, label: 'WIDTH' }).el]);
  // `subscribe` fires immediately, so the initial visibility is correct.
  bus.subscribe(`${osc}.wave`, (w) => {
    el.style.display = Math.round(w) === SQUARE_WAVE ? '' : 'none';
  });
  return el;
}

/**
 * `lfo.rate` is shared by every destination, but the PWM path clamps it
 * (oscillators.md REQ-9) — without this the knob would move above the cap with
 * nothing happening. Narrowing the param's own range is not an option: it would
 * make `preset-validate` reject every saved patch with a faster LFO.
 *
 * Two cues, deliberately on **one** subscription so they cannot drift apart: the
 * sentence, and a soft ceiling on the RATE knob that stops its arc filling
 * through the dead travel (knob-soft-ceiling.md). The arc is what gets noticed —
 * it is what sends the user to the sentence, which is ADR-014 law 1 (self-evident
 * beats explained) applied without giving up the explanation. Both are scoped to
 * `pulse`: every other destination really does run the full 0.05..20 Hz.
 */
function pulseRateDisclosure(bus: ParamBus, rate: Knob): HTMLElement {
  const el = document.createElement('p');
  el.className = styles.paramHint!;
  el.textContent = `Pulse width follows the rate up to ${PWM_RATE_MAX} Hz.`;
  bus.subscribe('lfo.dest', (d) => {
    const pulse = Math.round(d) === PULSE_DEST;
    el.style.display = pulse ? '' : 'none';
    rate.setUiMax(pulse ? PWM_RATE_MAX : null);
  });
  return el;
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

  // Five effects in the ≤992px 2-column grid leave one cell empty; fill it with
  // the unpatched-cable scenery (fx-patch-decoration.md). Parity-keyed, so a
  // sixth effect drops it again instead of pushing it onto a row of its own.
  if (fx.childElementCount % 2 === 1) fx.appendChild(fxPatchDecoration());

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

function row(children: HTMLElement[], extraClass?: string): HTMLElement {
  const r = document.createElement('div');
  r.className = extraClass ? `${styles.panelRow!} ${extraClass}` : styles.panelRow!;
  for (const c of children) r.appendChild(c);
  return r;
}
