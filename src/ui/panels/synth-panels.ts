import type { ParamBus } from '../../state/params';
import {
  WAVE_LABELS, GLIDE_MODE_LABELS, FILTER_MODEL_LABELS, OSC_SYNC_LABELS,
} from '../../state/params';
import { Knob } from '../components/knob';
import { Segmented } from '../components/segmented';
import { WAVE_ICONS } from '../components/wave-icons';
import { createPanel, knobRow, panelZones } from '../components/panel';
import { buildLfoPanel } from './lfo-panel';
import panelStyles from '../styles/panel.module.css';
import synthStyles from '../styles/synth-panels.module.css';

/** The faceplate panel shell lives in `components/panel.ts`, so a tabbed
 *  panel can share it (panel-tabs.md REQ-panel-and-tabbed-panel-share-a-box). */
const panel = createPanel;

/**
 * The eight synth panels — OSC 1, OSC 2, SUB / UNI, MIXER, FILTER, AMP ENV,
 * FILTER ENV and the two LFOs — in the faceplate grid that reflows 8 → 4 → 2
 * columns (responsive-synth-panels.md). Takes only the bus: nothing here reads
 * the shell's state, which is what lets it live outside `app.ts`.
 */
export function buildSynthPanels(bus: ParamBus): HTMLElement {
  const main = document.createElement('div');
  main.className = synthStyles.main!;
  const knob = (paramId: string, label: string): HTMLElement => new Knob({ bus, paramId, label }).el;

  // Each body is three zones — selector on top, knobs centred, mode control at the
  // bottom — so the selectors line up across the faceplate whatever each panel
  // holds (responsive-synth-panels.md REQ-selectors-pin-to-the-panel-edges).
  main.appendChild(panel('OSC 1', (b) => {
    // OSC 1 is the modulator, so the two cross-mods live here as its outputs:
    // LEVEL to the mixer, FM into OSC 2's pitch, RING (1×2) into the mixer
    // (cross-modulation.md REQ-the-modulator-controls-live-on-osc-1). Sync stays on
    // OSC 2 — it is something the slave does to itself.
    panelZones(b, {
      top: new Segmented(bus, 'osc1.wave', WAVE_LABELS, WAVE_ICONS).el,
      knobs: [knobRow([
        knob('osc1.octave', 'OCT'),
        knob('osc1.detune', 'TUNE'),
        knob('osc1.level', 'LEVEL'),
        ...behindBreak(bus, [
          { el: knob('osc1.fm', 'FM') },
          { el: knob('osc1.ring', 'RING') },
          pulseWidthKnob(bus, 'osc1'),
        ], panelStyles.six!),
      ], panelStyles.spread!)],
    });
  }, 'oscillators'));

  main.appendChild(panel('OSC 2', (b) => {
    panelZones(b, {
      top: new Segmented(bus, 'osc2.wave', WAVE_LABELS, WAVE_ICONS).el,
      knobs: [knobRow([
        knob('osc2.octave', 'OCT'),
        knob('osc2.detune', 'TUNE'),
        knob('osc2.level', 'LEVEL'),
        ...behindBreak(bus, [pulseWidthKnob(bus, 'osc2'), syncPitchKnob(bus)]),
      ], panelStyles.spread!)],
      // Sync locks osc2 to osc1, so it lives on the slave's panel (oscillator-sync.md).
      bottom: new Segmented(bus, 'osc2.sync', OSC_SYNC_LABELS).el,
    });
  }, 'osc2'));

  main.appendChild(panel('SUB / UNI', (b) => {
    panelZones(b, {
      top: new Segmented(bus, 'sub.wave', WAVE_LABELS, WAVE_ICONS).el,
      // One .quad grid: 2x2 above 1280px, a single row on wider tablet panels.
      knobs: [knobRow([
        knob('sub.octave', 'S.OCT'),
        knob('sub.level', 'S.LVL'),
        knob('unison.voices', 'UNISON'),
        knob('unison.detune', 'SPREAD'),
      ], panelStyles.quad!)],
    });
  }, 'subuni'));

  main.appendChild(panel('MIXER', (b) => {
    panelZones(b, {
      knobs: [knobRow([
        knob('mixer.noise', 'NOISE'),
        knob('mixer.glide', 'GLIDE'),
        knob('analog.drift', 'DRIFT'),
      ], panelStyles.spread!)],
      bottom: new Segmented(bus, 'glide.mode', GLIDE_MODE_SHOWN).el,
    });
  }, 'mixer'));

  main.appendChild(panel('FILTER', (b) => {
    // One .hex grid: 3x2 above 1280px, a single row on wider tablet panels.
    // Row 1 shapes the tone, row 2 drives and modulates it.
    const shape = new Knob({ bus, paramId: 'filter.shape', label: 'SHAPE' });
    panelZones(b, {
      top: new Segmented(bus, 'filter.model', FILTER_MODEL_LABELS).el,
      knobs: [knobRow([
        knob('filter.cutoff', 'CUTOFF'),
        knob('filter.resonance', 'RESO'),
        shape.el,
        knob('filter.drive', 'DRIVE'),
        knob('filter.envAmount', 'ENV'),
        knob('filter.keytrack', 'KEYTRK'),
      ], panelStyles.hex!)],
    });
    // SHAPE belongs to POLY — the ladder's saturated taps cannot make a clean
    // high-pass, so the worklet ignores it there (filter-models.md REQ-shape-is-poly-only). Dim
    // rather than hide: the control keeps its place, so the switch reads as
    // "this model has more to offer", not as a jumping layout (ADR-014).
    bus.subscribe('filter.model', (m) => shape.setDisabled(Math.round(m) === 0));
  }, 'filter'));

  main.appendChild(panel('AMP ENV', (b) => {
    panelZones(b, {
      knobs: [knobRow([
        knob('env.amp.attack', 'A'),
        knob('env.amp.decay', 'D'),
        knob('env.amp.sustain', 'S'),
        knob('env.amp.release', 'R'),
      ], panelStyles.quad!)],
    });
  }, 'ampenv'));

  main.appendChild(panel('FILTER ENV', (b) => {
    // VEL sits with the filter envelope, not on the FILTER panel, because it
    // scales *this* envelope's depth (envelopes.md REQ-filter-env-follows-velocity) — the same pairing
    // hardware uses. At its default 0 it does nothing, so the panel reads
    // exactly as it did until someone reaches for it.
    panelZones(b, {
      knobs: [knobRow([
        knob('env.fil.attack', 'A'),
        knob('env.fil.decay', 'D'),
        knob('env.fil.sustain', 'S'),
        knob('env.fil.release', 'R'),
        knob('filter.velAmount', 'VEL'),
      ], panelStyles.quint!)],
    });
  }, 'filterenv'));

  // Two LFOs behind a tab strip, so the pair costs one grid column, not two
  // (lfo.md REQ-the-two-lfos-share-one-panel). Its own module — see the note there.
  main.appendChild(buildLfoPanel(bus));

  return main;
}

