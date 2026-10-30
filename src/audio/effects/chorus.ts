import { WrappedEffect, bindBypassMix } from './effect';
import { clamp01 } from '../../utils/math';
import { RAMP_SMOOTH } from '../param-utils';
import type { ParamBus } from '../../state/params';
import { chorusModePreset } from '../../state/chorus';

/**
 * Where both taps rest, in seconds — the middle of the Juno's ~1.7..5.3 ms BBD
 * sweep (chorus.md REQ-the-chorus-is-two-antiphase-taps). Dialled by ear (ADR-010).
 */
export const CHORUS_CENTRE_S = 0.0035;
/** The swing at depth 1, before the floor clamps it. */
export const CHORUS_SWING_S = 0.003;
/** The shortest delay either tap may reach (chorus.md REQ-the-chorus-delay-never-reaches-zero). */
export const CHORUS_MIN_DELAY_S = 0.0005;
/** The BBD's darkening on the wet path — a lowpass ahead of both taps. */
export const CHORUS_TONE_HZ = 9000;

/**
 * The swing for a depth, in seconds: `depth * CHORUS_SWING_S`, clamped so
 * `CHORUS_CENTRE_S - swing` never drops under `CHORUS_MIN_DELAY_S`
 * (chorus.md REQ-the-chorus-delay-never-reaches-zero).
 */
export function chorusSwing(depth: number): number {
  return Math.min(clamp01(depth) * CHORUS_SWING_S, CHORUS_CENTRE_S - CHORUS_MIN_DELAY_S);
}

/**
 * A Juno-style stereo chorus (chorus.md): one mono delay line read by two taps
 * whose times a single triangle LFO sweeps in antiphase, one tap to each side.
 * No feedback path — nothing can run away.
 */
export class Chorus extends WrappedEffect {
  /** Null while bypassed and quiesced: a stopped oscillator cannot restart. */
  private lfo: OscillatorNode | null = null;
  /** The rate the LFO runs at, kept for the next one. */
  private rate = 0.5;
  /** `+swing` on the left tap's delayTime, `-swing` on the right's. */
  private readonly swingL: GainNode;
  private readonly swingR: GainNode;

  constructor(ctx: AudioContext) {
    super(ctx, 0.5);

    // One channel from here on: a stereo input (the sampler bus) is down-mixed
    // once, so both taps run mono (REQ-the-chorus-is-two-antiphase-taps).
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = CHORUS_TONE_HZ;
    tone.Q.value = Math.SQRT1_2;
    tone.channelCount = 1;
    tone.channelCountMode = 'explicit';

    const tapL = ctx.createDelay(0.02);
    const tapR = ctx.createDelay(0.02);
    tapL.delayTime.value = CHORUS_CENTRE_S;
    tapR.delayTime.value = CHORUS_CENTRE_S;

    this.swingL = ctx.createGain();
    this.swingR = ctx.createGain();
    const swing = chorusSwing(0.5);
    this.swingL.gain.value = swing;
    this.swingR.gain.value = -swing;
    this.swingL.connect(tapL.delayTime);
    this.swingR.connect(tapR.delayTime);
    this.startLfo();

    const merger = ctx.createChannelMerger(2);
    this.wrap.processedIn.connect(tone);
    tone.connect(tapL).connect(merger, 0, 0);
    tone.connect(tapR).connect(merger, 0, 1);
    merger.connect(this.wrap.processedOut);
  }

  setMix(m: number): void { this.wrap.setMix(m); }
  setRate(hz: number): void {
    this.rate = hz;
    this.lfo?.frequency.setTargetAtTime(hz, this.ctx.currentTime, RAMP_SMOOTH);
  }
  setDepth(d: number): void {
    const w = chorusSwing(d);
    const t = this.ctx.currentTime;
    this.swingL.gain.setTargetAtTime(w, t, RAMP_SMOOTH);
    this.swingR.gain.setTargetAtTime(-w, t, RAMP_SMOOTH);
  }

  /** Two taps of at most ~7 ms and a low-Q biquad (chorus.md REQ-the-chorus-drains-briefly). */
  protected override drainSeconds(): number { return 0.05; }

  /**
   * No loop to zero, but a started LFO keeps costing CPU unheard (ADR-012), so
   * a bypass stops it once the wet has faded, and the release starts a fresh
   * one before the wet ramps back. It starts at phase 0, the taps' rest, so
   * nothing steps (chorus.md REQ-the-chorus-drains-briefly).
   */
  protected override quiesce(on: boolean): void {
    if (on) {
      this.lfo?.stop();
      this.lfo?.disconnect();
      this.lfo = null;
    } else if (!this.lfo) {
      this.startLfo();
    }
  }

  private startLfo(): void {
    const lfo = this.ctx.createOscillator();
    lfo.type = 'triangle';
    lfo.frequency.value = this.rate;
    lfo.connect(this.swingL);
    lfo.connect(this.swingR);
    lfo.start();
    this.lfo = lfo;
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    // A mode ignores the knobs without touching them, so the stored rate and
    // depth return untouched at FREE (REQ-the-chorus-mode-overrides-rate-and-depth).
    const apply = (): void => {
      const preset = chorusModePreset(bus.get(`${prefix}.mode`));
      this.setRate(preset ? preset.rate : bus.get(`${prefix}.rate`));
      this.setDepth(preset ? preset.depth : bus.get(`${prefix}.depth`));
    };
    bus.subscribe(`${prefix}.rate`, apply);
    bus.subscribe(`${prefix}.depth`, apply);
    bus.subscribe(`${prefix}.mode`, apply);
  }
}
