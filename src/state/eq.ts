/**
 * The equalizer's band table and its frequency response — see
 * `specs/features/equalizer.md`.
 *
 * Pure: no DOM, no `AudioContext`, no `ParamBus` state of its own. That matters
 * because **both layers import it** — `audio/effects/eq.ts` builds its filters
 * from `EQ_BANDS`, and `ui/components/eq-graph.ts` draws its curve from the same
 * table through `eqResponseDb`. One source, so what you see and what you hear
 * cannot disagree about where a band is or what it does. Same role
 * `state/meter.ts` plays for the grid and `state/tempo-lock.ts` for the sync
 * table.
 */
import type { ParamBus } from './params';

/** One fixed band of the graphic EQ (equalizer.md REQ-eight-fixed-eq-bands). */
export interface EqBand {
  hz: number;
  type: BiquadFilterType;
  /** Short label under the band's column in the graph. */
  label: string;
}

/**
 * Eight fixed bands: a low shelf, six peaks, a high shelf.
 *
 * The centres are not a geometric series — they are placed so that **every zone
 * the Spectrum names has a band sitting inside it** (`SPECTRUM_ZONES` in
 * `ui/components/scope.ts`: MUD 100-200, BOXY 300-500, NASAL 800-1000, HARSH
 * 4000-6000). That is what lets a player read a problem off the analyser and
 * reach for the band directly above it, and it is what makes the four "De-…"
 * presets in `eq-presets.ts` mean something rather than being arbitrary dips.
 *
 * Shelves at the ends rather than peaks: a peak at 60 Hz leaves everything below
 * it untouched, which is the opposite of what "less rumble" means, and the same
 * at the top for "more air".
 */
export const EQ_BANDS: readonly EqBand[] = [
  { hz: 60, type: 'lowshelf', label: 'SUB' },
  { hz: 150, type: 'peaking', label: 'MUD' },
  { hz: 400, type: 'peaking', label: 'BOX' },
  { hz: 900, type: 'peaking', label: 'NASAL' },
  { hz: 2000, type: 'peaking', label: 'PRES' },
  { hz: 5000, type: 'peaking', label: 'HARSH' },
  { hz: 8000, type: 'peaking', label: 'SIB' },
  { hz: 12000, type: 'highshelf', label: 'AIR' },
];

export const EQ_BAND_COUNT = EQ_BANDS.length;

/** Symmetric band range, in dB. */
export const EQ_GAIN_MAX = 18;

/**
 * The highpass and lowpass **references**, in Hz. Written to `frequency` once at
 * construction and never again: the knobs ride `detune` in cents instead
 * (equalizer.md REQ-a-real-highpass-and-lowpass, the rule `effects.md` REQ-the-wah-lfo-sweeps-in-cents and `performance.md` REQ-the-dj-sweep-rides-detune
 * already impose). A linear-Hz write can walk a biquad onto the `AudioParam`
 * floor where it degenerates; cents cannot reach zero.
 */
export const EQ_HP_REF = 20;
export const EQ_LP_REF = 20000;

/**
 * The HP/LP shape, matching `djLow`/`djHigh` so the two swept filters in the app
 * are the same filter. **This number is in decibels**, not a linear Q — see
 * `eqStageCoeffs` below for why that distinction is load-bearing here.
 */
export const EQ_FILTER_Q_DB = 0.7;

export const EQ_WIDTH_DEFAULT = 1;

/** Everything the response math (and so the drawing) needs about one lane. */
export interface EqSettings {
  /** dB per band, length `EQ_BAND_COUNT`. */
  gains: readonly number[];
  /** The shared peaking Q (equalizer.md REQ-one-q-knob-over-the-bands). */
  width: number;
  /** Highpass corner in Hz; `EQ_HP_REF` is open. */
  hp: number;
  /** Lowpass corner in Hz; `EQ_LP_REF` is open. */
  lp: number;
}

