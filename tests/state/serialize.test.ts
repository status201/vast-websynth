import { describe, it, expect } from 'vitest';
import { roundNum, roundParams, compactSongForExport } from '../../src/state/serialize';
import { Song } from '../../src/state/song';
import { fixtureSong, FIXTURE } from '../fixtures/song-fixture';
import type { SongFile } from '../../src/state/song';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore, TRIGGER_CELL_DEFAULTS } from '../../src/state/patterns';
import type { SeqStep, TriggerCell } from '../../src/state/patterns';

/** Minimal Arrangement stand-in (mirrors tests/state/song.test.ts). */
function fakeArr() {
  return {
    seq: { enabled: false, steps: [0] as number[] },
    drum: { enabled: false, steps: [0] as number[] },
    sampler: { enabled: false, steps: [0] as number[] },
    motion: { enabled: false, steps: [0] as number[] },
    setSeqChain(steps: number[], enabled: boolean) { this.seq = { enabled, steps: [...steps] }; },
    setDrumChain(steps: number[], enabled: boolean) { this.drum = { enabled, steps: [...steps] }; },
    setSamplerChain(steps: number[], enabled: boolean) { this.sampler = { enabled, steps: [...steps] }; },
    setMotionChain(steps: number[], enabled: boolean) { this.motion = { enabled, steps: [...steps] }; },
  };
}

/** Build a structurally-minimal SongFile for unit-level compaction checks. */
function songWith(partial: Partial<SongFile>): SongFile {
  return {
    format: 'websynth-song', version: 2, name: 'T',
    params: {}, seqBanks: [], drumBanks: [],
    seqChain: { enabled: false, steps: [0] },
    drumChain: { enabled: false, steps: [0] },
    ...partial,
  } as SongFile;
}

const trigger = (o: Partial<TriggerCell>): TriggerCell => ({ ...TRIGGER_CELL_DEFAULTS, ...o });
const seq = (o: Partial<SeqStep>): SeqStep =>
  ({ on: true, note: 60, velocity: 0.85, gate: 0.5, prob: 1, ratchet: 1, tie: false, ...o });

const firstDrum = (out: Record<string, unknown>) =>
  (out.drumBanks as unknown[][][])[0]![0]![0];
const firstSeq = (out: Record<string, unknown>) =>
  (out.seqBanks as unknown[][])[0]![0];

describe('roundNum', () => {
  it('rounds to 4 significant figures', () => {
    expect(roundNum(0.330909194946289)).toBe(0.3309);
    expect(roundNum(60.03635787963867)).toBe(60.04);
    expect(roundNum(2784.3633117675786)).toBe(2784);
    expect(roundNum(0.000030253496406868542)).toBe(0.00003025); // sig-figs keep tiny exp values
  });

  it('leaves already-clean and integer values untouched', () => {
    for (const n of [0, 1, 0.5, 0.85, 36, 125, -5, -0.075]) expect(roundNum(n)).toBe(n);
  });

  it('passes non-finite values through (JSON can never encode them anyway)', () => {
    expect(roundNum(NaN)).toBeNaN();
    expect(roundNum(Infinity)).toBe(Infinity);
  });

  it('is idempotent', () => {
    const v = roundNum(0.330909194946289);
    expect(roundNum(v)).toBe(v);
  });
});

describe('roundParams', () => {
  it('rounds every value and keeps every key', () => {
    expect(roundParams({
      'sub.level': 0.330909194946289,
      'filter.cutoff': 60.03635787963867,
      'fx.dist.tone': 2784.3633117675786,
      'fx.drum.comp.attack': 0.000030253496406868542,
      'keyboard.transpose': -1,
    })).toEqual({
      'sub.level': 0.3309,
      'filter.cutoff': 60.04,
      'fx.dist.tone': 2784,
      'fx.drum.comp.attack': 0.00003025,
      'keyboard.transpose': -1,
    });
  });
});

describe('compactSongForExport — drum/sampler cells', () => {
  it('collapses a default OFF cell to { on: false }', () => {
    const out = compactSongForExport(songWith({ drumBanks: [[[trigger({ on: false })]]] }));
    expect(firstDrum(out)).toEqual({ on: false });
  });

  it('collapses a default ON cell to { on: true }', () => {
    const out = compactSongForExport(songWith({ drumBanks: [[[trigger({ on: true })]]] }));
    expect(firstDrum(out)).toEqual({ on: true });
  });

  it('keeps only non-default fields (rounded)', () => {
    const cell = trigger({
      on: true, velocity: 0.5173176129659017, gate: 0.44645182291666663, prob: 1, ratchet: 2, tie: false,
    });
    const out = compactSongForExport(songWith({ drumBanks: [[[cell]]] }));
    expect(firstDrum(out)).toEqual({ on: true, velocity: 0.5173, gate: 0.4465, ratchet: 2 });
  });

  it('drops a field that equals its default only AFTER rounding', () => {
    const out = compactSongForExport(songWith({ drumBanks: [[[trigger({ velocity: 0.8500001 })]]] }));
    expect(firstDrum(out)).toEqual({ on: false }); // 0.8500001 -> 0.85 (default) -> dropped
  });
});

