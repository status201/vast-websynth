/**
 * The scratch curve: model, arithmetic and presets (scratch.md).
 *
 * Pure — plain values in, plain values out, no `AudioContext` and no DOM — so it
 * unit-tests under vitest+jsdom exactly like `buffer-dsp.ts`. It is a sibling of
 * `scratch.ts` rather than part of it because the *model* is shared with the
 * editor while the *reader* is not: the graph needs the position map on every
 * pointer move (scratch.md REQ-17) and must never pull the resampler in to get it.
 *
 * The user draws a **rate**, not a position (REQ-2). A turntablist thinks in
 * strokes — push, pull, push long — and rate is what makes the vertical axis mean
 * pitch, so dragging a point up is audibly "faster and higher". The needle's
 * position is the integral of that rate, and this module owns that integral.
 *
 * **The integral is closed-form per segment, never accumulated per sample**
 * (REQ-3). A ramp integrates to `(v0+v1)/2 · dt` and a hold to `v0 · dt`; both
 * are exact. The obvious shape — walk the output adding `v` each frame — drifts,
 * and drift here is a clip that misses the bar it was drawn against, which is the
 * one failure this feature exists to avoid.
 *
 * Units are deliberately unit-free. `positionAt` returns the integral in
 * *normalised output units*, so a caller converts with a single multiply:
 * `sourceFrame = cue·srcFrames + positionAt(t) · outFrames`. That works because
 * a rate is source-seconds per output-second, so integrating it over normalised
 * output time and scaling by the output's own length lands in source frames.
 */
import {
  MAX_SCRATCH_POINTS,
  MAX_SCRATCH_RATE,
  MAX_SCRATCH_STEPS,
} from '../../state/limits';

/** One breakpoint of a drawn scratch. */
export interface ScratchPoint {
  /** Position along the scratch, 0..1. Normalised, so a preset works at any length. */
  t: number;
  /** Playback rate: 1 forward at pitch, 0 stopped, negative backwards. */
  v: number;
  /** Crossfader closed from this point until the next. */
  cut: boolean;
  /** Segment shape to the next point: `false` ramps (a hand), `true` holds then jumps. */
  hold: boolean;
}

export interface ScratchCurve {
  /** Length in sixteenths — what locks the gesture to the tempo. */
  steps: number;
  /** Where the needle starts, as a fraction 0..1 of the source. */
  cue: number;
  /** Sorted by `t`, the first pinned at 0. */
  points: ScratchPoint[];
}

/** Length a curve falls back to when it arrives without a usable one. */
export const DEFAULT_SCRATCH_STEPS = 16;

/**
 * Non-finite is rejected *before* the clamp, not by it: the app-wide
 * `max(min, min(max, v))` idiom returns `NaN` for `NaN`
 * (untrusted-input.md REQ-6), so a bare clamp would let it straight through into
 * a length calculation.
 */
function clampNum(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return v < min ? min : v > max ? max : v;
}

/**
 * Put a curve in the shape every other function here assumes: finite, ordered,
 * bounded, and starting at `t = 0` (REQ-13/REQ-14). Total and idempotent — hand
 * it anything and a usable curve comes back.
 */
export function normalizeCurve(c: ScratchCurve): ScratchCurve {
  const steps = Math.round(
    clampNum(c?.steps as number, 1, MAX_SCRATCH_STEPS, DEFAULT_SCRATCH_STEPS),
  );
  const cue = clampNum(c?.cue as number, 0, 1, 0);

  const src = Array.isArray(c?.points) ? c.points : [];
  const pts: ScratchPoint[] = [];
  for (const p of src) {
    if (!p || !Number.isFinite(p.t) || !Number.isFinite(p.v)) continue;
    pts.push({
      t: clampNum(p.t, 0, 1, 0),
      v: clampNum(p.v, -MAX_SCRATCH_RATE, MAX_SCRATCH_RATE, 0),
      cut: p.cut === true,
      hold: p.hold === true,
    });
  }
  pts.sort((x, y) => x.t - y.t);

  // Nothing describes what happens before the first point, so a curve that does
  // not start at 0 gains a twin that holds its opening rate across the gap.
  // The editor pins its first point at 0, so this is a guard for hostile or
  // hand-written curves rather than a path the UI takes.
  const first = pts[0];
  if (first && first.t > 0) pts.unshift({ ...first, t: 0 });

  return { steps, cue, points: pts.slice(0, MAX_SCRATCH_POINTS) };
}

