import type { ParamBus } from '../../state/params';
import {
  WAVE_LABELS, GLIDE_MODE_LABELS, FILTER_MODEL_LABELS,
} from '../../state/params';
import { Knob } from '../components/knob';
import { Segmented } from '../components/segmented';
import { WAVE_ICONS } from '../components/wave-icons';
import { createPanel } from '../components/panel';
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

  main.appendChild(panel('OSC 1', (b) => {
    b.appendChild(new Segmented(bus, 'osc1.wave', WAVE_LABELS, WAVE_ICONS).el);
    b.appendChild(row([
      knob('osc1.octave', 'OCT'),
      knob('osc1.detune', 'TUNE'),
      knob('osc1.level', 'LEVEL'),
      ...pulseWidthKnob(bus, 'osc1'),
    ], panelStyles.spread!));
  }, 'oscillators'));

  main.appendChild(panel('OSC 2', (b) => {
    b.appendChild(new Segmented(bus, 'osc2.wave', WAVE_LABELS, WAVE_ICONS).el);
    b.appendChild(row([
      knob('osc2.octave', 'OCT'),
      knob('osc2.detune', 'TUNE'),
      knob('osc2.level', 'LEVEL'),
      ...pulseWidthKnob(bus, 'osc2'),
    ], panelStyles.spread!));
  }));

  main.appendChild(panel('SUB / UNI', (b) => {
    b.appendChild(new Segmented(bus, 'sub.wave', WAVE_LABELS, WAVE_ICONS).el);
    // One .quad grid: 2x2 above 1280px, a single row on wider tablet panels.
    b.appendChild(row([
      knob('sub.octave', 'S.OCT'),
      knob('sub.level', 'S.LVL'),
      knob('unison.voices', 'UNISON'),
      knob('unison.detune', 'SPREAD'),
    ], panelStyles.quad!));
  }, 'subuni'));

  main.appendChild(panel('MIXER', (b) => {
    b.appendChild(row([
      knob('mixer.noise', 'NOISE'),
      knob('mixer.glide', 'GLIDE'),
      knob('analog.drift', 'DRIFT'),
    ], panelStyles.spread!));
    b.appendChild(new Segmented(bus, 'glide.mode', GLIDE_MODE_LABELS).el);
  }, 'mixer'));

  main.appendChild(panel('FILTER', (b) => {
    b.appendChild(new Segmented(bus, 'filter.model', FILTER_MODEL_LABELS).el);
    // One .hex grid: 3x2 above 1280px, a single row on wider tablet panels.
    // Row 1 shapes the tone, row 2 drives and modulates it.
    const shape = new Knob({ bus, paramId: 'filter.shape', label: 'SHAPE' });
    b.appendChild(row([
      knob('filter.cutoff', 'CUTOFF'),
      knob('filter.resonance', 'RESO'),
      shape.el,
      knob('filter.drive', 'DRIVE'),
      knob('filter.envAmount', 'ENV'),
      knob('filter.keytrack', 'KEYTRK'),
    ], panelStyles.hex!));
    // SHAPE belongs to POLY — the ladder's saturated taps cannot make a clean
    // high-pass, so the worklet ignores it there (filter-models.md REQ-shape-is-poly-only). Dim
    // rather than hide: the control keeps its place, so the switch reads as
    // "this model has more to offer", not as a jumping layout (ADR-014).
    bus.subscribe('filter.model', (m) => shape.setDisabled(Math.round(m) === 0));
  }, 'filter'));

  main.appendChild(panel('AMP ENV', (b) => {
    b.appendChild(row([
      knob('env.amp.attack', 'A'),
      knob('env.amp.decay', 'D'),
      knob('env.amp.sustain', 'S'),
      knob('env.amp.release', 'R'),
    ], panelStyles.quad!));
  }, 'ampenv'));

  main.appendChild(panel('FILTER ENV', (b) => {
    // VEL sits with the filter envelope, not on the FILTER panel, because it
    // scales *this* envelope's depth (envelopes.md REQ-filter-env-follows-velocity) — the same pairing
    // hardware uses. At its default 0 it does nothing, so the panel reads
    // exactly as it did until someone reaches for it.
    b.appendChild(row([
      knob('env.fil.attack', 'A'),
      knob('env.fil.decay', 'D'),
      knob('env.fil.sustain', 'S'),
      knob('env.fil.release', 'R'),
      knob('filter.velAmount', 'VEL'),
    ], panelStyles.quint!));
  }, 'filterenv'));

  // Two LFOs behind a tab strip, so the pair costs one grid column, not two
  // (lfo.md REQ-the-two-lfos-share-one-panel). Its own module — see the note there.
  main.appendChild(buildLfoPanel(bus));

  return main;
}

const SQUARE_WAVE = WAVE_LABELS.indexOf('square');

/**
 * The pulse-width knob, shown only while that oscillator is on `square` —
 * width is meaningless for the other waveforms (oscillators.md REQ-oscillators-have-a-pulse-width).
 *
 * It joins the 3-knob `.spread` row behind a `.rowBreak`: up to 2560px the break
 * takes a full line, so WIDTH sits alone and centred below the others rather
 * than wrapping 3+1 — the layout `.quad` exists to prevent — and on an ultrawide
 * the break is dropped and the four share one row (responsive-synth-panels.md
 * REQ-ultrawide-panels-are-one-row). Both hide together, so a hidden WIDTH
 * leaves no empty line behind.
 */
function pulseWidthKnob(bus: ParamBus, osc: 'osc1' | 'osc2'): HTMLElement[] {
  const brk = document.createElement('div');
  brk.className = panelStyles.rowBreak!;
  const knob = new Knob({ bus, paramId: `${osc}.pulseWidth`, label: 'WIDTH' }).el;
  // `subscribe` fires immediately, so the initial visibility is correct.
  bus.subscribe(`${osc}.wave`, (w) => {
    const display = Math.round(w) === SQUARE_WAVE ? '' : 'none';
    brk.style.display = display;
    knob.style.display = display;
  });
  return [brk, knob];
}

/** A knob row in a panel body, in one of the row shapes (`.quad`, `.hex`, …). */
function row(children: HTMLElement[], extraClass?: string): HTMLElement {
  const r = document.createElement('div');
  r.className = extraClass ? `${panelStyles.panelRow!} ${extraClass}` : panelStyles.panelRow!;
  for (const c of children) r.appendChild(c);
  return r;
}