/**
 * A frequency expressed as a `detune` offset from a fixed reference. This is the
 * whole of the "sweep in cents" rule — the caller writes the result to `detune`
 * and never touches `frequency`.
 */
export function detuneCents(targetHz: number, refHz: number): number {
  if (!(targetHz > 0) || !(refHz > 0)) return 0;
  return 1200 * Math.log2(targetHz / refHz);
}

/**
 * Every id that can change a lane's *curve* — the eight bands plus the two
 * filters and WIDTH, but **not** `.on`, which changes whether the curve is heard
 * rather than what it is.
 *
 * One list, because two consumers need exactly this set and for the same reason:
 * the graph subscribes it to know when to repaint, and the panel subscribes it
 * to keep the preset name and the tab lamp honest. They had a copy each, and one
 * of them counted the bands with a literal `8`.
 */
export function eqCurveParamIds(prefix: string): string[] {
  const ids = [`${prefix}.hp`, `${prefix}.lp`, `${prefix}.width`];
  for (let i = 0; i < EQ_BAND_COUNT; i++) ids.push(`${prefix}.b${i}`);
  return ids;
}

/** Read one lane's settings off the bus, in the shape the math wants. */
export function readEqSettings(bus: ParamBus, prefix: string): EqSettings {
  const gains: number[] = [];
  for (let i = 0; i < EQ_BAND_COUNT; i++) gains.push(bus.get(`${prefix}.b${i}`));
  return {
    gains,
    width: bus.get(`${prefix}.width`),
    hp: bus.get(`${prefix}.hp`),
    lp: bus.get(`${prefix}.lp`),
  };
}

/**
 * Is this lane engaged but doing nothing? Drives the tab lamp's middle state
 * (equalizer.md REQ-the-eq-tab-led-only-indicates) — an EQ that is on and flat is otherwise invisible.
 */
export function eqIsFlat(s: EqSettings): boolean {
  if (s.hp > EQ_HP_REF || s.lp < EQ_LP_REF) return false;
  return s.gains.every((g) => Math.abs(g) < 0.05);
}

/**
 * Squared magnitude of one biquad at angular frequency `w`, from its six
 * coefficients. `H(z) = (b0 + b1 z^-1 + b2 z^-2) / (a0 + a1 z^-1 + a2 z^-2)`
 * evaluated at `z = e^(jw)`, so `z^-1 = cos w - j sin w`.
 */
function magSq(
  b0: number, b1: number, b2: number,
  a0: number, a1: number, a2: number,
  w: number,
): number {
  const c1 = Math.cos(w), s1 = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nRe = b0 + b1 * c1 + b2 * c2, nIm = -(b1 * s1 + b2 * s2);
  const dRe = a0 + a1 * c1 + a2 * c2, dIm = -(a1 * s1 + a2 * s2);
  const den = dRe * dRe + dIm * dIm;
  return den === 0 ? 0 : (nRe * nRe + nIm * nIm) / den;
}

/** One biquad stage, as `[b0, b1, b2, a0, a1, a2]` — un-normalised. */
export type BiquadCoeffs = [b0: number, b1: number, b2: number, a0: number, a1: number, a2: number];

/**
 * One stage's six coefficients.
 *
 * These are the **Web Audio API's own** formulas, not a model of them —
 * `BiquadFilterNode` is specified in terms of the RBJ cookbook, so computing the
 * same formulas here gives the same filter and the drawn curve is exact rather
 * than approximate (equalizer.md REQ-the-drawn-curve-is-exact).
 *
 * The one trap, and the reason each case is written out rather than sharing a
 * single `alpha`: **`Q` does not mean the same thing for every type.** For
 * `peaking` it is a linear Q, `alpha = sin(w0) / (2Q)`. For `lowpass` and
 * `highpass` the spec interprets it **in decibels**, `alpha = sin(w0) /
 * (2 * 10^(Q/20))` — so a `Q.value` of 0.7 is a mildly resonant filter, not a
 * Butterworth one. And `lowshelf`/`highshelf` ignore `Q` altogether, using a
 * fixed slope `S = 1`, which is why WIDTH cannot move them (REQ-one-q-knob-over-the-bands).
 *
 * Exported so the closed form can be checked against the filter these numbers
 * actually *are*: `tests/state/eq.test.ts` runs the difference equation from
 * them and takes a DFT of the impulse response — an independent route to the
 * same answer, which catches a sign slip or a mistaken `alpha`. Whether the
 * browser's biquad uses these coefficients at all is the other half, and only
 * `e2e/equalizer.spec.ts` can ask a real `BiquadFilterNode` that.
 */