/**
 * A normalised curve with its per-segment integral already summed.
 *
 * Built once and walked, because the renderer asks for a position a hundred
 * thousand times and re-summing the prefix each time would be quadratic. Segment
 * `i` spans `t[i] .. t[i+1]`; there are `n` segments and `n+1` boundaries, the
 * last of which is always 1 — the tail holds the final point's rate to the end,
 * which is what makes a single-point curve mean "hold this rate throughout".
 */
export interface ScratchPlan {
  readonly steps: number;
  readonly cue: number;
  /** Segment boundaries, length `n+1`, ending at 1. */
  readonly t: Float64Array;
  /** Rate entering each segment, length `n`. */
  readonly v0: Float64Array;
  /** Rate leaving each segment (equal to `v0` for a hold, and for the tail). */
  readonly v1: Float64Array;
  /** Position at each boundary, length `n+1`. The prefix integral. */
  readonly p: Float64Array;
  /** Crossfader closed during each segment. */
  readonly cut: Uint8Array;
  /** Segment count. Zero means the curve had no usable points. */
  readonly n: number;
}

export function scratchPlan(c: ScratchCurve): ScratchPlan {
  const { steps, cue, points } = normalizeCurve(c);
  const n = points.length;
  const t = new Float64Array(n + 1);
  const v0 = new Float64Array(Math.max(0, n));
  const v1 = new Float64Array(Math.max(0, n));
  const p = new Float64Array(n + 1);
  const cut = new Uint8Array(Math.max(0, n));
  if (n === 0) return { steps, cue, t, v0, v1, p, cut, n: 0 };

  for (let i = 0; i < n; i++) {
    const cur = points[i]!;
    const next = points[i + 1];
    t[i] = cur.t;
    v0[i] = cur.v;
    // The tail has nothing to ramp towards, so it holds — as does any segment the
    // user marked `hold`, which is the instant pitch jump a transformer is made of.
    v1[i] = next && !cur.hold ? next.v : cur.v;
    cut[i] = cur.cut ? 1 : 0;
  }
  t[n] = 1;

  for (let i = 0; i < n; i++) {
    const dt = t[i + 1]! - t[i]!;
    // A zero-length segment (two points dropped on the same instant) contributes
    // nothing and must not divide: it is an instantaneous rate change, which is a
    // legitimate thing to draw.
    p[i + 1] = p[i]! + (dt > 0 ? ((v0[i]! + v1[i]!) * 0.5) * dt : 0);
  }
  return { steps, cue, t, v0, v1, p, cut, n };
}

/**
 * Which segment holds `t`. `hint` lets a forward walk start where it left off, so
 * the renderer pays O(1) per frame while a one-off lookup pays O(n) — the *same*
 * arithmetic either way, which is what keeps REQ-4 honest.
 */
export function segmentAt(plan: ScratchPlan, t: number, hint = 0): number {
  if (plan.n === 0) return -1;
  let i = hint > 0 && hint < plan.n ? hint : 0;
  if (t < plan.t[i]!) i = 0;
  while (i + 1 < plan.n && t >= plan.t[i + 1]!) i++;
  return i;
}

/** Rate inside a known segment. */
export function rateIn(plan: ScratchPlan, seg: number, t: number): number {
  if (seg < 0) return 0;
  const dt = plan.t[seg + 1]! - plan.t[seg]!;
  if (dt <= 0) return plan.v1[seg]!;
  const f = (t - plan.t[seg]!) / dt;
  const k = f < 0 ? 0 : f > 1 ? 1 : f;
  return plan.v0[seg]! + (plan.v1[seg]! - plan.v0[seg]!) * k;
}

