import type { ParamBus } from '../state/params';
import {
  GRID_CELLS, barTicks, cellIndex, laneCells, ticksPerBeat, ticksPerCell,
} from '../state/meter';

/** The four machines that own a step grid. */
export type GridLane = 'seq' | 'drum' | 'sampler' | 'motion';

/**
 * What a lane's grid looks like right now (meter.md REQ-8/REQ-10/REQ-11).
 *
 * Every UI surface that draws or measures a step grid — the four panels, the
 * position ruler, the LEN/RATE controls — resolves it through here rather than
 * doing its own arithmetic. That is what keeps the ruler's tick count, the
 * grid's live columns and the red beat accents from ever disagreeing, which is
 * the failure a reader would read as a bug in the sequencer rather than in the
 * drawing code.
 */
export interface LaneGrid {
  /** Cells this lane actually plays; the rest of the 16 are dark (REQ-11). */
  readonly cells: number;
  /** Index into `LANE_RATES` — the lane's ticks-per-cell. */
  readonly rate: number;
  /** Bar length in 16th ticks. */
  readonly bar: number;
  /**
   * Cells per beat, for the accent columns — `0` when the rate does not divide
   * the beat (a triplet lane against a straight beat), where accenting every
   * n-th cell would draw a beat grid that is not there.
   */
  readonly cellsPerBeat: number;
}

export function laneGrid(bus: ParamBus, lane: GridLane): LaneGrid {
  const bar = barTicks(bus.get('transport.beats'), bus.get('transport.beatUnit'));
  const rate = bus.get(`${lane}.rate`);
  const cells = laneCells(bus.get(`${lane}.len`), rate, bar);
  const perBeat = ticksPerBeat(bus.get('transport.beatUnit')) / ticksPerCell(rate);
  return {
    cells,
    rate,
    bar,
    cellsPerBeat: Number.isInteger(perBeat) && perBeat >= 1 ? perBeat : 0,
  };
}

/** Whether cell `i` starts a beat — the red accent column (REQ-8). */
export function isBeatCell(i: number, grid: LaneGrid): boolean {
  return grid.cellsPerBeat > 0 && i % grid.cellsPerBeat === 0;
}

/** 1-based beat number for cell `i`, or `null` when the lane has no beat grid. */
export function beatOfCell(i: number, grid: LaneGrid): number | null {
  return grid.cellsPerBeat > 0 ? Math.floor(i / grid.cellsPerBeat) + 1 : null;
}

/** The grid cell the transport is on, for this lane. */
export function laneCellAt(step: number, grid: LaneGrid): number {
  return cellIndex(step, grid.cells, grid.rate);
}

/**
 * Subscribe to everything that can change a lane's grid: the two meter params
 * and that lane's own length and rate. Fires once immediately, like `subscribe`.
 */
export function onLaneGridChange(bus: ParamBus, lane: GridLane, fn: () => void): () => void {
  const ids = ['transport.beats', 'transport.beatUnit', `${lane}.len`, `${lane}.rate`];
  const unsubs = ids.map((id) => bus.subscribe(id, fn));
  return () => { for (const u of unsubs) u(); };
}

/** Every grid cell index, live or dark — the panels' build loop bound. */
export const ALL_CELLS = GRID_CELLS;

/** The per-cell surface a grid row exposes to {@link bindLaneGrid}. */
export interface LaneGridCell {
  setAccent(accent: 'orange' | 'red' | 'yellow'): void;
  setLive(live: boolean): void;
}

/**
 * Keep a machine's grid in step with its meter: the container's column count,
 * which cells are live, and where the beat accents fall (meter.md REQ-8/REQ-11).
 *
 * `rows()` is called on each update rather than captured, because two of the
 * four panels rebuild their rows (the drum kit's track list, the motion tracks)
 * and a captured array would go stale. `containers()` likewise.
 *
 * Returns an unsubscribe, and fires once immediately — so a panel binds and is
 * drawn, rather than binding and then having to draw.
 */
export function bindLaneGrid(
  bus: ParamBus,
  lane: GridLane,
  containers: () => readonly HTMLElement[],
  rows: () => readonly (readonly LaneGridCell[])[],
  accent: 'red' | 'orange' = 'red',
): () => void {
  return onLaneGridChange(bus, lane, () => {
    const grid = laneGrid(bus, lane);
    for (const el of containers()) el.style.setProperty('--steps', String(grid.cells));
    for (const row of rows()) {
      row.forEach((cell, i) => {
        cell.setLive(i < grid.cells);
        cell.setAccent(isBeatCell(i, grid) ? accent : 'orange');
      });
    }
  });
}
