import { describe, it, expect } from 'vitest';
import { isAuthorSong, expandAuthorSong, AUTHOR_FORMAT } from '../../src/state/song-author';
import { validateSongFile } from '../../src/state/song-validate';
import type { SongFile } from '../../src/state/song';
import { SEQ_LENGTH, BANK_COUNT, DRUM_TRACK_COUNT, SAMPLER_SLOT_COUNT } from '../../src/state/patterns';

/** A minimal valid author file to spread per-test variations over. */
function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { format: AUTHOR_FORMAT, version: 1, name: 'Test', ...extra };
}

function expandOk(value: unknown): SongFile {
  const res = expandAuthorSong(value);
  if (!res.ok) throw new Error('expected ok, got errors:\n' + res.errors.join('\n'));
  return res.file;
}

function expandErrors(value: unknown): string[] {
  const res = expandAuthorSong(value);
  if (res.ok) throw new Error('expected errors, got ok');
  return res.errors;
}

describe('isAuthorSong', () => {
  it('detects the author format marker only', () => {
    expect(isAuthorSong(base())).toBe(true);
    expect(isAuthorSong({ format: 'websynth-song' })).toBe(false);
    expect(isAuthorSong(null)).toBe(false);
    expect(isAuthorSong([])).toBe(false);
    expect(isAuthorSong('websynth-song-author')).toBe(false);
  });
});

describe('expandAuthorSong — happy path', () => {
  it('a minimal file expands to a canonical v3 SongFile with empty grids', () => {
    const file = expandOk(base());
    expect(file.format).toBe('websynth-song');
    expect(file.version).toBe(3);
    expect(file.name).toBe('Test');
    expect(file.params).toEqual({});
    expect(file.seqBanks).toHaveLength(BANK_COUNT);
    expect(file.seqBanks[0]).toHaveLength(SEQ_LENGTH);
    expect(file.drumBanks).toHaveLength(BANK_COUNT);
    expect(file.drumBanks[0]).toHaveLength(DRUM_TRACK_COUNT);
    expect(file.drumBanks[0]![0]).toHaveLength(SEQ_LENGTH);
    expect(file.seqChain).toEqual({ enabled: false, steps: [0] });
    expect(file.drumChain).toEqual({ enabled: false, steps: [0] });
    // No sampler content → no sampler fields (like a v1/v2 canonical file).
    expect(file.samplerBanks).toBeUndefined();
    expect(file.samplerChain).toBeUndefined();
    expect(file.sampleNames).toBeUndefined();
    expect(file.xy).toBeUndefined();
  });

  it('sparse params pass through; sparse means sparse', () => {
    const file = expandOk(base({ params: { 'transport.bpm': 124, 'filter.cutoff': 66 } }));
    expect(file.params).toEqual({ 'transport.bpm': 124, 'filter.cutoff': 66 });
  });

  it('the plan example expands: positional seq bank + drum hit lists', () => {
    const file = expandOk(base({
      seq: [['A2', null, 'A2', { note: 'C3', gate: 0.8 }]],
      drums: [{ kick: [0, 4, 8, 12], snare: [{ step: 15, ratchet: 3 }], chat: [0, 2, 4, 6] }],
    }));
    const bank = file.seqBanks[0]!;
    expect(bank[0]).toEqual({ on: true, note: 45, velocity: 0.85, gate: 0.5, prob: 1, ratchet: 1, tie: false });
    expect(bank[1]!.on).toBe(false);
    expect(bank[2]!.note).toBe(45);
    expect(bank[3]).toEqual({ on: true, note: 48, velocity: 0.85, gate: 0.8, prob: 1, ratchet: 1, tie: false });
    // Short bank rest-padded to 16
    for (let i = 4; i < SEQ_LENGTH; i++) expect(bank[i]!.on).toBe(false);
    const drums = file.drumBanks[0]!;
    expect(drums[0]!.filter((c) => c.on)).toHaveLength(4);
    expect(drums[0]![4]!.on).toBe(true);
    expect(drums[1]![15]).toEqual({ on: true, velocity: 0.85, gate: 1, prob: 1, ratchet: 3, tie: false });
    expect(drums[2]![6]!.on).toBe(true);
    // Untouched banks stay empty
    expect(file.drumBanks[1]!.every((row) => row.every((c) => !c.on))).toBe(true);
  });
});

