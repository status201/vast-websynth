import { describe, it, expect } from 'vitest';
import { demoMetaOf, demoSummary, type DemoMeta } from '../../src/state/demo-meta';
import type { SongFile } from '../../src/state/song';
import { SEQ_LENGTH, DRUM_TRACK_COUNT, BANK_COUNT } from '../../src/state/patterns';

/**
 * specs/features/demo-library.md. Built from hand-made fixtures, never from a
 * named shipped demo — `tests/no-shipped-demo-names.test.ts` enforces that, and
 * the point of the extractor is that it works on any song.
 */

const offSeq = () => Array.from({ length: SEQ_LENGTH }, () => ({ on: false, note: 60, velocity: 0.85, gate: 0.5 }));
const offTrig = () => Array.from({ length: SEQ_LENGTH }, () => ({ on: false }));
const seqBanks = () => Array.from({ length: BANK_COUNT }, offSeq);
const drumBanks = () =>
  Array.from({ length: BANK_COUNT }, () => Array.from({ length: DRUM_TRACK_COUNT }, offTrig));

function song(over: Partial<SongFile> = {}): SongFile {
  return {
    format: 'websynth-song',
    version: 7,
    name: 'Fixture',
    params: {},
    seqBanks: seqBanks(),
    drumBanks: drumBanks(),
    seqChain: { enabled: false, steps: [0] },
    drumChain: { enabled: false, steps: [0] },
    ...over,
  } as SongFile;
}

describe('demoMetaOf — the facts (REQ-1)', () => {
  it('reads tempo, length and the machines that will sound', () => {
    const f = song({ params: { 'transport.bpm': 124 } });
    f.seqBanks[0]![0]!.on = true;
    f.drumBanks[0]![0]![0]!.on = true;
    f.seqChain = { enabled: true, steps: [0, 0, 1, 0] };
    const meta = demoMetaOf(f);
    expect(meta).toMatchObject({ name: 'Fixture', bpm: 124, bars: 4, uses: ['seq', 'drums'] });
    expect(meta.armed).toBeUndefined();
  });

  it('takes bars from the LONGEST enabled lane, and ignores disabled ones (REQ-5)', () => {
    const f = song({
      seqChain: { enabled: true, steps: [0, 0] },
      drumChain: { enabled: true, steps: [0, 0, 0, 0, 0] },
      motionChain: { enabled: false, steps: Array.from({ length: 40 }, () => 0) },
    });
    expect(demoMetaOf(f).bars).toBe(5);
  });

  it('reports 0 bars when no lane is enabled, rather than guessing', () => {
    expect(demoMetaOf(song()).bars).toBe(0);
  });

  it('counts a sequencer track 2-4 as seq, not as nothing (v6 seqTracks)', () => {
    const f = song();
    const track = offSeq();
    track[0]!.on = true;
    f.seqTracks = [[null, track, null, null], [], [], []];
    expect(demoMetaOf(f).uses).toEqual(['seq']);
  });

  it('lists machines in a stable order regardless of which are present', () => {
    const f = song({ params: { 'motion.on': 1 } });
    f.drumBanks[0]![0]![0]!.on = true;
    f.samplerBanks = Array.from({ length: BANK_COUNT }, () => Array.from({ length: 8 }, offTrig));
    f.samplerBanks[0]![0]![0]!.on = true;
    f.motionBanks = Array.from({ length: BANK_COUNT }, () =>
      Array.from({ length: SEQ_LENGTH }, () => ({ on: false, x: 0.5, y: 0.5 })));
    f.motionBanks[0]![0] = { on: true, x: 0.2, y: 0.8 };
    expect(demoMetaOf(f).uses).toEqual(['drums', 'sampler', 'motion']);
  });
});

describe('demoMetaOf — armed vs used (REQ-4)', () => {
  it('reports an armed arp as armed, never as used', () => {
    // The arp follows the keyboard/MIDI and never the sequencer
    // (arpeggiator.md REQ-7), so it can only ever be armed.
    const meta = demoMetaOf(song({ params: { 'arp.on': 1 } }));
    expect(meta.armed).toEqual(['arp']);
    expect(meta.uses).not.toContain('arp');
  });

  it('reports motion data behind motion.on 0 as armed, not as missing', () => {
    const f = song({ params: { 'motion.on': 0 } });
    f.motionBanks = Array.from({ length: BANK_COUNT }, () =>
      Array.from({ length: SEQ_LENGTH }, () => ({ on: false, x: 0.5, y: 0.5 })));
    f.motionBanks[0]![0] = { on: true, x: 0.2, y: 0.8 };
    const meta = demoMetaOf(f);
    expect(meta.armed).toEqual(['motion']);
    expect(meta.uses).not.toContain('motion');
  });

  it('the same motion data with motion.on 1 is used, not armed', () => {
    const f = song({ params: { 'motion.on': 1 } });
    f.motionBanks = Array.from({ length: BANK_COUNT }, () =>
      Array.from({ length: SEQ_LENGTH }, () => ({ on: false, x: 0.5, y: 0.5 })));
    f.motionBanks[0]![0] = { on: true, x: 0.2, y: 0.8 };
    const meta = demoMetaOf(f);
    expect(meta.uses).toContain('motion');
    expect(meta.armed).toBeUndefined();
  });

  it('never reports a staged effect — it measured as noise, not signal', () => {
    // "Any bypassed effect with a non-default param" fires on 13 of the 15
    // shipped demos; "on but mix pinned to 0" fires on none. Neither is a hint.
    // demo-library.md REQ-4 holds the measurement; this pins the decision.
    const f = song({
      params: { 'fx.wah.on': 0, 'fx.wah.rate': 0.61, 'fx.wah.depth': 0.1, 'fx.reverb.on': 1, 'fx.reverb.mix': 0 },
    });
    expect(demoMetaOf(f).armed).toBeUndefined();
  });
});

describe('demoSummary — what the button says (REQ-6)', () => {
  const base: DemoMeta = { name: 'X', bpm: 124, bars: 16, uses: ['seq', 'drums'] };

  it('joins the facts', () => {
    expect(demoSummary(base)).toBe('124 BPM · 16 bars · seq + drums');
  });

  it('appends the armed hints and then the blurb', () => {
    expect(demoSummary({ ...base, armed: ['arp'], blurb: 'A note.' }))
      .toBe('124 BPM · 16 bars · seq + drums · hold a key: arp armed — A note.');
  });

  it('omits unknown facts instead of printing zeroes', () => {
    expect(demoSummary({ name: 'X', bpm: 0, bars: 0, uses: [] })).toBe('');
    expect(demoSummary({ name: 'X', bpm: 0, bars: 0, uses: [], blurb: 'Only prose.' }))
      .toBe('Only prose.');
  });

  it('singularises a one-bar song', () => {
    expect(demoSummary({ ...base, bars: 1 })).toContain('1 bar ');
  });
});