/**
 * Position inside a known segment — the closed form of REQ-3.
 *
 * A ramp is `v0·dt' + (v1−v0)·dt'²/(2·dt)`: the integral of a straight line, not
 * a sum of samples off one. The quadratic term is the whole reason this is exact.
 */
export function positionIn(plan: ScratchPlan, seg: number, t: number): number {
  if (seg < 0) return 0;
  const t0 = plan.t[seg]!;
  const dt = plan.t[seg + 1]! - t0;
  const d = t - t0;
  if (dt <= 0 || d <= 0) return plan.p[seg]!;
  const dd = d > dt ? dt : d;
  const a = plan.v0[seg]!;
  const b = plan.v1[seg]!;
  return plan.p[seg]! + a * dd + ((b - a) * dd * dd) / (2 * dt);
}

/** Whether the crossfader is closed inside a known segment. */
export function cutIn(plan: ScratchPlan, seg: number): boolean {
  return seg >= 0 && plan.cut[seg] === 1;
}

/* --------------------------------------------------------- curve entry points */
/*
 * The convenience wrappers. Each builds a plan and calls the same three functions
 * the renderer calls, so there is exactly one description of where the needle is
 * (REQ-4) — what the editor draws cannot drift from what the reader plays.
 */

export function rateAt(c: ScratchCurve, t: number): number {
  const plan = scratchPlan(c);
  return rateIn(plan, segmentAt(plan, t), t);
}

export function positionAt(c: ScratchCurve, t: number): number {
  const plan = scratchPlan(c);
  return positionIn(plan, segmentAt(plan, t), t);
}

/** Target fader gain — 0 while cut, 1 otherwise. The slew belongs to the reader. */
export function gainAt(c: ScratchCurve, t: number): number {
  const plan = scratchPlan(c);
  return cutIn(plan, segmentAt(plan, t)) ? 0 : 1;
}

/**
 * How far the needle travels either side of its cue, in normalised output units.
 *
 * Endpoints are not enough: inside a ramp that crosses zero the needle turns
 * around, and that turning point is the actual extreme. Solving `v(t) = 0` for it
 * is one division, and skipping it would under-report exactly the strokes — the
 * pushes and pulls — this feature is made of.
 */
export function curveExtent(c: ScratchCurve): { min: number; max: number } {
  const plan = scratchPlan(c);
  if (plan.n === 0) return { min: 0, max: 0 };
  let min = 0;
  let max = 0;
  const see = (v: number): void => { if (v < min) min = v; if (v > max) max = v; };
  for (let i = 0; i <= plan.n; i++) see(plan.p[i]!);
  for (let i = 0; i < plan.n; i++) {
    const a = plan.v0[i]!;
    const b = plan.v1[i]!;
    if (a === b || (a > 0) === (b > 0)) continue;
    const dt = plan.t[i + 1]! - plan.t[i]!;
    if (dt <= 0) continue;
    see(positionIn(plan, i, plan.t[i]! + (-a * dt) / (b - a)));
  }
  return { min, max };
}

/**
 * Where to drop the needle so the gesture reads from inside the sample (REQ-20).
 *
 * A preset that pulls backwards first would otherwise start off the front of the
 * record and play its opening stroke as silence. The cue is pushed just far enough
 * in to cover the backwards excursion, then pulled back if that would run the
 * *end* off — and when the gesture is simply longer than the sample, covering the
 * start is the better half to keep.
 */
export function autoCue(c: ScratchCurve, srcFrames: number, outFrames: number): number {
  if (!(srcFrames > 0) || !(outFrames > 0)) return 0;
  const { min, max } = curveExtent(c);
  const lo = -min * outFrames;                 // frames of runway needed in front
  const hi = srcFrames - max * outFrames;      // last cue that keeps the tail on the record
  const want = lo > 0 ? lo : 0;
  const cueFrames = hi >= want ? want : Math.max(0, Math.min(want, srcFrames));
  return Math.max(0, Math.min(1, cueFrames / srcFrames));
}