export function eqStageCoeffs(
  type: BiquadFilterType,
  f0: number,
  qOrQdb: number,
  gainDb: number,
  sampleRate: number,
): BiquadCoeffs {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);

  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

  if (type === 'peaking') {
    const alpha = sw / (2 * qOrQdb);
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else if (type === 'lowshelf') {
    // S = 1, so the radical collapses to sqrt(2) — the shelf's slope is fixed.
    const alpha = (sw / 2) * Math.SQRT2;
    const sa = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) - (A - 1) * cw + sa);
    b1 = 2 * A * ((A - 1) - (A + 1) * cw);
    b2 = A * ((A + 1) - (A - 1) * cw - sa);
    a0 = (A + 1) + (A - 1) * cw + sa;
    a1 = -2 * ((A - 1) + (A + 1) * cw);
    a2 = (A + 1) + (A - 1) * cw - sa;
  } else if (type === 'highshelf') {
    const alpha = (sw / 2) * Math.SQRT2;
    const sa = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cw + sa);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - sa);
    a0 = (A + 1) - (A - 1) * cw + sa;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - sa;
  } else if (type === 'lowpass') {
    const alpha = sw / (2 * Math.pow(10, qOrQdb / 20)); // Q in dB — see above
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'highpass') {
    const alpha = sw / (2 * Math.pow(10, qOrQdb / 20)); // Q in dB — see above
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  }

  return [b0, b1, b2, a0, a1, a2];
}

/** One stage's magnitude at `hz`, in dB. */
function stageResponseDb(
  type: BiquadFilterType,
  f0: number,
  qOrQdb: number,
  gainDb: number,
  hz: number,
  sampleRate: number,
): number {
  const [b0, b1, b2, a0, a1, a2] = eqStageCoeffs(type, f0, qOrQdb, gainDb, sampleRate);
  const m2 = magSq(b0, b1, b2, a0, a1, a2, (2 * Math.PI * hz) / sampleRate);
  // -200 dB is well past anything the ±18 dB axis can draw, and keeps a
  // log of zero out of the caller's sum.
  return m2 <= 1e-20 ? -200 : 10 * Math.log10(m2);
}

/**
 * The whole lane's response at one frequency, in dB: the ten stages in series,
 * which in dB is a sum. Stages that are exactly no-ops are skipped — that is
 * most of them most of the time, since the EQ ships flat.
 */
export function eqResponseDb(s: EqSettings, hz: number, sampleRate: number): number {
  const nyquist = sampleRate / 2;
  // A biquad's response is only defined below Nyquist; clamp rather than let the
  // caller draw wrap-around nonsense at the right edge on a 44.1k context.
  const f = hz >= nyquist ? nyquist * 0.999 : hz;
  let db = 0;
  if (s.hp > EQ_HP_REF) db += stageResponseDb('highpass', s.hp, EQ_FILTER_Q_DB, 0, f, sampleRate);
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    const g = s.gains[i] ?? 0;
    if (g === 0) continue;
    const band = EQ_BANDS[i]!;
    db += stageResponseDb(band.type, band.hz, s.width, g, f, sampleRate);
  }
  if (s.lp < EQ_LP_REF) db += stageResponseDb('lowpass', s.lp, EQ_FILTER_Q_DB, 0, f, sampleRate);
  return db;
}

