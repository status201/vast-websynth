// midi-file-reader.md — the SMF parser and the arranger's analysis. Every file is
// built byte by byte by tests/fixtures/smf.ts.
import { describe, it, expect } from 'vitest';
import { parseMidiFile, analyzeMidi, type MidiFile, type MidiAnalysis } from '../../src/state/midi-file';
import { MAX_MIDI_FILE_BYTES, MAX_MIDI_TRACKS, MAX_MIDI_BARS, MAX_MIDI_SUMMARY_BARS, MAX_MIDI_NAME_CHARS } from '../../src/state/limits';
import {
  smf, header, track, chunk, on, off, program, tempo, meter, trackName, notesFile, vlq,
} from '../fixtures/smf';

function parsed(bytes: Uint8Array): { file: MidiFile; warnings: string[] } {
  const p = parseMidiFile(bytes);
  if (!p.ok) throw new Error(p.errors.join('; '));
  return p;
}

function analysed(bytes: Uint8Array, opts?: Parameters<typeof analyzeMidi>[1]): MidiAnalysis {
  const a = analyzeMidi(parsed(bytes).file, opts);
  if (!a.ok) throw new Error(a.errors.join('; '));
  return a;
}

const errorOf = (bytes: Uint8Array): string => {
  const p = parseMidiFile(bytes);
  expect(p.ok).toBe(false);
  return p.ok ? '' : p.errors.join('; ');
};

describe('parseMidiFile (REQ-smf-format-0-and-1-are-read)', () => {
  it('reads format 0 with running status and velocity-0 note-offs', () => {
    // 0x90 once, then running status; the offs are note-ons at velocity 0.
    const { file, warnings } = parsed(smf(header(0, 1, 96), track([
      [0, 0x90, 60, 100], [48, 60, 0], [0, 64, 90], [96, 64, 0],
    ])));
    expect(file.format).toBe(0);
    expect(file.ppq).toBe(96);
    expect(file.notes).toEqual([
      { tick: 0, dur: 48, note: 60, velocity: 100, channel: 0, track: 0 },
      { tick: 48, dur: 96, note: 64, velocity: 90, channel: 0, track: 0 },
    ]);
    expect(warnings).toEqual([]);
  });

  it('keeps tempo, meter, track names and programs from a format-1 file', () => {
    const { file } = parsed(smf(
      header(1, 3, 96),
      track([[0, ...tempo(138)], [0, ...meter(3, 2)]]),
      track([[0, ...trackName('Lead')], [0, ...program(0, 40)], [0, ...on(0, 72)], [96, ...off(0, 72)]]),
      track([[0, ...trackName('Bass')], [0, ...program(1, 32)], [0, ...on(1, 40)], [192, ...off(1, 40)]]),
    ));
    expect(file.format).toBe(1);
    expect(file.tempos).toEqual([{ tick: 0, bpm: 138 }]);
    expect(file.meters).toEqual([{ tick: 0, num: 3, den: 4 }]);
    expect(file.trackNames).toEqual(['', 'Lead', 'Bass']);
    expect(file.programs).toEqual([{ tick: 0, channel: 0, program: 40 }, { tick: 0, channel: 1, program: 32 }]);
    expect(file.notes.map((n) => [n.note, n.track, n.channel])).toEqual([[40, 2, 1], [72, 1, 0]]);
  });

  it('skips sysex and unknown chunks', () => {
    const { file } = parsed(smf(
      header(0, 1, 96),
      chunk('XFIH', [1, 2, 3, 4]),
      track([[0, 0xf0, 3, 0x7e, 0x01, 0xf7], [0, ...on(0, 60)], [24, ...off(0, 60)]]),
    ));
    expect(file.notes).toHaveLength(1);
    expect(file.notes[0]).toMatchObject({ tick: 0, dur: 24, note: 60 });
  });
});