describe('note parsing', () => {
  const noteOf = (entry: unknown) => expandOk(base({ seq: [[entry]] })).seqBanks[0]![0]!;

  it('maps note names with C4 = 60, sharps and flats', () => {
    expect(noteOf('C4').note).toBe(60);
    expect(noteOf('c4').note).toBe(60);
    expect(noteOf('C#4').note).toBe(61);
    expect(noteOf('Db4').note).toBe(61);
    expect(noteOf('A2').note).toBe(45);
    expect(noteOf('A0').note).toBe(21);
    expect(noteOf('G9').note).toBe(127);
    expect(noteOf('C-1').note).toBe(0);
    expect(noteOf('Bb3').note).toBe(58);
  });

  it('0 is a valid MIDI note; null is the rest', () => {
    const zero = noteOf(0);
    expect(zero.on).toBe(true);
    expect(zero.note).toBe(0);
    expect(noteOf(null).on).toBe(false);
  });

  it('rejects out-of-range and malformed notes', () => {
    expect(expandErrors(base({ seq: [[128]] }))[0]).toMatch(/seq\[0\]\[0\].*0\.\.127/);
    expect(expandErrors(base({ seq: [[-1]] }))[0]).toMatch(/0\.\.127/);
    expect(expandErrors(base({ seq: [['H4']] }))[0]).toMatch(/note name/);
    expect(expandErrors(base({ seq: [['C#']] }))[0]).toMatch(/note name/);
    expect(expandErrors(base({ seq: [['G10']] }))[0]).toMatch(/0\.\.127/);
    expect(expandErrors(base({ seq: [[true]] }))[0]).toMatch(/seq\[0\]\[0\]/);
  });
});

describe('seq banks', () => {
  it('bank-defaults form applies settings to every ON step', () => {
    const file = expandOk(base({
      seq: [{ notes: ['A2', 'A2', 'A3', null], gate: 0.4, velocity: 0.9 }],
    }));
    const bank = file.seqBanks[0]!;
    expect(bank[0]).toMatchObject({ on: true, note: 45, gate: 0.4, velocity: 0.9 });
    expect(bank[2]).toMatchObject({ on: true, note: 57, gate: 0.4 });
    expect(bank[3]!.on).toBe(false);
  });

  it('per-entry objects override bank defaults', () => {
    const file = expandOk(base({
      seq: [{ notes: [{ note: 'C3', gate: 0.9, tie: true }], gate: 0.4 }],
    }));
    expect(file.seqBanks[0]![0]).toMatchObject({ gate: 0.9, tie: true });
  });

  it('missing banks are empty; more than 4 banks errors', () => {
    const file = expandOk(base({ seq: [['C4']] }));
    expect(file.seqBanks[1]!.every((s) => !s.on)).toBe(true);
    expect(file.seqBanks[3]!.every((s) => !s.on)).toBe(true);
    expect(expandErrors(base({ seq: [[], [], [], [], []] }))[0]).toMatch(/4/);
  });

  it('a bank longer than 16 steps errors', () => {
    expect(expandErrors(base({ seq: [Array(17).fill('C4')] }))[0]).toMatch(/16/);
  });

  it('bad step-setting values error with authoring paths', () => {
    const errs = expandErrors(base({ seq: [[{ note: 'C4', velocity: 2 }]] }));
    expect(errs[0]).toMatch(/seq\[0\]\[0\]\.velocity.*0\.\.1/);
    expect(expandErrors(base({ seq: [[{ note: 'C4', ratchet: 5 }]] }))[0]).toMatch(/1\.\.4/);
    expect(expandErrors(base({ seq: [[{ note: 'C4', tie: 1 }]] }))[0]).toMatch(/boolean/);
    expect(expandErrors(base({ seq: [[{ gate: 0.5 }]] }))[0]).toMatch(/note is required/);
    expect(expandErrors(base({ seq: 'C4' }))[0]).toMatch(/seq must be an array/);
    expect(expandErrors(base({ seq: [42] }))[0]).toMatch(/seq\[0\]/);
    expect(expandErrors(base({ seq: [{ steps: [] }] }))[0]).toMatch(/notes/);
    expect(expandErrors(base({ seq: [{ notes: [], swing: 1 }] }))[0]).toMatch(/swing/);
  });
});

