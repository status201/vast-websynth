import {
  type ParamBus, WAVE_LABELS, GLIDE_MODE_LABELS, FILTER_MODEL_LABELS,
} from '../../state/params';
import { WAVE_ICONS } from '../components/wave-icons';
import { buildLfoPanel } from './lfo-panel';
import styles from '../styles/layout.module.css';
import { Knob } from '../components/knob';
import { Segmented } from '../components/segmented';
import { createPanel as panel } from '../components/panel';
import { row } from '../layout-helpers';

/**
 * The synth faceplate's panels — oscillators, mixer, filter, envelopes, LFO.
 *
 * Eight panel declarations and one visibility rule, lifted out of `app.ts`.
 * They were never entangled with the shell: `buildMain` takes the bus and
 * returns an element, and nothing in it reads the app's closure state. It sat
 * there for historical reasons only, and it was a fifth of the file.
 */

export function buildMain(bus: ParamBus): HTMLElement {
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
    // high-pass, so the worklet ignores it there (filter-models.md REQ-shape-is-poly-only). Dim
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
    // scales *this* envelope's depth (envelopes.md REQ-filter-env-follows-velocity) — the same pairing
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