describe('compactSongForExport — seq steps', () => {
  it('always keeps on/note/velocity/gate but drops default prob/ratchet/tie', () => {
    const out = compactSongForExport(songWith({
      seqBanks: [[seq({ on: true, note: 36, velocity: 0.8, gate: 0.3553091684977213 })]],
    }));
    expect(firstSeq(out)).toEqual({ on: true, note: 36, velocity: 0.8, gate: 0.3553 });
  });

  it('keeps non-default prob/ratchet/tie (rounded)', () => {
    const out = compactSongForExport(songWith({
      seqBanks: [[seq({ note: 48, velocity: 1, gate: 0.5, prob: 0.314453125, ratchet: 3, tie: true })]],
    }));
    expect(firstSeq(out)).toEqual({
      on: true, note: 48, velocity: 1, gate: 0.5, prob: 0.3145, ratchet: 3, tie: true,
    });
  });
});

describe('compactSongForExport — whole-song', () => {
  it('rounds params and preserves optional-field presence', () => {
    const out = compactSongForExport(songWith({
      params: { 'filter.cutoff': 60.03635787963867 },
      // no sampler fields -> output must not grow them
    }));
    expect(out.params).toEqual({ 'filter.cutoff': 60.04 });
    expect('samplerBanks' in out).toBe(false);
    expect('sampleNames' in out).toBe(false);
  });

  it('is idempotent (re-compacting a compact file is a no-op)', () => {
    const file = fixtureSong();
    const compact = compactSongForExport(file);
    const reloaded = JSON.parse(JSON.stringify(compact)) as SongFile;
    expect(compactSongForExport(reloaded)).toEqual(compact);
  });

  it('copies a v3 xy assignment through, and omits it when absent', () => {
    const withXy = compactSongForExport(songWith({ version: 3, xy: { x: 'lfo.rate', y: 'filter.cutoff' } }));
    expect(withXy.xy).toEqual({ x: 'lfo.rate', y: 'filter.cutoff' });

    const withoutXy = compactSongForExport(songWith({}));
    expect('xy' in withoutXy).toBe(false);
  });
});

describe('round-trip fidelity', () => {
  it('fromJSON(toJSON(x)) deep-equals the canonical compact form', () => {
    const file = fixtureSong();
    expect(Song.fromJSON(Song.toJSON(file))).toEqual(compactSongForExport(file));
  });

  it('applying the compact file reproduces the original-sounding state', () => {
    const compactFile = Song.fromJSON(Song.toJSON(fixtureSong()))!;

    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    Song.apply(compactFile, bus, patterns, fakeArr() as never);

    expect(bus.get('transport.bpm')).toBe(FIXTURE.bpm);
    const plain = patterns.seqBanks[0]![0]![FIXTURE.plainStep]!;
    expect(plain.note).toBe(FIXTURE.plainNote);
    // default fields the sparse cells omitted are re-expanded by restore()
    expect(plain.prob).toBe(1);
    expect(plain.ratchet).toBe(1);
    expect(patterns.drumBanks[0]![0]![0]!.gate).toBe(1);
    // …while the cells that carry real per-step settings keep them.
    const settings = patterns.seqBanks[0]![0]![FIXTURE.settingsStep]!;
    expect(settings.prob).toBeCloseTo(FIXTURE.settingsProb);
    expect(settings.ratchet).toBe(FIXTURE.settingsRatchet);
    expect(settings.tie).toBe(true);
    expect(patterns.drumBanks[0]![FIXTURE.chokedTrack]![FIXTURE.chokedStep]!.gate)
      .toBeCloseTo(FIXTURE.chokedGate);
    expect(patterns.drumBanks[0]![FIXTURE.ghostTrack]![FIXTURE.ghostStep]!.prob)
      .toBeCloseTo(FIXTURE.ghostProb);
  });
});

describe('compactSongForExport — motion (v4)', () => {
  const motionSong = () => songWith({
    version: 4,
    motionBanks: [[
      { on: true, x: 0.123456, y: 1 },
      { on: false, x: 0.5, y: 0.5 },
    ]] as never,
    motionAssigns: [{ x: 'fx.delay.mix' }, null, null, null],
    motionChain: { enabled: true, steps: [0, 1] },
  });

  it('keeps live anchors (rounded) and collapses dead steps to { on: false }', () => {
    const out = compactSongForExport(motionSong());
    const bank = (out.motionBanks as unknown[][])[0]!;
    expect(bank[0]).toEqual({ on: true, x: 0.1235, y: 1 });
    expect(bank[1]).toEqual({ on: false });
  });

  it('passes assigns/chain through and omits absent motion fields', () => {
    const out = compactSongForExport(motionSong());
    expect(out.motionAssigns).toEqual([{ x: 'fx.delay.mix' }, null, null, null]);
    expect(out.motionChain).toEqual({ enabled: true, steps: [0, 1] });
    const bare = compactSongForExport(songWith({}));
    expect(bare.motionBanks).toBeUndefined();
    expect(bare.motionAssigns).toBeUndefined();
    expect(bare.motionChain).toBeUndefined();
  });
});