describe('drum + sampler hit banks', () => {
  it('accepts every documented track alias', () => {
    const aliases: Record<string, number> = {
      kick: 0, snare: 1,
      chat: 2, hat: 2, hihat: 2, closedhat: 2,
      ohat: 3, openhat: 3,
      ltom: 4, lowtom: 4, mtom: 5, midtom: 5, htom: 6, hightom: 6,
      clap: 7,
    };
    for (const [key, track] of Object.entries(aliases)) {
      const file = expandOk(base({ drums: [{ [key]: [3] }] }));
      expect(file.drumBanks[0]![track]![3]!.on, key).toBe(true);
    }
  });

  it('normalizes casing and punctuation in track keys ("C.Hat", "O-Hat")', () => {
    const file = expandOk(base({ drums: [{ 'C.Hat': [1], 'O-Hat': [2], KICK: [0] }] }));
    expect(file.drumBanks[0]![2]![1]!.on).toBe(true);
    expect(file.drumBanks[0]![3]![2]!.on).toBe(true);
    expect(file.drumBanks[0]![0]![0]!.on).toBe(true);
  });

  it('numeric keys "0".."7" address tracks directly', () => {
    const file = expandOk(base({ drums: [{ '7': [12] }] }));
    expect(file.drumBanks[0]![7]![12]!.on).toBe(true);
  });

  it('an unknown track key errors and lists the valid names', () => {
    const errs = expandErrors(base({ drums: [{ cowbell: [0] }] }));
    expect(errs[0]).toMatch(/cowbell/);
    expect(errs[0]).toMatch(/kick/);
    expect(errs[0]).toMatch(/clap/);
  });

  it('hit objects carry per-step settings; bad steps error', () => {
    const file = expandOk(base({ drums: [{ ohat: [{ step: 2, gate: 0.4, prob: 0.6 }] }] }));
    expect(file.drumBanks[0]![3]![2]).toMatchObject({ on: true, gate: 0.4, prob: 0.6 });
    expect(expandErrors(base({ drums: [{ kick: [16] }] }))[0]).toMatch(/0\.\.15/);
    expect(expandErrors(base({ drums: [{ kick: [1.5] }] }))[0]).toMatch(/integer/);
    expect(expandErrors(base({ drums: [{ kick: [{ velocity: 1 }] }] }))[0]).toMatch(/step/);
    expect(expandErrors(base({ drums: [{ kick: 4 }] }))[0]).toMatch(/array of hits/);
    expect(expandErrors(base({ drums: [[0, 4]] }))[0]).toMatch(/drums\[0\]/);
  });

  it('sampler banks use s1..s8 or numeric slot keys', () => {
    const file = expandOk(base({ sampler: [{ s1: [0, 8], '7': [4] }] }));
    expect(file.samplerBanks![0]![0]![0]!.on).toBe(true);
    expect(file.samplerBanks![0]![0]![8]!.on).toBe(true);
    expect(file.samplerBanks![0]![7]![4]!.on).toBe(true);
    expect(expandErrors(base({ sampler: [{ s9: [0] }] }))[0]).toMatch(/s1\.\.s8/);
  });
});

describe('chains', () => {
  it('string shorthand: letters + "."/"-" rests, whitespace ignored, implies enabled', () => {
    const file = expandOk(base({ seqChain: 'A A B A', drumChain: 'ab.d-' }));
    expect(file.seqChain).toEqual({ enabled: true, steps: [0, 0, 1, 0] });
    expect(file.drumChain).toEqual({ enabled: true, steps: [0, 1, -1, 3, -1] });
  });

  it('int-array shorthand implies enabled and accepts -1 rests', () => {
    const file = expandOk(base({ drumChain: [0, 0, 0, 1], seqChain: [0, -1, 2] }));
    expect(file.drumChain).toEqual({ enabled: true, steps: [0, 0, 0, 1] });
    expect(file.seqChain).toEqual({ enabled: true, steps: [0, -1, 2] });
  });

  it('the full object form is passed through', () => {
    const file = expandOk(base({ seqChain: { enabled: false, steps: [1, 2] } }));
    expect(file.seqChain).toEqual({ enabled: false, steps: [1, 2] });
  });

  it('bad chains error in authoring terms', () => {
    expect(expandErrors(base({ seqChain: 'AXB' }))[0]).toMatch(/bank letter "X"/);
    expect(expandErrors(base({ seqChain: '' }))[0]).toMatch(/empty/);
    expect(expandErrors(base({ seqChain: [4] }))[0]).toMatch(/0\.\.3/);
    expect(expandErrors(base({ seqChain: [] }))[0]).toMatch(/at least 1/);
    expect(expandErrors(base({ seqChain: 42 }))[0]).toMatch(/seqChain/);
    expect(expandErrors(base({ seqChain: { enabled: 'yes', steps: [0] } }))[0]).toMatch(/boolean/);
  });
});

