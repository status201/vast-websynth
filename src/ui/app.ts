import type { StudioApi } from './studio-api';
import type { ParamBus } from '../state/params';
import type { PresetSession } from '../state/preset-session';
import { pinAppliedSong } from '../state/preset-session';
import type { XyPadStore } from '../state/xy-pad';
import type { PatternUndo } from '../state/pattern-undo';
import type { UiBridge } from './ui-bridge';
import { Strip } from './components/strip';
import { Scope } from './components/scope';
import { ResizeHandle } from './components/resize-handle';
import {
  SCOPE_H_MIN, SCOPE_H_MAX, SCOPE_H_DEFAULT, SCOPE_H_STEP,
  readScopeHeight, writeScopeHeight,
} from '../state/scope-height';
import { Keyboard } from './components/keyboard';
import { keyboardRange, whiteKeyPx } from './keyboard-range';
import { onKeyChange, readKeyState } from './key-roles';
import switchStyles from './styles/switch.module.css';
import { PERF_PROFILES, resolveTier, type PerfTier } from '../state/perf-mode';
import { createOnboarding, type Onboarding } from './onboarding';
import type { TourCtx } from './onboarding/tour';
import bottomStyles from './styles/bottom.module.css';
import { setScopeStatsSource } from '../state/debug-sources';

