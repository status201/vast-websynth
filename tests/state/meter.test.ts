import { describe, it, expect } from 'vitest';
import {
  GRID_CELLS,
  BEAT_UNITS,
  LANE_RATES,
  LANE_RATE_LABELS,
  DEFAULT_LANE_RATE,
  DEFAULT_BAR_TICKS,
  DEFAULT_BEATS,
  DEFAULT_BEAT_UNIT,
  LEN_FOLLOW,
  METER_PRESETS,
  MIN_BEATS,
  MAX_BEATS,
  barTicks,
  ticksPerBeat,
  meterLabel,
  laneRate,
  ticksPerCell,
  laneCells,
  laneTicks,
  cellIndex,
  cellsInTick,
  cellOffsetTicks,
} from '../../src/state/meter';
import { DIVISIONS } from '../../src/utils/tempo';

describe('meter — bar length (meter.md REQ-5/REQ-6)', () => {
  it('defaults to 4/4, i.e. the pre-meter bar', () => {
    expect(barTicks(DEFAULT_BEATS, DEFAULT_BEAT_UNIT)).toBe(DEFAULT_BAR_TICKS);
    expect(DEFAULT_BAR_TICKS).toBe(GRID_CELLS);
  });

  it.each([
    ['4/4', 4, 0, 16],
    ['3/4', 3, 0, 12],
    ['2/4', 2, 0, 8],
    ['5/4', 5, 0, 20],
    ['7/4', 7, 0, 28],
    ['5/8', 5, 1, 10],
    ['6/8', 6, 1, 12],
    ['7/8', 7, 1, 14],
    ['9/8', 9, 1, 18],
    ['12/8', 12, 1, 24],
  ])('%s is %i ticks', (label, beats, unit, ticks) => {
    expect(barTicks(beats, unit)).toBe(ticks);
    expect(meterLabel(beats, unit)).toBe(label);
  });

  it('every offered preset is one of those', () => {
    for (const p of METER_PRESETS) expect(meterLabel(p.beats, p.unit)).toBe(p.label);
  });

  it('clamps beats and refuses non-finite input', () => {
    expect(barTicks(0, 0)).toBe(MIN_BEATS * 4);
    expect(barTicks(99, 0)).toBe(MAX_BEATS * 4);
    // NaN would make every downstream modulo NaN and stall every machine at once.
    expect(barTicks(NaN, 0)).toBe(MIN_BEATS * 4);
    expect(ticksPerBeat(NaN)).toBe(BEAT_UNITS[0]);
    expect(ticksPerBeat(7)).toBe(BEAT_UNITS[BEAT_UNITS.length - 1]);
  });
});

describe('meter — the lane rate table (meter.md REQ-14)', () => {
  it('mirrors utils/tempo.ts, so the two spellings cannot drift', () => {
    for (const r of LANE_RATES) {
      const division = DIVISIONS.find((d) => d.label === r.label);
      expect(division, `no division labelled ${r.label}`).toBeDefined();
      // A tick is a 16th, a `beats` unit is a quarter: 1 beat = 4 ticks.
      expect(r.num / r.den).toBeCloseTo(division!.beats * 4, 12);
    }
  });

  it('is ascending by duration and labelled uniquely', () => {
    const ticks = LANE_RATES.map((r) => r.num / r.den);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    expect(new Set(LANE_RATE_LABELS).size).toBe(LANE_RATE_LABELS.length);
  });

  it('defaults to one cell per tick — an exact no-op', () => {
    expect(laneRate(DEFAULT_LANE_RATE).label).toBe('1/16');
    expect(ticksPerCell(DEFAULT_LANE_RATE)).toBe(1);
  });

  it('clamps an out-of-range or non-finite index instead of returning undefined', () => {
    expect(laneRate(-3)).toBe(LANE_RATES[0]);
    expect(laneRate(99)).toBe(LANE_RATES[LANE_RATES.length - 1]);
    expect(laneRate(NaN)).toBe(LANE_RATES[0]);
  });
});