/**
 * The preview lane (REQ-17): the source's peak envelope resampled *through* the
 * position map, so the drawing shows what the reader will produce.
 *
 * This is index arithmetic over an array `computePeaks` already built, not an
 * audio render — O(cols) with no allocation per pointer move, which is what lets
 * the preview follow a drag. A column whose needle is off the record, or whose
 * fader is cut, is drawn as silence for the same reason the reader outputs
 * silence there (REQ-9/REQ-10): the preview would otherwise promise audio the
 * apply does not deliver.
 *
 * `peaks` is `buffer-dsp`'s interleaved `[min0,max0,min1,max1,…]`.
 */
export function warpPeaks(
  peaks: Float32Array,
  c: ScratchCurve,
  srcFrames: number,
  outFrames: number,
  cols: number,
): Float32Array {
  const w = Math.max(0, Math.floor(cols));
  const out = new Float32Array(w * 2);
  const pw = Math.floor(peaks.length / 2);
  if (w === 0 || pw === 0 || !(srcFrames > 0) || !(outFrames > 0)) return out;

  const plan = scratchPlan(c);
  if (plan.n === 0) return out;
  const cueFrames = plan.cue * srcFrames;
  const colOf = (t: number, seg: number): number =>
    ((cueFrames + positionIn(plan, seg, t) * outFrames) / srcFrames) * pw;

  let seg = 0;
  for (let x = 0; x < w; x++) {
    const t0 = x / w;
    const t1 = (x + 1) / w;
    seg = segmentAt(plan, t0, seg);
    if (cutIn(plan, seg)) continue;
    const a = colOf(t0, seg);
    const b = colOf(t1, segmentAt(plan, t1, seg));
    let from = Math.floor(Math.min(a, b));
    let to = Math.ceil(Math.max(a, b));
    if (to <= from) to = from + 1;
    if (to <= 0 || from >= pw) continue;      // off the record entirely
    if (from < 0) from = 0;
    if (to > pw) to = pw;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = from; i < to; i++) {
      const mn = peaks[i * 2]!;
      const mx = peaks[i * 2 + 1]!;
      if (mn < lo) lo = mn;
      if (mx > hi) hi = mx;
    }
    if (!Number.isFinite(lo)) continue;
    out[x * 2] = lo;
    out[x * 2 + 1] = hi;
  }
  return out;
}

/* ------------------------------------------------------------------ presets */
/*
 * REQ-19. Every preset is written on a NORMALISED time axis, so one definition
 * plays at any length: choose 8 sixteenths instead of 16 and the same gesture
 * happens twice as fast, which is what a shorter scratch means.
 *
 * They are literal point tables rather than generated shapes because that is how
 * they are read and adjusted — a turntablist reads "push, pull, push long", and
 * the table says exactly that.
 */

export type ScratchPresetName =
  | 'Baby' | 'Transformer' | 'Chirp' | 'Tear' | 'Flare' | 'Scribble' | 'Stab';

export const SCRATCH_PRESETS: readonly ScratchPresetName[] =
  ['Baby', 'Transformer', 'Chirp', 'Tear', 'Flare', 'Scribble', 'Stab'];

type Pt = [t: number, v: number, cut?: boolean, hold?: boolean];

function pts(rows: readonly Pt[]): ScratchPoint[] {
  return rows.map(([t, v, cut = false, hold = false]) => ({ t, v, cut, hold }));
}

/**
 * Short – short – long: two quick push/pull pairs, then a long forward. The
 * defining beginner scratch and the one that reads as a scratch on the first
 * press, which is why it is the default.
 *
 * Each pair integrates back to where it started (a triangle up and the same
 * triangle down), so the needle is exactly home before the long stroke begins.
 */
const BABY: readonly Pt[] = [
  [0.00, 0], [0.05, 2], [0.10, 0], [0.15, -2], [0.20, 0],
  [0.25, 2], [0.30, 0], [0.35, -2], [0.40, 0],
  [0.50, 1],
];

