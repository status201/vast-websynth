import { syncedRateHz } from '../utils/tempo';
import type { ParamBus } from '../state/params';
import { rampTo, RAMP_MEDIUM } from './param-utils';

const WAVE_TYPES: OscillatorType[] = ['sine', 'triangle', 'sawtooth', 'square'];

/**
 * The slice of `PwmDriver` an LFO is allowed to drive (oscillators.md REQ-8).
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
}

/** Control-signal smoothing for the amplitude-domain outputs (lfo.md REQ-5).
 *  Q = 0.5 is critically damped — a step settles without overshoot, so the
 *  smoothed depth never exceeds the depth that was asked for. */
const SMOOTH_HZ = 200;
const SMOOTH_Q = 0.5;

/**
 * A global LFO. Exposes five pre-scaled output nodes: pitch (cents), cutoff
 * (semitones), amp (linear), pan (-1..1), shape (pole mix). Only the active
 * destination's gain is non-zero — the others are silent. Voices connect
 * pitch/cutoff/amp/shape to the matching AudioParam (osc detune, filter
 * cutoffNote, tremolo gain, filter shape); Engine connects pan to the synth bus
 * panner.
 *
 * `Engine` builds **two** of these (lfo.md REQ-10). Nothing here is shared or
 * static, and every output lands on a summing AudioParam, so two instances on
 * one destination simply add (REQ-13). The single exception is `Pulse`, which is
 * a parameter write and has to be arbitrated — see `bind` and `PwmDriver`.
 *
 * `Pulse` is the fifth destination and has **no output node here**: a native
 * OscillatorNode has no width AudioParam to drive, so it is handled by
 * `PwmDriver` from a JS-side mirror of this shape (oscillators.md REQ-8). Its
 * only effect on this class is that `update()` silences everything.
 *
 * `amp`, `pan` and `shape` are fed through a lowpass, `pitch` and `cutoff` are
 * not (lfo.md REQ-5/REQ-7): on a square/saw waveform a stepped *gain* is a
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
  /** Unit-amplitude tap for the mod matrix — see the constructor. */
  readonly modTap: GainNode;

  private readonly osc: OscillatorNode;
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
    this.toPitch.gain.value = 0;
    this.toCutoff.gain.value = 0;
    this.toAmp.gain.value = 0;
    this.toPan.gain.value = 0;
    this.toShape.gain.value = 0;

    // Frequency-domain destinations: straight off the oscillator.
    this.osc.connect(this.toPitch);
    this.osc.connect(this.toCutoff);

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
    // each matrix route carries its own depth (mod-matrix.md REQ-8). Taken from the
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
   * `modWheelId` is passed for **LFO 1 only** (lfo.md REQ-11): the wheel is a
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
    const applyRate = (): void => {
      // Tempo-locked while `sync` names a division, else the knob's own rate.
      // The knob value is never rewritten (lfo.md REQ-9).
      const hz =
        syncedRateHz(bus.get(`${prefix}.sync`), bus.get('transport.bpm')) ??
        bus.get(`${prefix}.rate`);
      this.setRate(hz);
      pulse?.setRate(src, hz);
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
    bus.subscribe(`${prefix}.rate`, applyRate);
    bus.subscribe(`${prefix}.sync`, applyRate);
    bus.subscribe(`${prefix}.wave`, applyWave);
    bus.subscribe(`${prefix}.amount`, applyAmount);
    if (modWheelId !== undefined) bus.subscribe(modWheelId, applyAmount);
    // A tempo-locked LFO tracks the tempo, including a slave's incoming clock.
    // A no-op while `sync` is free.
    bus.subscribe('transport.bpm', applyRate);
  }

  setRate(hz: number): void {
    rampTo(this.osc.frequency, hz, this.ctx, RAMP_MEDIUM);
  }

  setWave(idx: number): void {
    const t = WAVE_TYPES[Math.max(0, Math.min(WAVE_TYPES.length - 1, Math.round(idx)))];
    if (t) this.osc.type = t;
  }

  setAmount(a: number): void {
    this.amount = Math.max(0, Math.min(1, a));
    this.update();
  }

  setDest(d: number): void {
    this.dest = Math.round(d);
    this.update();
  }

  private update(): void {
    // Pitch: ±1200 cents (one octave) at full depth
    rampTo(this.toPitch.gain, this.dest === LfoDest.Pitch ? this.amount * 1200 : 0, this.ctx, RAMP_MEDIUM);
    // Cutoff: ±24 semitones (two octaves) at full depth
    rampTo(this.toCutoff.gain, this.dest === LfoDest.Cutoff ? this.amount * 24 : 0, this.ctx, RAMP_MEDIUM);
    // Amp: ±50% modulation at full depth (added to tremolo VCA's base 1.0)
    rampTo(this.toAmp.gain, this.dest === LfoDest.Amp ? this.amount * 0.5 : 0, this.ctx, RAMP_MEDIUM);
    // Pan: ±1.0 — hard L↔R at full depth. StereoPannerNode.pan clamps to ±1,
    // so this stays bounded whatever the amount (lfo.md REQ-4).
    rampTo(this.toPan.gain, this.dest === LfoDest.Pan ? this.amount : 0, this.ctx, RAMP_MEDIUM);
    // Shape: ±0.5 of the POLY pole-mix morph at full depth, summed onto the
    // knob's position. A no-op under the LADDER model, which ignores shape
    // (filter-models.md REQ-7).
    rampTo(this.toShape.gain, this.dest === LfoDest.Shape ? this.amount * 0.5 : 0, this.ctx, RAMP_MEDIUM);
  }
}
