import type { ParamBus } from '../state/params';
import { rampTo, RAMP_MEDIUM } from './param-utils';
import { bindTempoLocked } from './tempo-bind';
import { clamp01 } from '../utils/math';
import { LFO_DEST_SCALE } from '../state/lfo-routing';

const WAVE_TYPES: OscillatorType[] = ['sine', 'triangle', 'sawtooth', 'square'];

/**
 * The slice of `PwmDriver` an LFO is allowed to drive (oscillators.md REQ-set-periodic-wave-is-immediate).
 *
 * Structural rather than an import of the class, so `lfo.ts` pulls nothing from
 * `pwm.ts` and the existing `pwm.ts -> lfo.ts` dependency stays a one-way edge.
 */
export interface LfoPulseSink {
  setDest(src: number, d: number): void;
  setRate(src: number, hz: number): void;
  setWave(src: number, idx: number): void;
  setAmount(src: number, a: number): void;
}

export const enum LfoDest {
  Off = 0,
  Cutoff = 1,
  Pitch = 2,
  Amp = 3,
  Pulse = 4,
  Pan = 5,
  Shape = 6,
  /** The sync pair's slave pitch (oscillator-sync.md REQ-sync-is-a-modulation-destination). */
  Sync = 7,
}

/** Control-signal smoothing for the amplitude-domain outputs (lfo.md REQ-amplitude-destinations-are-smoothed).
 *  Q = 0.5 is critically damped — a step settles without overshoot, so the
 *  smoothed depth never exceeds the depth that was asked for. */
const SMOOTH_HZ = 200;
const SMOOTH_Q = 0.5;

/**
 * A global LFO. Exposes six pre-scaled output nodes: pitch (cents), cutoff
 * (semitones), amp (linear), pan (-1..1), shape (pole mix), sync (semitones),
 * scaled by `LFO_DEST_SCALE`. Only the active destination's gain is non-zero —
 * the others are silent. Voices connect pitch/cutoff/amp/shape/sync to the
 * matching AudioParam (the voice's `pitchTargets()`, filter cutoffNote, tremolo
 * gain, filter shape, the sync junction); Engine connects pan to the synth bus
 * panner.
 *
 * `Engine` builds **two** of these (lfo.md REQ-there-are-two-lfos). Nothing here is shared or
 * static, and every output lands on a summing AudioParam, so two instances on
 * one destination simply add (REQ-duplicated-destinations-sum-and-stay-bounded). The single exception is `Pulse`, which is
 * a parameter write and has to be arbitrated — see `bind` and `PwmDriver`.
 *
 * `Pulse` is the fifth destination and has **no output node here**: a native
 * OscillatorNode has no width AudioParam to drive, so it is handled by
 * `PwmDriver` from a JS-side mirror of this shape (oscillators.md REQ-set-periodic-wave-is-immediate). Its
 * only effect on this class is that `update()` silences everything.
 *
 * `amp`, `pan` and `shape` are fed through a lowpass, `pitch` and `cutoff` are
 * not (lfo.md REQ-amplitude-destinations-are-smoothed/REQ-shape-destination-sweeps-the-pole-mix): on a square/saw waveform a stepped *gain* is a
 * click, while a stepped octave or filter jump is a musical event. `shape`
 * joins the smoothed group despite being frequency-domain in effect — it moves
 * filter *coefficients*, where a step is a click, not a musical event.
 */
export class LFO {
  readonly toPitch: GainNode;
  readonly toCutoff: GainNode;
  readonly toAmp: GainNode;
  readonly toPan: GainNode;
  readonly toShape: GainNode;
  /** Semitones into each voice's sync junction — inert until a pair is engaged. */
  readonly toSync: GainNode;
  /** Unit-amplitude tap for the mod matrix — see the constructor. */
  readonly modTap: GainNode;

  private readonly osc: OscillatorNode;
  /** Each output, the destination that opens it, and its full-scale depth. Only
   *  the selected destination's gain is non-zero. `pulse` has no row: no node. */
  private readonly outputs: ReadonlyArray<readonly [GainNode, LfoDest, number]>;

  /** The running rate in Hz — what the tempo-lock e2e reads instead of the
   *  private oscillator (lfo.md). */
  get rateHz(): number { return this.osc.frequency.value; }
  private amount = 0;
  private dest: LfoDest = LfoDest.Off;