describe('sampler presence + passthrough fields', () => {
  it('sampler fields are emitted only when the author provided sampler content', () => {
    expect(expandOk(base()).samplerBanks).toBeUndefined();
    const withBanks = expandOk(base({ sampler: [{ s1: [0] }] }));
    expect(withBanks.samplerBanks).toHaveLength(BANK_COUNT);
    expect(withBanks.samplerChain).toEqual({ enabled: false, steps: [0] });
    expect(withBanks.sampleNames).toEqual(Array(SAMPLER_SLOT_COUNT).fill(null));
    const withChain = expandOk(base({ samplerChain: 'AB' }));
    expect(withChain.samplerBanks).toHaveLength(BANK_COUNT);
    const withNames = expandOk(base({ sampleNames: ['kick.wav'] }));
    expect(withNames.sampleNames).toEqual(['kick.wav', null, null, null, null, null, null, null]);
  });

  it('sampleNames longer than 8 or with bad entries errors', () => {
    expect(expandErrors(base({ sampleNames: Array(9).fill(null) }))[0]).toMatch(/8/);
    expect(expandErrors(base({ sampleNames: [42] }))[0]).toMatch(/sampleNames\[0\]/);
  });

  it('xy passes through; bad xy errors', () => {
    const file = expandOk(base({ xy: { x: 'filter.cutoff', y: 'filter.resonance' } }));
    expect(file.xy).toEqual({ x: 'filter.cutoff', y: 'filter.resonance' });
    expect(expandErrors(base({ xy: { x: 'filter.cutoff' } }))[0]).toMatch(/xy\.y/);
    expect(expandErrors(base({ xy: 'cutoff' }))[0]).toMatch(/xy must be/);
  });
});

describe('top-level validation', () => {
  it('rejects non-objects and wrong format/version/name', () => {
    expect(expandAuthorSong(null)).toMatchObject({ ok: false });
    expect(expandAuthorSong('x')).toMatchObject({ ok: false });
    expect(expandErrors({ format: 'nope', version: 1, name: 'X' })[0]).toMatch(/format/);
    expect(expandErrors(base({ version: 2 }))[0]).toMatch(/version must be 1/);
    expect(expandErrors({ format: AUTHOR_FORMAT, version: 1 })[0]).toMatch(/name/);
  });

  it('rejects canonical grid keys with a pointed form-mixing error', () => {
    const errs = expandErrors(base({ seqBanks: [] }));
    expect(errs[0]).toMatch(/websynth-song/);
    expect(errs[0]).toMatch(/full-form/);
    expect(expandErrors(base({ drumBanks: [] }))[0]).toMatch(/drumBanks/);
    expect(expandErrors(base({ samplerBanks: [] }))[0]).toMatch(/samplerBanks/);
  });

  it('rejects unknown top-level keys, tolerates $schema', () => {
    const errs = expandErrors(base({ drum: [{ kick: [0] }] }));
    expect(errs[0]).toMatch(/unknown field "drum"/);
    expect(errs[0]).toMatch(/drums/); // the allowed-keys list points at the fix
    expect(expandOk(base({ $schema: 'https://example.com/schema.json' })).format).toBe('websynth-song');
  });

  it('bad params error with the param id in the path', () => {
    expect(expandErrors(base({ params: { 'transport.bpm': 'fast' } }))[0]).toMatch(/params\.transport\.bpm/);
    expect(expandErrors(base({ params: [1] }))[0]).toMatch(/params must be/);
  });

  it('caps the reported errors', () => {
    const errs = expandErrors(base({ seq: [Array(16).fill('nope')], drums: [Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`bad${i}`, [0]]),
    )] }));
    expect(errs.length).toBeLessThanOrEqual(50);
  });
});

describe('property: expanded output always passes validateSongFile', () => {
  const samples: Record<string, unknown>[] = [
    base(),
    base({ seq: [['A2', null, 'A2', { note: 'C3', gate: 0.8 }], { notes: ['A2', 'A2', 'A3', 'A2'], gate: 0.4, velocity: 0.9 }] }),
    base({ drums: [{ kick: [0, 4, 8, 12], snare: [{ step: 15, ratchet: 3 }], chat: [0, 2, 4, 6] }] }),
    base({ sampler: [{ s1: [0, 8] }], sampleNames: ['kick.wav'] }),
    base({ seqChain: 'AABA', drumChain: [0, 0, 0, 1], samplerChain: { enabled: true, steps: [0, -1] } }),
    base({ params: { 'transport.bpm': 124 }, xy: { x: 'filter.cutoff', y: 'filter.resonance' } }),
  ];

  it.each(samples.map((s, i) => [i, s] as const))('sample %i', (_i, sample) => {
    const file = expandOk(sample);
    const res = validateSongFile(file);
    expect(res.ok, res.ok ? '' : (res as { errors: string[] }).errors.join('\n')).toBe(true);
  });
});