describe('hostile and broken files (REQ-a-midi-parse-never-throws, REQ-a-midi-file-is-bounded)', () => {
  const good = smf(header(0, 1, 96), track([[0, ...on(0, 60)], [24, ...off(0, 60)]]));

  it('refuses each with a named error', () => {
    expect(errorOf(good.slice(0, good.length - 3))).toMatch(/runs past the end of the file/);
    expect(errorOf(smf(header(0, 1, 96), chunk('MTrk', [0x81, 0x81, 0x81, 0x81, 0x01, ...on(0, 60)]))))
      .toMatch(/longer than 4 bytes/);
    expect(errorOf(smf(header(2, 1, 96), track([])))).toMatch(/format 2/);
    expect(errorOf(smf(header(0, 1, 0xe728), track([])))).toMatch(/SMPTE/);
    expect(errorOf(smf(header(0, 1, 0), track([])))).toMatch(/0 ticks per quarter/);
    expect(errorOf(smf(header(0, 1, 96), track([[0, 60, 100]])))).toMatch(/no status before it/);
    expect(errorOf(smf(header(0, 1, 96)))).toMatch(/no MTrk/);
    expect(errorOf(new Uint8Array(MAX_MIDI_FILE_BYTES + 1))).toMatch(String(MAX_MIDI_FILE_BYTES));
    const many = Array.from({ length: MAX_MIDI_TRACKS + 1 }, () => track([]));
    expect(errorOf(smf(header(1, MAX_MIDI_TRACKS + 1, 96), ...many))).toMatch(`more than ${MAX_MIDI_TRACKS} tracks`);
  });

  it('names MThd and nothing of the bytes when the file is not MIDI', () => {
    const err = errorOf(new TextEncoder().encode('secret: hunter2 and more text here'));
    expect(err).toMatch(/MThd/);
    expect(err).not.toMatch(/secret|hunter2/);
  });

  it('never throws on random bytes behind a valid header', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    for (let k = 0; k < 500; k++) {
      const body = Array.from({ length: 1 + (k % 97) }, rnd);
      const bytes = smf(header(k % 2, 1, 96), chunk('MTrk', body));
      const p = parseMidiFile(bytes);
      expect(typeof p.ok).toBe('boolean');
      if (p.ok) expect(() => analyzeMidi(p.file)).not.toThrow();
    }
  });

  it('cuts and cleans a track name', () => {
    const raw = 'Na\u0007me\n' + 'x'.repeat(200);
    const { file } = parsed(smf(header(0, 1, 96), track([[0, ...trackName(raw)]])));
    expect(file.trackNames[0]).toHaveLength(MAX_MIDI_NAME_CHARS);
    expect(file.trackNames[0]!.startsWith('Namexxx')).toBe(true);
  });

  it('refuses a far-future note instead of building millions of bars', () => {
    const p = parsed(notesFile([[2 ** 27, 24, 60]]));
    const a = analyzeMidi(p.file);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.errors[0]).toMatch(String(MAX_MIDI_BARS));
  });
});

describe('REQ-notes-pair-per-channel-and-pitch', () => {
  it('closes overlaps and dangling notes, and counts them', () => {
    const { file, warnings } = parsed(smf(header(0, 1, 96), track([
      [0, ...on(0, 60)], [24, ...on(0, 60)], [24, ...off(0, 60)], [0, ...off(0, 60)], [0, ...on(0, 62)],
    ])));
    expect(file.notes.map((n) => [n.tick, n.dur, n.note])).toEqual([[0, 24, 60], [24, 24, 60], [48, 0, 62]]);
    expect(warnings).toHaveLength(3);
    expect(warnings.join(' ')).toMatch(/restarted.*no note to close.*end of their track/s);
  });

  it('keeps the same pitch on two channels apart', () => {
    const { file } = parsed(notesFile([[0, 48, 60, 0], [0, 24, 60, 1]]));
    expect(file.notes.map((n) => [n.channel, n.dur]).sort()).toEqual([[0, 48], [1, 24]]);
  });
});

describe('REQ-bars-follow-the-file-meter', () => {
  it('starts bar 3 after two 4/4 bars when 3/4 begins, and reports only real changes', () => {
    // 4/4, a re-stated 4/4 at bar 2, then 3/4 from bar 3 (tick 768); bar 4 starts at 768 + 288.
    const metas: [number, number[]][] = [[0, meter(4, 2)], [384, meter(4, 2)], [768, meter(3, 2)]];
    const a = analysed(notesFile([[0, 24, 60], [768, 24, 62], [1056, 24, 64]], 96, metas));
    expect(a.meter.first).toBe('4/4');
    expect(a.meter.changes).toEqual([{ bar: 3, meter: '3/4' }]);
    const bar = (n: number) => a.listing.find((l) => l.bar === n)!;
    expect(bar(3).meter).toBe('3/4');
    expect(bar(2).meter).toBeUndefined();
    expect(bar(4).channels['1']).toBe('0:E4/1');
    expect(a.bars).toBe(4);
  });

  it('lists positions and lengths in sixteenths', () => {
    const a = analysed(notesFile([[0, 96, 60], [48, 24, 64], [400, 12, 67]]));
    expect(a.listing[0]!.channels['1']).toBe('0:C4/4 2:E4/1');
    expect(a.listing[1]!.channels['1']).toBe('0.67:G4/0.5');
  });
});