/** Steady forward, the crossfader doing all the work on the eighths. */
const TRANSFORMER: readonly Pt[] = [
  [0.000, 1, false, true], [0.125, 1, true, true],
  [0.250, 1, false, true], [0.375, 1, true, true],
  [0.500, 1, false, true], [0.625, 1, true, true],
  [0.750, 1, false, true], [0.875, 1, true, true],
];

/** Push fast, close the fader, pull back silently, repeat. The chirp's bite is
 *  entirely in the fader landing on the same instant the stroke turns. */
const CHIRP: readonly Pt[] = [
  [0.00, 0], [0.06, 2.5], [0.12, 0, true], [0.24, -2.5, true], [0.30, 0, true],
  [0.36, 0], [0.42, 2.5], [0.48, 0, true], [0.60, -2.5, true], [0.66, 0, true],
  [0.72, 0], [0.80, 2.5], [0.90, 0],
];

/** The tear: one pull broken into two speeds, so a single backward stroke reads
 *  as two notes. Holds throughout — the jumps between speeds are the sound. */
const TEAR: readonly Pt[] = [
  [0.00, 1.0, false, true], [0.25, -2.0, false, true],
  [0.40, -0.7, false, true], [0.60, 1.0, false, true],
];

/** Forward and back with one fader click inside each stroke. */
const FLARE: readonly Pt[] = [
  [0.00, 1.5, false, true], [0.15, 1.5, true, true], [0.20, 1.5, false, true],
  [0.35, -1.5, false, true], [0.50, -1.5, true, true], [0.55, -1.5, false, true],
  [0.70, 1.5, false, true],
];

/** A hand vibrating on the record: fast, small, and staying put. */
const SCRIBBLE: readonly Pt[] = Array.from({ length: 17 }, (_, i): Pt =>
  [i / 16, i % 2 === 0 ? 3 : -3]);

/** One fast forward, then the fader shuts and leaves the bar open. */
const STAB: readonly Pt[] = [
  [0.00, 2, false, true], [0.25, 0, true, true],
];

const TABLES: Record<ScratchPresetName, readonly Pt[]> = {
  Baby: BABY,
  Transformer: TRANSFORMER,
  Chirp: CHIRP,
  Tear: TEAR,
  Flare: FLARE,
  Scribble: SCRIBBLE,
  Stab: STAB,
};

/** A named preset at a given length. `cue` is left at 0 — the editor places it
 *  with {@link autoCue} once it knows how long the source is. */
export function scratchPreset(name: ScratchPresetName, steps: number): ScratchCurve {
  const table = TABLES[name] ?? BABY;
  return normalizeCurve({ steps, cue: 0, points: pts(table) });
}

/**
 * Roll a new scratch (REQ-19).
 *
 * Strokes land on an eighth or sixteenth grid and alternate direction, because a
 * scratch that does not come back is a pitch slide; rates are drawn from a small
 * musical set rather than a continuous range, since a stroke at 1.37x reads as a
 * mistake next to one at 1.5x. `rnd` is injectable so the test can roll a
 * hundred of these deterministically.
 */
export function randomScratch(steps: number, rnd: () => number = Math.random): ScratchCurve {
  const RATES = [0.5, 1, 1.5, 2, 2.5];
  const strokes = 3 + Math.floor(rnd() * 4);          // 3..6
  const rows: Pt[] = [[0, 0]];
  let t = 0;
  let dir = 1;
  for (let i = 0; i < strokes && t < 0.92; i++) {
    const span = (rnd() < 0.5 ? 1 : 2) / 16;          // a sixteenth or an eighth
    const v = RATES[Math.floor(rnd() * RATES.length)]! * dir;
    const cut = rnd() < 0.4 && dir < 0;               // the fader hides return strokes
    rows.push([t + span * 0.5, v, cut]);
    t += span;
    rows.push([t, 0, cut]);
    dir = -dir;
  }
  // End going forward, so the gesture resolves rather than stopping mid-stroke.
  rows.push([Math.min(0.95, t + 0.05), 1]);
  return normalizeCurve({ steps, cue: 0, points: pts(rows) });
}