  constructor(private readonly ctx: AudioContext) {
    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';
    this.osc.frequency.value = 4;

    this.toPitch = ctx.createGain();
    this.toCutoff = ctx.createGain();
    this.toAmp = ctx.createGain();
    this.toPan = ctx.createGain();
    this.toShape = ctx.createGain();
    this.toSync = ctx.createGain();
    this.toPitch.gain.value = 0;
    this.toCutoff.gain.value = 0;
    this.toAmp.gain.value = 0;
    this.toPan.gain.value = 0;
    this.toShape.gain.value = 0;
    this.toSync.gain.value = 0;
    this.outputs = [
      [this.toPitch, LfoDest.Pitch, LFO_DEST_SCALE.pitch],
      [this.toCutoff, LfoDest.Cutoff, LFO_DEST_SCALE.cutoff],
      [this.toAmp, LfoDest.Amp, LFO_DEST_SCALE.amp],
      [this.toPan, LfoDest.Pan, LFO_DEST_SCALE.pan],
      [this.toShape, LfoDest.Shape, LFO_DEST_SCALE.shape],
      [this.toSync, LfoDest.Sync, LFO_DEST_SCALE.sync],
    ];

    // Frequency-domain destinations: straight off the oscillator. Sync is one —
    // a stepped slave pitch is a timbre jump, the musical event, not a click.
    this.osc.connect(this.toPitch);
    this.osc.connect(this.toCutoff);
    this.osc.connect(this.toSync);

    // Amplitude-domain destinations: via the de-clicking lowpass.
    const smooth = ctx.createBiquadFilter();
    smooth.type = 'lowpass';
    smooth.frequency.value = SMOOTH_HZ;
    smooth.Q.value = SMOOTH_Q;
    this.osc.connect(smooth);
    smooth.connect(this.toAmp);
    smooth.connect(this.toPan);
    smooth.connect(this.toShape);

    // The mod matrix's tap: unit amplitude, ahead of this LFO's own `amount`, because
    // each matrix route carries its own depth (mod-matrix.md REQ-depth-is-in-the-destinations-unit). Taken from the
    // smoothed path so a square wave cannot click into an amplitude-domain
    // destination — at LFO rates the 200 Hz lowpass is otherwise transparent.
    this.modTap = ctx.createGain();
    this.modTap.gain.value = 1;
    smooth.connect(this.modTap);

    this.osc.start();
  }

  /**
   * Wire this LFO to its own `<prefix>.*` params — the house pattern (ADR-008,
   * as `Effect.bind(bus, prefix)`). Called once per LFO from
   * `Engine.subscribeParams()`, which necessarily runs after `init()` has built
   * the shared `PwmDriver`.
   *
   * `modWheelId` is passed for **LFO 1 only** (lfo.md REQ-the-mod-wheel-feeds-lfo-one-only): the wheel is a
   * performance gesture with one meaning, and opening a second unrelated
   * modulation with it would be one gesture with two outcomes (ADR-014 law 2).
   *
   * `src` is this LFO's index into the shared pulse driver. `dest` is subscribed
   * first so the driver knows who wants it before any rate/wave/amount arrives;
   * `subscribe` fires synchronously, so no tick can land mid-sequence.
   */
  bind(
    bus: ParamBus,
    prefix: string,
    pulse: LfoPulseSink | null,
    src: number,
    modWheelId?: string,
  ): void {
    const applyDest = (x: number): void => {
      this.setDest(x);
      pulse?.setDest(src, x);
    };
    const applyAmount = (): void => {
      const base = bus.get(`${prefix}.amount`);
      const a = modWheelId === undefined ? base : Math.min(1, base + bus.get(modWheelId));
      this.setAmount(a);
      pulse?.setAmount(src, a);
    };
    const applyWave = (x: number): void => {
      this.setWave(x);
      pulse?.setWave(src, x);
    };

    bus.subscribe(`${prefix}.dest`, applyDest);
    // Rate, tempo lock and BPM, in one place shared with the FX (tempo-lock.md
    // REQ-audio-resolves-the-lock-in-one-place). PWM rides the same effective rate (REQ-pulse-destination-sweeps-width/REQ-pulse-is-arbitrated), so it is driven
    // from the same callback rather than from a second subscription that could
    // disagree with this one.
    bindTempoLocked(bus, `${prefix}.rate`, `${prefix}.sync`, 'freq', (hz) => {
      this.setRate(hz);
      pulse?.setRate(src, hz);
    });
    bus.subscribe(`${prefix}.wave`, applyWave);
    bus.subscribe(`${prefix}.amount`, applyAmount);
    if (modWheelId !== undefined) bus.subscribe(modWheelId, applyAmount);
  }

  setRate(hz: number): void {
    rampTo(this.osc.frequency, hz, this.ctx, RAMP_MEDIUM);
  }

  setWave(idx: number): void {
    const t = WAVE_TYPES[Math.max(0, Math.min(WAVE_TYPES.length - 1, Math.round(idx)))];
    if (t) this.osc.type = t;
  }

  setAmount(a: number): void {
    this.amount = clamp01(a);
    this.update();
  }

  setDest(d: number): void {
    this.dest = Math.round(d);
    this.update();
  }

  /** Open the selected destination at `amount` × its scale and close the rest. The
   *  depths are `LFO_DEST_SCALE`, the table the knob arcs are drawn from. */
  private update(): void {
    for (const [node, dest, scale] of this.outputs) {
      rampTo(node.gain, this.dest === dest ? this.amount * scale : 0, this.ctx, RAMP_MEDIUM);
    }
  }
}