const SQUARE_WAVE = WAVE_LABELS.indexOf('square');

/** The glide switch's button text: OFF / ON / LEGATO. Derived, so it cannot drift
 *  from the param, whose labels stay `always` for presets, songs and the MCP
 *  tools (voicing.md REQ-the-glide-switch-reads-on). */
const GLIDE_MODE_SHOWN = GLIDE_MODE_LABELS.map((l) => (l === 'always' ? 'on' : l));

/** A control that is always on show, or only while another param says it means
 *  something. A union, so a `paramId` without its `shown` cannot be written. */
type Conditional =
  | { el: HTMLElement; paramId?: undefined; shown?: undefined }
  | { el: HTMLElement; paramId: string; shown: (value: number) => boolean };

/**
 * Knobs joining the 3-knob `.spread` row behind a `.rowBreak`: up to 2560px the
 * break takes a full line, so they sit centred below OCT/TUNE/LEVEL rather than
 * wrapping 3+1 — the layout `.quad` exists to prevent — and on an ultrawide the
 * break is dropped and all share one row (responsive-synth-panels.md
 * REQ-ultrawide-panels-are-one-row; `breakClass` can hold it longer). The break
 * shows while any of them does, so hidden knobs leave no empty line behind.
 */
function behindBreak(bus: ParamBus, items: Conditional[], breakClass?: string): HTMLElement[] {
  const brk = document.createElement('div');
  brk.className = breakClass ? `${panelStyles.rowBreak!} ${breakClass}` : panelStyles.rowBreak!;
  const visible = items.map((it) => it.paramId === undefined);
  const paint = (): void => { brk.style.display = visible.some(Boolean) ? '' : 'none'; };
  items.forEach((it, i) => {
    const { paramId, shown } = it;
    if (paramId === undefined) return;
    // `subscribe` fires immediately, so the initial visibility is correct.
    bus.subscribe(paramId, (v) => {
      visible[i] = shown(v);
      it.el.style.display = visible[i] ? '' : 'none';
      paint();
    });
  });
  paint();
  return [brk, ...items.map((it) => it.el)];
}

/**
 * The pulse-width knob, shown only while that oscillator is on `square` —
 * width is meaningless for the other waveforms (oscillators.md REQ-oscillators-have-a-pulse-width).
 */
function pulseWidthKnob(bus: ParamBus, osc: 'osc1' | 'osc2'): Conditional {
  return {
    el: new Knob({ bus, paramId: `${osc}.pulseWidth`, label: 'WIDTH' }).el,
    paramId: `${osc}.wave`,
    shown: (w) => Math.round(w) === SQUARE_WAVE,
  };
}

/**
 * The sync sweep, shown only while sync is engaged — it is inert otherwise
 * (oscillator-sync.md REQ-sync-pitch-is-the-sweep), and a knob that does nothing
 * would read as broken (ADR-014).
 */
function syncPitchKnob(bus: ParamBus): Conditional {
  return {
    el: new Knob({ bus, paramId: 'osc2.syncPitch', label: 'SYNC' }).el,
    paramId: 'osc2.sync',
    shown: (m) => Math.round(m) !== 0,
  };
}
