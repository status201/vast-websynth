import { WrappedEffect, bindBypassMix } from './effect';
import { RAMP_SMOOTH, rampTo } from '../param-utils';
import {
  EQ_BANDS, EQ_BAND_COUNT, EQ_FILTER_Q_DB, EQ_HP_REF, EQ_LP_REF, detuneCents,
} from '../../state/eq';
import type { ParamBus } from '../../state/params';

/**
 * How long the ten-filter span must be fed silence before it holds none of the
 * old audio (`effects.md` REQ-2c, equalizer.md REQ-7).
 *
 * `add-an-effect.md`: a biquad is only memoryless at *low* Q — its ring-down is
 * roughly `Q / (pi * f0)`. The worst case here is the 150 Hz band at the widest
 * WIDTH: `8 / (pi * 150)` is ~17 ms, already past `DRAIN_DEFAULT_S` (20 ms) once
 * it has been through a series of ten. 120 ms clears it with room to spare, and
 * costs nothing but a `setTimeout` on a bypass that has already faded out.
 */
const EQ_DRAIN_S = 0.12;

/**
 * The per-lane equalizer — `specs/features/equalizer.md`.
 *
 * Span: `processedIn -> hp -> b0..b7 -> lp -> processedOut`. Ten native
 * `BiquadFilterNode`s and **no worklet**, which is the whole of its answer to
 * ADR-010's *cheap*: the DSP is the browser's own SIMD C++, and ADR-012's true
 * bypass disconnects the lot while the effect is off, so a lane that never
 * switches its EQ on pays nothing at all.
 *
 * It declares **no `setMix`**. That absence is the declaration that the EQ has no
 * `.mix` param, exactly as it is for the wah and the compressors — `bindBypassMix`
 * keys off it (`effects.md` REQ-1). A dry/wet on an EQ would be a comb filter
 * with extra steps.
 */
export class Equalizer extends WrappedEffect {
  private readonly hp: BiquadFilterNode;
  private readonly lp: BiquadFilterNode;
  private readonly bands: BiquadFilterNode[] = [];

  constructor(ctx: AudioContext) {
    super(ctx, 1);

    // Highpass and lowpass bracket the bands. Their `frequency` is a fixed
    // REFERENCE, written here and never again: the knobs ride `detune` in cents
    // (equalizer.md REQ-3 — the rule performance.md REQ-10 and effects.md REQ-11
    // already impose on djLow/djHigh and the wah). `Q` is in dB for these two
    // types, which is why the constant says so in its name.
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = EQ_HP_REF;
    this.hp.Q.value = EQ_FILTER_Q_DB;

    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = EQ_LP_REF;
    this.lp.Q.value = EQ_FILTER_Q_DB;

    let node: AudioNode = this.wrap.processedIn;
    node = node.connect(this.hp);
    for (const band of EQ_BANDS) {
      const f = ctx.createBiquadFilter();
      f.type = band.type;
      // Band centres are fixed (equalizer.md REQ-2), so unlike the two filters
      // above these are written once because they genuinely never move — there
      // is no `detune` question to answer.
      f.frequency.value = band.hz;
      f.gain.value = 0;
      this.bands.push(f);
      node = node.connect(f);
    }
    node.connect(this.lp).connect(this.wrap.processedOut);
  }

  /** One band's gain, in dB. */
  setBand(i: number, db: number): void {
    const f = this.bands[i];
    if (!f) return;
    rampTo(f.gain, db, this.ctx, RAMP_SMOOTH);
  }

  /**
   * The shared peaking Q (equalizer.md REQ-4). Web Audio's shelving filters
   * ignore `Q` — they use a fixed slope `S = 1` — so writing it on them would be
   * a no-op that merely looked like a control. Only the peaks are touched, and
   * the graph draws them the same way.
   */
  setWidth(q: number): void {
    for (let i = 0; i < this.bands.length; i++) {
      if (EQ_BANDS[i]!.type !== 'peaking') continue;
      rampTo(this.bands[i]!.Q, q, this.ctx, RAMP_SMOOTH);
    }
  }

  setHighpass(hz: number): void {
    rampTo(this.hp.detune, detuneCents(hz, EQ_HP_REF), this.ctx, RAMP_SMOOTH);
  }

  setLowpass(hz: number): void {
    rampTo(this.lp.detune, detuneCents(hz, EQ_LP_REF), this.ctx, RAMP_SMOOTH);
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this); // no setMix — the EQ has no dry/wet
    bus.subscribe(`${prefix}.hp`, (x) => this.setHighpass(x));
    bus.subscribe(`${prefix}.lp`, (x) => this.setLowpass(x));
    bus.subscribe(`${prefix}.width`, (x) => this.setWidth(x));
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      const band = i; // capture, the way engine.ts does for its indexed families
      bus.subscribe(`${prefix}.b${band}`, (x) => this.setBand(band, x));
    }
  }

  protected override drainSeconds(): number {
    return EQ_DRAIN_S;
  }
}