describe('REQ-the-grid-is-the-coarsest-that-holds-every-onset', () => {
  const grid = (ticks: number[]) => analysed(notesFile(ticks.map((t) => [t, 12, 60] as [number, number, number]))).grid;

  it('finds eighths and suggests two bars per bank', () => {
    const a = analysed(notesFile([[0, 24, 60], [48, 24, 62], [96, 24, 64], [432, 24, 65]]));
    expect(a.grid).toEqual({ divisions: 2, label: '1/8', offGrid16: 0 });
    expect(a.suggestion).toMatch(/seq\.rate 5/);
    expect(a.suggestion).toMatch(/seq\.len 16 holds 2 bars per bank/);
  });

  it('refines to sixteenths, triplets or free', () => {
    expect(grid([0, 48, 24]).label).toBe('1/16');
    expect(grid([0, 48, 32]).label).toBe('1/16T');
    expect(grid([0, 32, 64]).label).toBe('1/8T');
    const free = grid([0, 5]);
    expect(free.divisions).toBe('free');
    expect(free.offGrid16).toBe(1);
  });
});

describe('REQ-the-analysis-names-the-parts', () => {
  it('reports instrument, range and polyphony per channel', () => {
    const a = analysed(smf(header(0, 1, 96), track([
      [0, ...program(0, 42)], [0, ...on(0, 36)], [0, ...on(0, 43)], [96, ...off(0, 36)], [0, ...off(0, 43)],
    ])));
    expect(a.channels).toEqual([
      { channel: 1, instrument: 'Cello', notes: 2, range: 'C2-G2', maxPolyphony: 2, grid: '1/4' },
    ]);
  });

  it('reports channel 10 as drums with the websynth mapping', () => {
    const a = analysed(notesFile([[0, 12, 36, 9], [96, 12, 38, 9], [48, 12, 42, 9]]));
    const drums = a.channels[0]!;
    expect(drums.instrument).toBe('drums');
    expect(drums.drums!.map((d) => d.websynth)).toEqual(['kick', 'snare', 'chat']);
    expect(a.listing[0]!.channels['10']).toBe('0:BassDrum1/0.5 2:ClosedHiHat/0.5 4:AcousticSnare/0.5');
  });
});

describe('REQ-the-listing-is-a-window-of-bars', () => {
  const long = notesFile(Array.from({ length: 70 }, (_, i) => [i * 384, 24, 60, i % 2] as [number, number, number, number]));

  it('stops at the cap and names the next bar', () => {
    const a = analysed(long);
    expect(a.listing).toHaveLength(MAX_MIDI_SUMMARY_BARS);
    expect(a.window).toEqual({ fromBar: 1, toBar: MAX_MIDI_SUMMARY_BARS, truncated: true, nextBar: MAX_MIDI_SUMMARY_BARS + 1 });
    const rest = analysed(long, { fromBar: a.window.nextBar });
    expect(rest.window).toEqual({ fromBar: 65, toBar: 70, truncated: false });
  });

  it('lists only the asked channels', () => {
    const a = analysed(long, { fromBar: 1, toBar: 4, channels: [2] });
    expect(a.listing.map((l) => Object.keys(l.channels))).toEqual([[], ['2'], [], ['2']]);
  });
});

describe('REQ-repeats-are-grouped', () => {
  it('groups bars with the same onsets and pitches, whatever their lengths', () => {
    const a = analysed(notesFile([
      [0, 24, 60], [48, 24, 64],              // bar 1
      [384, 24, 60], [432, 24, 65],           // bar 2: one pitch changed
      [768, 48, 60], [816, 24, 64],           // bar 3: bar 1 with a longer note
    ]));
    expect(a.repeats).toEqual([{ bars: [1, 3] }]);
    expect(a.distinctBars).toEqual({ all: 2, byChannel: { 1: 2 } });
  });
});

// The fixture's own VLQ writer, so a broken writer cannot pass the parser tests.
it('the SMF fixture writes VLQs as the spec does', () => {
  expect(vlq(0)).toEqual([0]);
  expect(vlq(0x7f)).toEqual([0x7f]);
  expect(vlq(0x80)).toEqual([0x81, 0x00]);
  expect(vlq(0x0fffffff)).toEqual([0xff, 0xff, 0xff, 0x7f]);
});
