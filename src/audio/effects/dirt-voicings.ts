import { DISTORTION_VOICING, type BiquadSpec, type Voicing } from './dirt';
import { BUTTERWORTH_Q_DB } from './effect';
import { memoizeDriveCurve } from '../drive-curve';
import type { DirtType } from '../../state/dirt';

/**
 * Dirt's other TYPEs, imported with `DirtSwitch` on their first choice
 * (dirt-types.md REQ-the-other-dirt-types-load-on-first-use), and the biquad
 * pool that wires them around the shaper (REQ-every-type-is-one-voicing).
 */

/**
 * Tabulate `f` over [-1, 1] and normalize it to max |y| = 1. `f(0)` must be 0,
 * so silence in is silence out (REQ-every-dirt-type-is-bounded). DISTORTION
 * keeps its own builder, untouched, so type 0 renders the table it always did.
 */
function tabulate(f: (x: number) => number, samples = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(samples * Float32Array.BYTES_PER_ELEMENT));
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const y = f((i / (samples - 1)) * 2 - 1);
    curve[i] = y;
    peak = Math.max(peak, Math.abs(y));
  }
  if (peak > 0) for (let i = 0; i < samples; i++) curve[i] = curve[i]! / peak;
  return curve;
}

/** A cubic soft clip: a harder knee than `tanh`, flat past ±1. */
function cubicClip(u: number): number {
  return u >= 1 ? 1 : u <= -1 ? -1 : 1.5 * u - 0.5 * u * u * u;
}

/** Zero below `d`, the rest rescaled to keep ±1 at ±1 — FUZZ's sputter. */
function deadZone(x: number, d: number): number {
  const m = Math.abs(x) - d;
  return m <= 0 ? 0 : Math.sign(x) * (m / (1 - d));
}

/** OVERDRIVE's curve steepness; the rest of its gain is the pre-gain. */
function odKnee(amount: number): number {
  return 3 + amount * 3;
}

/** The asymmetric curves' DC, removed so a bypass never thumps (REQ-every-dirt-type-is-bounded). */
const DC_BLOCK: BiquadSpec = { type: 'highpass', hz: 20, q: BUTTERWORTH_Q_DB, db: 0 };

/**
 * One voicing per `DIRT_TYPES` row — the `Record` makes the compiler demand it.
 * The constants are the spec's (REQ-overdrive-voicing, REQ-fuzz-voicing), set by
 * ear (REQ-every-dirt-type-is-heard).
 */
export const VOICINGS: Record<DirtType, Voicing> = {
  distortion: DISTORTION_VOICING,
  // The synth reaches the drive near -35 dBFS, so the gain into the knee is what
  // sets the character: 5x (nearly clean) to 100x (heavy), exponential across the
  // knob. The level rises with DRIVE, as a real overdrive's gain knob does.
  overdrive: {
    curve: memoizeDriveCurve((amount) => {
      const k = odKnee(amount), c = 0.4;
      return tabulate((x) => Math.tanh(k * x + c) - Math.tanh(c));
    }),
    preGain: (amount) => (5 * Math.pow(20, amount)) / odKnee(amount),
    postGain: () => 0.65,
    // Drive the bass less, then give most of it back: tight, not thin.
    pre: [{ type: 'lowshelf', hz: 250, q: 0, db: -6 }],
    post: [DC_BLOCK, { type: 'lowshelf', hz: 250, q: 0, db: 3 }],
  },
  fuzz: {
    curve: memoizeDriveCurve((amount) => {
      const k = 4 + amount * 36, c = 0.3;
      return tabulate((x) => cubicClip(k * deadZone(x, 0.015) + c) - cubicClip(c));
    }),
    preGain: (amount) => 1 + amount * 4,
    postGain: (amount) => 1.2 / (1 + amount),
    pre: [],
    post: [DC_BLOCK, { type: 'peaking', hz: 900, q: 0.7, db: -6 }],
  },
};

/** A type's (shared, memoized) table at `amount` — what its shaper is handed. */
export function dirtCurve(type: DirtType, amount: number): Float32Array<ArrayBuffer> {
  return VOICINGS[type].curve(amount);
}

/**
 * The biquad pool and the rewire. `route` wires `preGain → pre… → shaper →
 * post… → tone` and leaves every pool node its voicing does not list
 * disconnected, so it costs nothing (ADR-012).
 */
export class VoicingRouter {
  readonly pool: { pre: BiquadFilterNode[]; post: BiquadFilterNode[] };

  constructor(
    ctx: BaseAudioContext,
    private readonly preGain: AudioNode,
    private readonly shaper: AudioNode,
    private readonly tone: AudioNode,
  ) {
    this.pool = {
      pre: [ctx.createBiquadFilter()],
      post: [ctx.createBiquadFilter(), ctx.createBiquadFilter()],
    };
  }

  route(type: DirtType): Voicing {
    const v = VOICINGS[type];
    const { pre, post } = this.pool;
    this.preGain.disconnect();
    this.shaper.disconnect();
    for (const f of [...pre, ...post]) f.disconnect();
    const series: AudioNode[] = [
      this.preGain,
      ...v.pre.map((s, i) => configure(pre[i]!, s)),
      this.shaper,
      ...v.post.map((s, i) => configure(post[i]!, s)),
      this.tone,
    ];
    for (let i = 1; i < series.length; i++) series[i - 1]!.connect(series[i]!);
    return v;
  }
}

function configure(f: BiquadFilterNode, s: BiquadSpec): BiquadFilterNode {
  f.type = s.type;
  f.frequency.value = s.hz;
  f.Q.value = s.q;
  f.gain.value = s.db;
  return f;
}