describe('expandAuthorSong — machines with hits auto-enable (REQ-11)', () => {
  it('sets seq.on/drum.on when banks have hits and params omit them', () => {
    const file = expandOk(base({
      seq: [['A2', null, 'C3']],
      drums: [{ kick: [0, 4, 8, 12] }],
    }));
    expect(file.params['seq.on']).toBe(1);
    expect(file.params['drum.on']).toBe(1);
    expect(file.params['sampler.on']).toBeUndefined(); // no sampler content
  });

  it('sets sampler.on only when sampler content has hits', () => {
    const withHits = expandOk(base({ sampler: [{ s1: [0, 8] }] }));
    expect(withHits.params['sampler.on']).toBe(1);
    // Sampler fields present (sampleNames) but every bank empty → no injection.
    const noHits = expandOk(base({ sampleNames: ['kick.wav'] }));
    expect(noHits.params['sampler.on']).toBeUndefined();
  });

  it('never overrides an explicit author value', () => {
    const file = expandOk(base({
      drums: [{ kick: [0] }],
      params: { 'drum.on': 0 },
    }));
    expect(file.params['drum.on']).toBe(0);
  });

  it('injects nothing for machines without hits', () => {
    const file = expandOk(base({ params: { 'transport.bpm': 124 } }));
    expect(file.params).toEqual({ 'transport.bpm': 124 });
  });
});

describe('motion dialect (motion-sequencer.md REQ-9)', () => {
  it('expands anchor lists onto the bank grid and emits v4 with motion fields', () => {
    const file = expandOk(base({
      motion: [[{ step: 0, x: 0.5, y: 0 }, { step: 8, x: 0.5, y: 1 }]],
      motionChain: 'AAB',
    }));
    expect(file.version).toBe(4);
    expect(file.motionBanks![0]![0]).toMatchObject({ on: true, x: 0.5, y: 0 });
    expect(file.motionBanks![0]![8]).toMatchObject({ on: true, x: 0.5, y: 1 });
    expect(file.motionBanks![0]![1]!.on).toBe(false);
    expect(file.motionChain).toEqual({ enabled: true, steps: [0, 0, 1] });
    expect(file.motionAssigns).toEqual([null, null, null, null]);
    expect(file.params['motion.on']).toBe(1); // auto-enable
  });

  it('a {assign, steps} bank carries a per-bank axis override', () => {
    const file = expandOk(base({
      motion: [
        [{ step: 0, x: 0, y: 0 }],
        { assign: { x: 'fx.delay.time', y: 'fx.delay.mix' }, steps: [{ step: 4, x: 1, y: 1 }] },
      ],
    }));
    expect(file.motionAssigns![0]).toBeNull();
    expect(file.motionAssigns![1]).toEqual({ x: 'fx.delay.time', y: 'fx.delay.mix' });
    expect(file.motionBanks![1]![4]).toMatchObject({ on: true, x: 1, y: 1 });
  });

  it('a song without motion content stays v3 with no motion fields', () => {
    const file = expandOk(base({ seq: [['A2']] }));
    expect(file.version).toBe(3);
    expect(file.motionBanks).toBeUndefined();
    expect(file.motionAssigns).toBeUndefined();
    expect(file.motionChain).toBeUndefined();
    expect(file.params['motion.on']).toBeUndefined();
  });

  it('motion.on is not auto-enabled for anchor-less motion content, nor overridden', () => {
    const empty = expandOk(base({ motion: [[]] }));
    expect(empty.params['motion.on']).toBeUndefined();
    const explicit = expandOk(base({
      params: { 'motion.on': 0 },
      motion: [[{ step: 0, x: 0.5, y: 0.5 }]],
    }));
    expect(explicit.params['motion.on']).toBe(0);
  });

  it('bad anchors error in authoring terms with paths', () => {
    const errs = expandErrors(base({ motion: [[{ step: 99, x: 0, y: 0 }]] }));
    expect(errs.join('\n')).toContain('motion[0][0].step');
    const errs2 = expandErrors(base({ motion: [[{ step: 0, x: 2, y: 0 }]] }));
    expect(errs2.join('\n')).toContain('motion[0][0].x');
    const errs3 = expandErrors(base({ motion: [[{ step: 0, x: 0 }]] }));
    expect(errs3.join('\n')).toContain('motion[0][0].y is required');
  });

  it('a bad per-bank assign errors; motionBanks is a pointed form-mixing key', () => {
    const errs = expandErrors(base({ motion: [{ assign: { x: '' }, steps: [] }] }));
    expect(errs.join('\n')).toContain('motion[0].assign.x');
    const mixed = expandErrors(base({ motionBanks: [] }));
    expect(mixed.join('\n')).toContain('"motionBanks" is a full-form websynth-song field');
  });
});