import { Song, DEMO_SONGS } from '../state/song';
import { buildEqPanel } from './panels/eq-panel';
import { buildHeader } from './shell/header';
import { buildSynthPanels } from './panels/synth-panels';
import { buildPatternRow } from './shell/pattern-row';
import { buildFxRack } from './panels/fx-rack';
import { isPhone } from './viewport';

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
  // Only the built-in is reachable here — the drop-in and zip demos are
  // fetched on click and so are inherently async (song-mode.md REQ-song-lane-titles-navigate) — but
  // this fallback is replaced a few lines below and never actually used.
  // The real unknown-name fallback lives in `resolveDemoName` (REQ-a-taller-bar-pins-the-peak, v18),
  // which `SongPanel.loadDemo` applies to every caller including the tour.
  let songLoadDemo: (name: string) => Promise<void> = async (name) => {
    const file = DEMO_SONGS[name] ?? Object.values(DEMO_SONGS)[0];
    if (file) {
      Song.apply(file, bus, engine.patterns, engine.arrangement, xy, engine.sampler);
      pinAppliedSong(session, file.name, bus);
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
  root.appendChild(buildSynthPanels(bus));
  const fx = buildFxRack(bus);
  fxExpand = fx.expand;
  root.appendChild(fx.el);
  const patternRow = buildPatternRow(engine, bus, session, xy, bridge, patternUndo);
  songLoadDemo = patternRow.loadDemo;
  // OS-launched song files (installed-PWA file_handlers) flow through the
  // same import path as the Song panel's Import button (pwa-install.md REQ-one-import-parse-path).
  bridge.importSongBytes = patternRow.importSongBytes;
  root.appendChild(patternRow.el);
  const bottom = buildBottom(engine, bus, bridge);
  setScopeFps = (fps) => bottom.scope.setFps(fps);
  setScopeFft = (fftSize) => bottom.scope.setFftSize(fftSize);
  // Whether the panel is actually painting, for the Debug row (scope.md REQ-the-panel-says-whether-it-is-drawing).
  // Same late-bound idiom as the two knobs above — the owner of the state binds it.
  setScopeStatsSource(() => bottom.scope.health);
  root.appendChild(bottom.el);

  return onboarding;
}


function buildBottom(
  engine: StudioApi, bus: ParamBus, bridge: UiBridge,
): { el: HTMLElement; scope: Scope; scopeResize: ResizeHandle } {
  const bottom = document.createElement('div');
  bottom.className = bottomStyles.bottom!;
  // Read once here; the ResizeHandle below writes it onto `bottom` in its
  // constructor — which happens before this subtree is mounted, so a taller
  // scope is there from the first paint rather than jumping into place
  // (scope REQ-the-scope-height-persists). The CSS default covers "nothing stored".
  const scopeHeight = readScopeHeight();

  const top = document.createElement('div');
  top.className = bottomStyles.bottomTop!;

  const wheels = document.createElement('div');
  wheels.className = bottomStyles.wheels!;
  wheels.appendChild(new Strip({ bus, paramId: 'master.pitchBend', label: 'PITCH', springBack: true }).el);
  wheels.appendChild(new Strip({ bus, paramId: 'keyboard.transpose', label: 'OCT' }).el);
  wheels.appendChild(new Strip({ bus, paramId: 'master.modWheel', label: 'MOD' }).el);
  top.appendChild(wheels);

  const scopeWrap = document.createElement('div');
  scopeWrap.className = bottomStyles.scopeWrap!;
  // Static CRT screen underlay (gradient + inset vignette) behind the transparent
  // canvas, so the 60fps redraw never re-rasters the decoration. (scope REQ-no-per-frame-layout-read)
  const scopeScreen = document.createElement('div');
  scopeScreen.className = bottomStyles.scopeScreen!;
  scopeWrap.appendChild(scopeScreen);
  const scope = new Scope(
    { mono: engine.analyser, left: engine.analyserL, right: engine.analyserR },
    { fps: PERF_PROFILES[resolveTier()].fps },
  );
  scopeWrap.appendChild(scope.el);
  const toggle = document.createElement('button');
  toggle.className = `${switchStyles.root!} ${bottomStyles.scopeToggle!}`;
  toggle.dataset.testid = 'scope-toggle';
  toggle.textContent = 'Wave';
  let isWave = true;
  toggle.addEventListener('click', () => {
    isWave = !isWave;
    scope.setMode(isWave ? 'wave' : 'spectrum');
    toggle.textContent = isWave ? 'Wave' : 'Spectrum';
    // The problem-band overlay only means anything over a frequency axis, so its
    // button rides the view rather than sitting on the panel forever (scope REQ-a-zones-toggle).
    zonesToggle.hidden = isWave;
  });
  scopeWrap.appendChild(toggle);
  // Mono/Stereo toggle — orthogonal to Wave/Spectrum. Defaults to Mono.
  const chanToggle = document.createElement('button');
  chanToggle.className = `${switchStyles.root!} ${bottomStyles.scopeChannelsToggle!}`;
  chanToggle.dataset.testid = 'scope-channels-toggle';
  chanToggle.textContent = 'Mono';
  let isStereo = false;
  chanToggle.addEventListener('click', () => {
    isStereo = !isStereo;
    scope.setChannels(isStereo ? 'stereo' : 'mono');
    chanToggle.textContent = isStereo ? 'Stereo' : 'Mono';
  });
  scopeWrap.appendChild(chanToggle);
  // Problem-frequency overlay — bottom-right, the one corner free of chrome, which
  // is also why the spectrum plot reserves a gutter there (scope REQ-a-zones-toggle). Hidden
  // until the view that gives it meaning is on screen; declared BEFORE the
  // Wave/Spectrum handler above runs, but after that button so tab order still
  // reads left-to-right, top-to-bottom.
  const zonesToggle = document.createElement('button');
  zonesToggle.className = `${switchStyles.root!} ${bottomStyles.scopeZonesToggle!}`;
  zonesToggle.dataset.testid = 'scope-zones-toggle';
  zonesToggle.textContent = 'Zones';
  zonesToggle.title = 'Shade the four problem bands — mud, boxy, nasal, harsh';
  zonesToggle.hidden = true;
  zonesToggle.addEventListener('click', () => {
    const on = !scope.zonesOn;
    scope.setZones(on);
    zonesToggle.classList.toggle('on', on);
  });
  scopeWrap.appendChild(zonesToggle);
  // Resize grip on the panel's top edge. A SIBLING of the canvas, like the two
  // toggles above — that is what keeps a press on it from reaching the canvas
  // click listener and resetting the peak-hold (scope REQ-clicking-the-graph-resets-the-peak/REQ-a-scope-resize-handle). It resizes
  // the shared grid row, so the PITCH/OCT/MOD strips grow with the scope.
  const scopeResize = new ResizeHandle({
    target: bottom,
    cssVar: '--scope-h',
    min: SCOPE_H_MIN,
    max: SCOPE_H_MAX,
    initial: scopeHeight,
    defaultValue: SCOPE_H_DEFAULT,
    step: SCOPE_H_STEP,
    onCommit: writeScopeHeight,
    testId: 'scope-resize-handle',
    label: 'Scope height',
    title: 'Drag to resize the scope — double-click to reset',
    className: bottomStyles.scopeResize!,
  });
  scopeWrap.appendChild(scopeResize.el);
  top.appendChild(scopeWrap);

  bottom.appendChild(top);

  // The EQUALIZER section, between the scope and the keyboard (equalizer.md
  // REQ-the-eq-is-a-third-bottom-row). It is the content-sized middle item of the same column: `--scope-h`
  // still sizes the scope row alone, so the scope's resize handle is untouched, and an
  // expanded EQ is absorbed by the keyboard's floor — the behaviour
  // scope.md REQ-a-scope-resize-handle already describes for a grown scope, now with a second
  // grower under it. Folded by default, so the resting layout costs only the bar.
  const eq = buildEqPanel(bus, engine);
  bottom.appendChild(eq.el);

  const kbWrap = document.createElement('div');
  kbWrap.className = bottomStyles.keyboardWrap!;
  kbWrap.dataset.testid = 'keyboard';
  // The octave count follows the width the keys get (keyboard-range.md): the base
  // range until laid out — 2 octaves on a phone, 3 elsewhere — then the observer,
  // which fires after layout and before paint, grows it on a wide screen so no
  // white key outgrows MAX_WHITE_PX. setRange is a no-op unless the count changes.
  // The same observation hands CSS the white-key width, which bounds the key
  // height (keyboard-range.md REQ-key-height-follows-key-width). Whole px, and written
  // only when it changes (runtime-performance.md REQ-dom-writes-are-guarded-on-what-is-rendered);
  // the width never depends on the height, so this cannot feed back.
  const phone = isPhone();
  const keyboard = new Keyboard({ bus, ...keyboardRange(0, phone) });
  kbWrap.appendChild(keyboard.el);
  if (typeof ResizeObserver !== 'undefined') {
    let keyW = '';
    new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]!.contentRect.width;
      const range = keyboardRange(width, isPhone());
      keyboard.setRange(range);
      const next = `${whiteKeyPx(width, range.octaves)}px`;
      if (next !== keyW) bottom.style.setProperty('--kb-key-w', (keyW = next));
    }).observe(keyboard.el);
  }
  bottom.appendChild(kbWrap);

  // Visual-only: reflect computer-keyboard input on the on-screen keys. The note
  // itself is fired once by installShortcuts (bus.noteOn); highlighting here must
  // not also touch the bus or a single key double-fires. See input-control.md REQ-a-key-emits-exactly-one-note-on.
  bridge.pressKey = (n) => keyboard.highlight(n, true);
  bridge.releaseKey = (n) => keyboard.highlight(n, false);

  // Wear the current key, so which notes are in play is legible from where the fingers
  // already are rather than only on the KEY tab (scale-quantization.md REQ-the-key-is-shown-where-you-play). Wired
  // here, not inside Keyboard, so the component stays free of music theory. Chromatic
  // passes `null`: a restriction that restricts nothing is not worth drawing.
  onKeyChange(bus, () => {
    const state = readKeyState(bus);
    keyboard.setKeyRoles(state.active ? state : null);
  });

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

  return { el: bottom, scope, scopeResize };
}

