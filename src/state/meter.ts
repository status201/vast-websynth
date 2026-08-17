/**
 * Meter vocabulary — the bar as a tick count (specs/features/meter.md, ADR-019).
 *
 * `SEQ_LENGTH = 16` used to mean three different things at once: how many cells a
 * pattern holds, how long a bar is, and how many columns the UI draws. This
 * module names those apart so a call site has to say which one it means:
 *
 *   GRID_CELLS   cells per pattern      (job 1 — `SEQ_LENGTH` now aliases this)
 *   barTicks()   bar length in ticks    (job 2 — from transport.beats/beatUnit)
 *   LANE_RATES   ticks per cell         (job 3's partner — per machine)
 *
 * A **tick** is one 16th note: the clock's unit, unchanged (meter.md REQ-1).
 *
 * Pure and dependency-light on purpose — `scripts/mcp/song-core-entry.ts` pulls
 * `patterns.ts` (and so this) into a plain-Node bundle, so nothing here may touch
 * the DOM, an AudioContext or `import.meta.glob`.
 */

/** Cells in one pattern grid. The one constant a longer grid would change. */
export const GRID_CELLS = 16;

/** Beats per bar, as `transport.beats` is clamped. */
export const MIN_BEATS = 2;
export const MAX_BEATS = 12;

/** Ticks per beat, indexed by `transport.beatUnit`: a quarter, then an eighth. */
export const BEAT_UNITS = [4, 2] as const;
export const BEAT_UNIT_LABELS = ['1/4', '1/8'] as const;

/** 4/4 — what every pre-meter song means (meter.md REQ-19). */
export const DEFAULT_BEATS = 4;
export const DEFAULT_BEAT_UNIT = 0;
export const DEFAULT_BAR_TICKS = 16;

/**
 * One entry of the per-lane rate table: **ticks per cell as an exact rational**.
 *
 * Rational, not a float, because `cellsInTick` decides which cells begin inside a
 * tick by comparing `cell × num/den` against integer tick bounds. With `2/3` as a
 * float, `2 / (2/3)` is `3.0000000000000004` and a triplet cell silently lands in
 * the wrong tick; with integers the comparison is exact.
 *
 * The set mirrors the straight/dotted/triplet table in `utils/tempo.ts`
 * (`beats × 4 === num / den`), pinned by a drift test rather than imported, so
 * this file stays arithmetic-only. Order is ascending by duration — finest first
 * — because that is how a rate dropdown reads.
 */
export interface LaneRate {
  /** Display label, matching `utils/tempo.ts`'s `DIVISIONS` spelling. */
  label: string;
  /** Ticks per cell = `num / den`. */
  num: number;
  den: number;
}

export const LANE_RATES: readonly LaneRate[] = [
  { label: '1/32', num: 1, den: 2 },
  { label: '1/16 T', num: 2, den: 3 },
  { label: '1/16', num: 1, den: 1 },
  { label: '1/8 T', num: 4, den: 3 },
  { label: '1/16 D', num: 3, den: 2 },
  { label: '1/8', num: 2, den: 1 },
  { label: '1/4 T', num: 8, den: 3 },
  { label: '1/8 D', num: 3, den: 1 },
  { label: '1/4', num: 4, den: 1 },
];

export const LANE_RATE_LABELS: readonly string[] = LANE_RATES.map((r) => r.label);

/** `'1/16'` — one cell per tick, i.e. exactly the pre-meter behaviour. */
export const DEFAULT_LANE_RATE = LANE_RATES.findIndex((r) => r.label === '1/16');

/** `<m>.len` sentinel: follow the bar instead of pinning a cell count. */
export const LEN_FOLLOW = 0;

/** The signatures the meter picker offers. `unit` indexes {@link BEAT_UNITS}. */
export interface MeterPreset {
  label: string;
  beats: number;
  unit: number;
}

export const METER_PRESETS: readonly MeterPreset[] = [
  { label: '4/4', beats: 4, unit: 0 },
  { label: '3/4', beats: 3, unit: 0 },
  { label: '2/4', beats: 2, unit: 0 },
  { label: '5/4', beats: 5, unit: 0 },
  { label: '7/4', beats: 7, unit: 0 },
  { label: '5/8', beats: 5, unit: 1 },
  { label: '6/8', beats: 6, unit: 1 },
  { label: '7/8', beats: 7, unit: 1 },
  { label: '9/8', beats: 9, unit: 1 },
  { label: '12/8', beats: 12, unit: 1 },
];

