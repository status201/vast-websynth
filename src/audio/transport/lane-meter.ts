import type { TickSubscriber } from './tick-source';
import {
  DEFAULT_BAR_TICKS,
  DEFAULT_LANE_RATE,
  LEN_FOLLOW,
  cellOffsetTicks,
  cellsInTick,
  laneCells,
  ticksPerCell,
} from '../../state/meter';

/** What a machine does with one cell that fell inside this tick. */
export type LaneHitListener = (
  /** Index into the pattern grid — already wrapped to the lane's length. */
  index: number,
  /** Absolute audio time this cell sounds at. */
  when: number,
  /** How long this cell lasts, in seconds — the gate/ratchet unit. */
  cellDur: number,
) => void;

/**
 * One machine's share of the meter: how many cells it loops over and how fast
 * (specs/features/meter.md REQ-10/REQ-14/REQ-15/REQ-16).
 *
 * Held by the sequencer, drum machine, sampler and motion sequencer so the
 * length/rate arithmetic exists once. Everything it computes is a pure function
 * of the absolute tick (meter.md REQ-3), so a 12- or 14-cell lane survives a
 * seek, a Song-Position join and a dropout with no state to repair.
 */
export class LaneMeter {
  private len = LEN_FOLLOW;
  private rateIdx = DEFAULT_LANE_RATE;
  private bar = DEFAULT_BAR_TICKS;

  /**
   * @param clock  read for `sixteenthDuration` and `swingOffset` only.
   * @param mapStep  the stutter fold the three trigger machines apply before
   *   resolving a cell (performance.md). Motion passes nothing: automation must
   *   not follow a stutter remap.
   */
  constructor(
    private readonly clock: TickSubscriber,
    private readonly mapStep: (step: number) => number = (s) => s,
  ) {}

  /** `LEN_FOLLOW` (0) tracks the bar; anything else pins a cell count. */
  setLen(len: number): void {
    this.len = Number.isFinite(len) ? Math.round(len) : LEN_FOLLOW;
  }

  setRate(rateIdx: number): void {
    this.rateIdx = Number.isFinite(rateIdx) ? Math.round(rateIdx) : DEFAULT_LANE_RATE;
  }

  setBarTicks(ticks: number): void {
    this.bar = Number.isFinite(ticks) ? Math.max(1, Math.round(ticks)) : DEFAULT_BAR_TICKS;
  }

  /** How many grid cells this lane actually plays. */
  get cells(): number {
    return laneCells(this.len, this.rateIdx, this.bar);
  }

  get rate(): number {
    return this.rateIdx;
  }

  /** Seconds per cell — one tick's worth at the default rate. */
  cellDuration(): number {
    return ticksPerCell(this.rateIdx) * this.clock.sixteenthDuration();
  }

  /**
   * Call `fn` for each cell that **begins** inside this tick: usually exactly
   * one, none on the ticks a coarser lane skips, and two or three for a rate
   * finer than a 16th — scheduled inside the tick at sample-accurate offsets,
   * the technique the arpeggiator already uses (arpeggiator.md REQ-6).
   *
   * **Swing is applied on the lane's own grid** (meter.md REQ-16). The clock
   * delays odd *ticks*, so a lane at two ticks per cell only ever fires on even
   * ticks — never delayed — and would sit dead straight under swung hats. Such a
   * lane subtracts the clock's offset for this tick and adds the one its own
   * alternating cells imply. `swingOffset(cell) × ticksPerCell` is exactly
   * `swing × 0.5 × cellDuration`, so no second swing accessor is needed.
   *
   * One cell per tick takes an explicit fast path that emits `when` untouched.
   * The general formula reduces to the same value there — but only for the
   * *unmapped* tick, and stutter can change a step's parity, so the fast path is
   * what makes the default rate byte-identical to pre-meter playback under every
   * combination of swing and stutter.
   */
  forEachHit(step: number, when: number, fn: LaneHitListener): void {
    const cells = this.cells;
    const src = this.mapStep(step);
    const perCell = ticksPerCell(this.rateIdx);
    const cellDur = perCell * this.clock.sixteenthDuration();

    if (perCell === 1) {
      fn(((src % cells) + cells) % cells, when, cellDur);
      return;
    }

    const { from, count } = cellsInTick(src, this.rateIdx);
    if (count === 0) return;
    const sixteenth = this.clock.sixteenthDuration();
    const gridWhen = when - this.clock.swingOffset(step);
    for (let i = 0; i < count; i++) {
      const cell = from + i;
      const at = gridWhen
        + cellOffsetTicks(cell, this.rateIdx, src) * sixteenth
        + this.clock.swingOffset(cell) * perCell;
      fn(((cell % cells) + cells) % cells, at, cellDur);
    }
  }
}
