import { WrappedEffect, bindBypassMix } from './effect';
import { memoizeDriveCurve } from '../drive-curve';
import { RAMP_SMOOTH } from '../param-utils';
import { dirtTypeOf } from '../../state/dirt';
import type { ParamBus } from '../../state/params';
import type { DirtSwitch } from './dirt-switch';

function buildTanhCurve(amount: number, samples = 2048): Float32Array<ArrayBuffer> {
  const k = 1 + amount * 50;
  const curve = new Float32Array(new ArrayBuffer(samples * Float32Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

/** One filter around the clipper. `q` is dB for a highpass, linear for a peaking, ignored by a shelf. */
export interface BiquadSpec { type: BiquadFilterType; hz: number; q: number; db: number }

/**
 * Everything a TYPE is (dirt-types.md REQ-every-type-is-one-voicing). The
 * tuples bound what the biquad pool has to hold: one before the shaper, two
 * after it.
 */
export interface Voicing {
  curve(amount: number): Float32Array<ArrayBuffer>;
  preGain(amount: number): number;
  postGain(amount: number): number;
  pre: readonly [] | readonly [BiquadSpec];
  post: readonly [] | readonly [BiquadSpec] | readonly [BiquadSpec, BiquadSpec];
}

/**
 * DISTORTION: the original laws, curve and graph (REQ-distortion-is-the-unchanged-dirt).
 * Curves are bucketed + shared across every Dirt instance — see drive-curve.ts.
 * The other voicings live in `dirt-voicings.ts`, imported on first choice.
 */
export const DISTORTION_VOICING: Voicing = {
  curve: memoizeDriveCurve((amount) => buildTanhCurve(amount)),
  preGain: (amount) => 1 + amount * 8,
  postGain: (amount) => 1 / (1 + amount * 1.5),
  pre: [],
  post: [],
};

/** Dirt's own nodes: what a voicing drives, handed to the switch once it is in. */
export interface DirtNodes {
  preGain: GainNode;
  shaper: WaveShaperNode;
  tone: BiquadFilterNode;
  postGain: GainNode;
}

/**
 * Drive `n` with `v` at `amount` — `Dirt` at DISTORTION and `DirtSwitch` at
 * every type. The gains track `amount` continuously (that is what makes a drag
 * sound smooth); only the table is bucketed, and re-assigning the same one is
 * skipped outright. `post` false leaves the make-up gain where a type swap's
 * dip holds it.
 */
export function applyDrive(ctx: BaseAudioContext, n: DirtNodes, v: Voicing, amount: number, post = true): void {
  n.preGain.gain.setTargetAtTime(v.preGain(amount), ctx.currentTime, RAMP_SMOOTH);
  const curve = v.curve(amount);
  if (n.shaper.curve !== curve) n.shaper.curve = curve;
  if (post) n.postGain.gain.setTargetAtTime(v.postGain(amount), ctx.currentTime, RAMP_SMOOTH);
}

/** The switch's module, imported once for every Dirt; a failure is forgotten. */
let switchModule: Promise<typeof import('./dirt-switch')> | null = null;

/**
 * The drive effect (dirt-types.md). It boots as DISTORTION, the effect as it
 * always was, and stays that alone until another TYPE is chosen: that choice
 * imports `DirtSwitch` (REQ-the-other-dirt-types-load-on-first-use), which from
 * then on takes TYPE and DRIVE while this class forwards them.
 */
export class Dirt extends WrappedEffect {
  private readonly nodes: DirtNodes;
  private drive = 0.3;
  /** The last TYPE written: what the switch starts from once it is in. */
  private type = 0;
  private quiesced = false;
  private sw: DirtSwitch | null = null;
  private loading: Promise<void> | null = null;

  constructor(ctx: AudioContext, opts?: { oversample?: boolean }) {
    super(ctx, 1);

    const preGain = ctx.createGain();
    preGain.gain.value = 1;

    const shaper = ctx.createWaveShaper();
    shaper.curve = DISTORTION_VOICING.curve(0.3);
    // Weak perf tiers skip the 4× up/down-sampling (performance-mode.md REQ-weak-tier-reduces-fx-cost).
    shaper.oversample = opts?.oversample === false ? 'none' : '4x';

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3000;
    tone.Q.value = 0.7;

    const postGain = ctx.createGain();
    postGain.gain.value = 0.7;

    this.nodes = { preGain, shaper, tone, postGain };
    this.wrap.processedIn
      .connect(preGain)
      .connect(shaper)
      .connect(tone)
      .connect(postGain)
      .connect(this.wrap.processedOut);
  }

  setMix(m: number): void { this.wrap.setMix(m); }
  setDrive(amount: number): void {
    this.drive = amount;
    if (this.sw) this.sw.setDrive(amount);
    else applyDrive(this.ctx, this.nodes, DISTORTION_VOICING, amount);
  }
  setTone(hz: number): void {
    this.nodes.tone.frequency.setTargetAtTime(hz, this.ctx.currentTime, RAMP_SMOOTH);
  }
  /** REQ-a-dirt-type-switch-is-click-free; DISTORTION needs no switch until another type has been chosen. */
  setType(v: number): void {
    this.type = v;
    if (this.sw) this.sw.setType(v);
    else if (dirtTypeOf(v) !== 'distortion') this.load();
  }

  protected override quiesce(on: boolean): void {
    this.quiesced = on;
    this.sw?.quiesce(on);
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    bus.subscribe(`${prefix}.drive`, (x) => this.setDrive(x));
    bus.subscribe(`${prefix}.tone`, (x) => this.setTone(x));
    bus.subscribe(`${prefix}.type`, (x) => this.setType(x));
    // A failed load retries on switch-on too: the bus ignores a write of the
    // value it already holds, so re-picking the type could not.
    bus.subscribe(`${prefix}.on`, (x) => { if (x >= 0.5) this.setType(bus.get(`${prefix}.type`)); });
  }

  /**
   * Import the switch once (REQ-the-other-dirt-types-load-on-first-use). Until it
   * is in, Dirt keeps sounding as DISTORTION; a failure is logged and leaves it
   * so, and the next choice or switch-on retries.
   */
  private load(): void {
    if (this.loading) return;
    this.loading = (switchModule ??= import('./dirt-switch'))
      .then((m) => {
        this.sw = new m.DirtSwitch(this.ctx, this.nodes, this.drive, this.quiesced);
        this.sw.setType(this.type);
      })
      .catch((err: unknown) => {
        switchModule = null;
        console.warn('[dirt] types failed to load', err);
      })
      .finally(() => { this.loading = null; });
  }
}
