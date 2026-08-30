import { WrappedEffect, bindBypassMix } from './effect';
import { clamp01, midiToHz } from '../../utils/math';
import { RAMP_SMOOTH } from '../param-utils';
import { bindTempoLocked } from '../tempo-bind';
import type { ParamBus } from '../../state/params';

/** The sweep's fixed pivot: MIDI 75 = D#5 = 622.25 Hz. */
const CENTER_NOTE = 75;
const CENTER_HZ = midiToHz(CENTER_NOTE);
/**
 * The upward reach at full depth, as the linear-Hz mapping expressed it. Kept
 * only so `depthCents` can reproduce that top exactly — see REQ-11.
 */
const SWEEP_TOP_HZ = 1500;
/**
 * Makeup for the bandpass's insertion loss (effects.md REQ-12). A
 * constant-peak-gain bandpass passes a share of a broadband signal proportional
 * to its bandwidth `f0 / Q`, so the loss goes as `1/sqrt(Q)` and this as
 * `sqrt(Q)`. `2.5` calibrates it against the measured drop — +14 dB at the
 * default Q of 4, +5 dB at the minimum of 0.5.
 */
const MAKEUP_K = 2.5;
/**
 * Ceiling on that, x8 = +18 dB. Above it a narrow band with material sitting on
 * the centre frequency — where the filter is already at unity — would push the
 * master hard for no musical gain.
 */
const MAKEUP_MAX = 8;

/**
 * The bandpass's makeup gain at a given Q (effects.md REQ-12). Exported so the
 * spec's numbers can be pinned without reaching into a private field.
 */
export function makeupFor(q: number): number {
  return Math.min(MAKEUP_MAX, MAKEUP_K * Math.sqrt(Math.max(0, q)));
}

export class Wah extends WrappedEffect {
  private readonly bp: BiquadFilterNode;
  private readonly lfo: OscillatorNode;
  private readonly lfoDepth: GainNode;
  private readonly makeup: GainNode;

  private depth = 0.6;

  constructor(ctx: AudioContext) {
    super(ctx, 1);

    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    // Written once and never again: the sweep rides `detune` (REQ-11).
    this.bp.frequency.value = CENTER_HZ;
    this.bp.Q.value = 4;

    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 1.5;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = this.depthCents();

    this.lfo.connect(this.lfoDepth).connect(this.bp.detune);
    this.lfo.start();

    this.makeup = ctx.createGain();
    this.makeup.gain.value = makeupFor(this.bp.Q.value);

    this.wrap.processedIn.connect(this.bp).connect(this.makeup).connect(this.wrap.processedOut);
  }

  setRate(hz: number): void {
    this.lfo.frequency.setTargetAtTime(hz, this.ctx.currentTime, RAMP_SMOOTH);
  }
  setDepth(d: number): void {
    this.depth = clamp01(d);
    this.lfoDepth.gain.setTargetAtTime(this.depthCents(), this.ctx.currentTime, RAMP_SMOOTH);
  }
  setQ(q: number): void {
    this.bp.Q.setTargetAtTime(q, this.ctx.currentTime, RAMP_SMOOTH);
    // A narrower band throws away more of the signal, so the makeup tracks it
    // rather than being a fixed trim (REQ-12).
    this.makeup.gain.setTargetAtTime(makeupFor(q), this.ctx.currentTime, RAMP_SMOOTH);
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this); // no setMix — the wah has no dry/wet
    bindTempoLocked(bus, `${prefix}.rate`, `${prefix}.sync`, 'freq', (x) => this.setRate(x));
    bus.subscribe(`${prefix}.depth`, (x) => this.setDepth(x));
    bus.subscribe(`${prefix}.q`, (x) => this.setQ(x));
  }

  /**
   * The LFO's swing, in **cents** (effects.md REQ-11, ADR-005). The v1 mapping
   * was `depth * 1500` linear Hz around a 622 Hz centre, which at depth >= 0.415
   * drove the computed `bp.frequency` to the AudioParam's 0 Hz floor — where a
   * bandpass has `alpha = 0`, an all-zero numerator and a double pole at z = 1,
   * measured as a ~10x jump in single-sample step and the burst detector firing.
   * Cents cannot reach zero.
   *
   * The curve is the cents equivalent of that old *upward* excursion, so the top
   * of every stored song's sweep is exactly where it was and only the bottom
   * moves — 22 Hz becomes 317 Hz at the default depth of 0.4.
   */
  private depthCents(): number {
    return 1200 * Math.log2(1 + this.depth * SWEEP_TOP_HZ / CENTER_HZ);
  }
}