describe('expandAuthorSong — extra motion tracks (motion-sequencer.md REQ-17)', () => {
  const base = (extra: Record<string, unknown>) => ({
    format: 'websynth-song-author',
    version: 1,
    name: 'Tracks',
    seq: [[null]],
    ...extra,
  });

  it('expands a track to a canonical v5 file and auto-enables motion', () => {
    const res = expandAuthorSong(base({
      motionTracks: [[{ param: 'fx.delay.mix', steps: [{ step: 0, v: 0 }, { step: 8, v: 1 }] }, null]],
    }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file.version).toBe(5);
    const t = res.file.motionTracks![0]![0]!;
    expect(t.param).toBe('fx.delay.mix');
    expect(t.steps[0]).toEqual({ on: true, v: 0 });
    expect(t.steps[8]).toEqual({ on: true, v: 1 });
    expect(t.steps[1]!.on).toBe(false);
    expect(res.file.params['motion.on']).toBe(1);
  });

  it('an unassigned or empty track expands to null', () => {
    const res = expandAuthorSong(base({ motionTracks: [[{ steps: [] }, null]] }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file.motionTracks![0]).toEqual([null, null]);
    // Nothing to drive, so motion is not switched on.
    expect(res.file.params['motion.on']).toBeUndefined();
  });

  it('rejects an out-of-range step, a bad v, and an unknown field', () => {
    for (const bad of [
      { param: 'a', steps: [{ step: 16, v: 0.5 }] },
      { param: 'a', steps: [{ step: 0, v: 2 }] },
      { param: 'a', steps: [], nope: 1 },
    ]) {
      expect(expandAuthorSong(base({ motionTracks: [[bad, null]] })).ok).toBe(false);
    }
  });

  it('rejects more tracks than the machine has', () => {
    const res = expandAuthorSong(base({
      motionTracks: [[{ param: 'a', steps: [] }, { param: 'b', steps: [] }, { param: 'c', steps: [] }]],
    }));
    expect(res.ok).toBe(false);
  });
});

describe('expandAuthorSong — four sequencer tracks (sequencer.md REQ-13)', () => {
  it('a plain note list still lands on track 1 and expands to v3', () => {
    const res = expandAuthorSong({
      format: 'websynth-song-author', version: 1, name: 'One', seq: [['A2', null, 'A3']],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file.version).toBe(3);       // unchanged from before v6
    expect(res.file.seqTracks).toBeUndefined();
    expect(res.file.seqBanks[0]![0]!.on).toBe(true);
  });

  it('the tracks form expands to v6 with index 0 null', () => {
    const res = expandAuthorSong({
      format: 'websynth-song-author', version: 1, name: 'Chord',
      seq: [{ tracks: [['C3'], ['E3'], ['G3']] }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file.version).toBe(6);
    expect(res.file.seqBanks[0]![0]!.note).toBe(48);        // C3 on track 1
    expect(res.file.seqTracks![0]![0]).toBeNull();
    expect(res.file.seqTracks![0]![1]![0]!.note).toBe(52);   // E3
    expect(res.file.seqTracks![0]![2]![0]!.note).toBe(55);   // G3
  });

  it('the bank-defaults form still works and is not mistaken for tracks', () => {
    const res = expandAuthorSong({
      format: 'websynth-song-author', version: 1, name: 'Defaults',
      seq: [{ notes: ['A2', 'A3'], gate: 0.4 }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file.seqBanks[0]![0]).toMatchObject({ on: true, gate: 0.4 });
  });

  it('rejects more tracks than the sequencer has', () => {
    const res = expandAuthorSong({
      format: 'websynth-song-author', version: 1, name: 'Too many',
      seq: [{ tracks: [['C3'], ['E3'], ['G3'], ['B3'], ['D4']] }],
    });
    expect(res.ok).toBe(false);
  });
});