describe('meter — lane length (meter.md REQ-10)', () => {
  const rate = (label: string): number => LANE_RATES.findIndex((r) => r.label === label);

  it('follows the bar by default, so one meter moves every machine', () => {
    expect(laneCells(LEN_FOLLOW, DEFAULT_LANE_RATE, 16)).toBe(16);
    expect(laneCells(LEN_FOLLOW, DEFAULT_LANE_RATE, 12)).toBe(12);
    expect(laneCells(LEN_FOLLOW, DEFAULT_LANE_RATE, 14)).toBe(14);
  });

  it('reaches 5/4 and 7/4 at eighth-note resolution (REQ-14)', () => {
    const eighth = rate('1/8');
    expect(laneCells(LEN_FOLLOW, eighth, barTicks(5, 0))).toBe(10);
    expect(laneTicks(LEN_FOLLOW, eighth, barTicks(5, 0))).toBe(20);
    expect(laneCells(LEN_FOLLOW, eighth, barTicks(7, 0))).toBe(14);
    expect(laneTicks(LEN_FOLLOW, eighth, barTicks(7, 0))).toBe(28);
  });

  it('caps a follow that would need more cells than the grid has', () => {
    // 5/4 at 1/16 is 20 ticks — more than the grid holds, so it phases instead.
    expect(laneCells(LEN_FOLLOW, DEFAULT_LANE_RATE, 20)).toBe(GRID_CELLS);
  });

  it('honours an explicit length, clamped to the grid', () => {
    expect(laneCells(12, DEFAULT_LANE_RATE, 16)).toBe(12);
    expect(laneCells(99, DEFAULT_LANE_RATE, 16)).toBe(GRID_CELLS);
    expect(laneCells(-4, DEFAULT_LANE_RATE, 16)).toBe(16); // LEN_FOLLOW
  });
});

describe('meter — cell index is pure in `step` (meter.md REQ-3)', () => {
  it('depends only on the absolute step, never on how it was reached', () => {
    for (const step of [0, 1, 11, 12, 40, 65535, 65536, 65537, 1_000_000]) {
      expect(cellIndex(step, 12, DEFAULT_LANE_RATE)).toBe(step % 12);
    }
  });

  it('does not glitch across the old 16-bit wrap for a 12-cell lane', () => {
    // 65536 % 12 === 4: the wrap the clock used to do would have jumped phase here.
    expect(cellIndex(65535, 12, DEFAULT_LANE_RATE)).toBe(65535 % 12);
    expect(cellIndex(65536, 12, DEFAULT_LANE_RATE)).toBe((65535 % 12) + 1);
  });

  it('divides the step by the rate for a coarser lane', () => {
    const eighth = LANE_RATES.findIndex((r) => r.label === '1/8');
    expect([0, 1, 2, 3, 4, 5].map((s) => cellIndex(s, 10, eighth))).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe('meter — which cells begin in a tick (meter.md REQ-15)', () => {
  const rate = (label: string): number => LANE_RATES.findIndex((r) => r.label === label);

  it('is exactly one per tick at the default rate', () => {
    for (let s = 0; s < 8; s++) {
      expect(cellsInTick(s, DEFAULT_LANE_RATE)).toEqual({ from: s, count: 1 });
    }
  });

  it('skips the ticks a coarser lane does not land on', () => {
    const eighth = rate('1/8');
    expect([0, 1, 2, 3].map((s) => cellsInTick(s, eighth).count)).toEqual([1, 0, 1, 0]);
    const quarter = rate('1/4');
    expect([0, 1, 2, 3, 4].map((s) => cellsInTick(s, quarter).count)).toEqual([1, 0, 0, 0, 1]);
  });

  it('fans a finer lane out inside one tick', () => {
    const thirtysecond = rate('1/32');
    const t = cellsInTick(3, thirtysecond);
    expect(t).toEqual({ from: 6, count: 2 });
    expect(cellOffsetTicks(6, thirtysecond, 3)).toBeCloseTo(0, 12);
    expect(cellOffsetTicks(7, thirtysecond, 3)).toBeCloseTo(0.5, 12);
  });

  it('places triplet cells exactly — the float form lands one tick late', () => {
    const t16 = rate('1/16 T');
    // 3 cells per 2 ticks: 2, then 1, then 2, then 1 …
    expect([0, 1, 2, 3, 4, 5].map((s) => cellsInTick(s, t16).count)).toEqual([2, 1, 2, 1, 2, 1]);
    // `2 / (2/3)` is 3.0000000000000004 as a float, so a naive ceil would put
    // cell 3 in tick 3 instead of tick 2. Exact rational arithmetic does not.
    expect(cellsInTick(2, t16).from).toBe(3);
    let total = 0;
    for (let s = 0; s < 16; s++) total += cellsInTick(s, t16).count;
    expect(total).toBe(24); // 24 triplet 16ths in a 16-tick bar
  });

  it('never leaves a gap or an overlap: cell numbers are contiguous', () => {
    for (const r of LANE_RATES.keys()) {
      let expected = cellsInTick(0, r).from;
      for (let s = 0; s < 24; s++) {
        const { from, count } = cellsInTick(s, r);
        expect(from).toBe(expected);
        expected += count;
        for (let i = 0; i < count; i++) {
          const off = cellOffsetTicks(from + i, r, s);
          expect(off).toBeGreaterThanOrEqual(-1e-9);
          expect(off).toBeLessThan(1);
        }
      }
    }
  });
});