function clampInt(v: number, min: number, max: number): number {
  // Non-finite floored to `min` first: the app-wide `max(min, min(max, v))` idiom
  // returns NaN for NaN (untrusted-input.md REQ-6), and a NaN bar length would
  // make every modulo below NaN and stall every machine at once.
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** Ticks per beat for a `transport.beatUnit` index. */
export function ticksPerBeat(unitIdx: number): number {
  return BEAT_UNITS[clampInt(unitIdx, 0, BEAT_UNITS.length - 1)]!;
}

/** Bar length in ticks — `beats × ticksPerBeat` (meter.md REQ-5/REQ-6). */
export function barTicks(beats: number, unitIdx: number): number {
  return clampInt(beats, MIN_BEATS, MAX_BEATS) * ticksPerBeat(unitIdx);
}

/** `'7/8'` — how a meter reads on screen. */
export function meterLabel(beats: number, unitIdx: number): string {
  const b = clampInt(beats, MIN_BEATS, MAX_BEATS);
  const unit = clampInt(unitIdx, 0, BEAT_UNITS.length - 1);
  return `${b}/${unit === 0 ? 4 : 8}`;
}

export function laneRate(rateIdx: number): LaneRate {
  return LANE_RATES[clampInt(rateIdx, 0, LANE_RATES.length - 1)]!;
}

/** Ticks per cell as a number — for durations, never for tick membership. */
export function ticksPerCell(rateIdx: number): number {
  const r = laneRate(rateIdx);
  return r.num / r.den;
}

/**
 * How many cells a lane actually plays.
 *
 * `len === LEN_FOLLOW` (the default, and a no-op) means *follow the bar*: as many
 * cells of this rate as the bar holds, capped at the grid. The fit is exact
 * whenever the rate divides the bar; a triplet rate against a 7-eighth bar cannot
 * tile it at all, so the nearest whole cell count is used and the lane
 * deliberately phases — which is the same behaviour an explicit length would give.
 */
export function laneCells(len: number, rateIdx: number, bar: number): number {
  const l = clampInt(len, LEN_FOLLOW, GRID_CELLS);
  if (l !== LEN_FOLLOW) return l;
  const r = laneRate(rateIdx);
  return clampInt((bar * r.den) / r.num, 1, GRID_CELLS);
}

/** The lane's loop length in ticks — what it phases against the bar with. */
export function laneTicks(len: number, rateIdx: number, bar: number): number {
  return laneCells(len, rateIdx, bar) * ticksPerCell(rateIdx);
}

/**
 * The cell a lane is on at absolute tick `step` — **a pure function of `step`**
 * (meter.md REQ-3). No accumulator anywhere, which is what makes a 12- or
 * 14-cell lane survive a seek, a Song-Position join and a dropout untouched.
 */
export function cellIndex(step: number, cells: number, rateIdx: number): number {
  const r = laneRate(rateIdx);
  const n = Math.max(1, cells);
  const cell = Math.floor((step * r.den) / r.num);
  return ((cell % n) + n) % n;
}

/** `ceil(a / b)` for non-negative integers, without leaving integer arithmetic. */
function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

/**
 * Which cells **begin** inside tick `step`: `count` cells starting at absolute
 * cell number `from`.
 *
 * Cell `i` starts at tick `i × num/den`, so it belongs to this tick when
 * `i × num/den ∈ [step, step+1)` — multiplied out to `i × num ∈ [step×den,
 * (step+1)×den)`, which is exact integer arithmetic.
 *
 * At a rate of one tick per cell this is always `{ count: 1 }`; coarser rates
 * give `count: 0` on the ticks they skip; finer rates give 2 or 3, to be
 * scheduled inside the one tick at `cellOffsetTicks` — the technique the
 * arpeggiator already uses for sub-16th rates (arpeggiator.md REQ-6).
 */
export function cellsInTick(step: number, rateIdx: number): { from: number; count: number } {
  const r = laneRate(rateIdx);
  const from = ceilDiv(step * r.den, r.num);
  const to = ceilDiv((step + 1) * r.den, r.num);
  return { from, count: to - from };
}

/** How far into tick `step` absolute cell `cell` falls, in ticks (0 .. <1). */
export function cellOffsetTicks(cell: number, rateIdx: number, step: number): number {
  const r = laneRate(rateIdx);
  return (cell * r.num) / r.den - step;
}
