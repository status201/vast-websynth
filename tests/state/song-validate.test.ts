import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateSongFile } from '../../src/state/song-validate';
import { Song, DEMO_SONGS } from '../../src/state/song';
import type { SongFile } from '../../src/state/song';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';

/** Deep clone so a test never mutates the shared DEMO_SONGS objects. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Minimal Arrangement stand-in: only the surface Song.capture touches. */
function fakeArr() {
  return {
    seq: { enabled: false, steps: [0] as number[] },
    drum: { enabled: false, steps: [0] as number[] },
    sampler: { enabled: false, steps: [0] as number[] },
  };
}

/** A guaranteed-valid, full-dimension v2 file (independent of the demos). */
function captureValid(): SongFile {
  const bus = new ParamBus();
  registerDefaults(bus);
  const patterns = new PatternStore();
  return Song.capture(bus, patterns, fakeArr() as never, 'Valid');
}

/** Assert validation fails and the joined error text contains every needle. */
function expectReject(file: unknown, ...needles: string[]): void {
  const res = validateSongFile(file);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    const joined = res.errors.join('\n');
    for (const n of needles) expect(joined).toContain(n);
  }
}

describe('validateSongFile — accepts', () => {
  it('a freshly captured v2 song', () => {
    const res = validateSongFile(captureValid());
    expect(res.ok).toBe(true);
  });

  // Covers the hand-authored v1 built-ins AND every on-disk *.websynth.json
  // drop-in (auto-registered into DEMO_SONGS by the build-time glob).
  it.each(Object.keys(DEMO_SONGS))('every shipped demo conforms: %s', (name) => {
    const res = validateSongFile(clone(DEMO_SONGS[name]!));
    if (!res.ok) throw new Error(`${name} failed validation:\n${res.errors.join('\n')}`);
    expect(res.ok).toBe(true);
  });

  it('a legacy v1 file (no sampler fields, plain {on,velocity} drum cells)', () => {
    const f = captureValid() as SongFile & Record<string, unknown>;
    f.version = 1;
    f.drumBanks = f.drumBanks.map((bank) =>
      bank.map((row) => row.map((c) => ({ on: c.on, velocity: c.velocity }))),
    ) as SongFile['drumBanks'];
    // v1 seq steps carried on/note/velocity/gate but not prob/ratchet/tie.
    f.seqBanks = f.seqBanks.map((bank) =>
      bank.map((s) => ({ on: s.on, note: s.note, velocity: s.velocity, gate: s.gate })),
    ) as SongFile['seqBanks'];
    delete f.samplerBanks;
    delete f.samplerChain;
    delete f.sampleNames;

    const res = validateSongFile(f);
    if (!res.ok) throw new Error(res.errors.join('\n'));
    expect(res.ok).toBe(true);
  });

  it('a file carrying an unknown top-level key (forward-compat)', () => {
    const f = captureValid() as Record<string, unknown>;
    f.futureField = { anything: true };
    expect(validateSongFile(f).ok).toBe(true);
  });
});

describe('validateSongFile — rejects', () => {
  it('a non-object root', () => {
    expect(validateSongFile(42).ok).toBe(false);
    expect(validateSongFile(null).ok).toBe(false);
    expect(validateSongFile([]).ok).toBe(false);
  });

  it('a wrong format discriminator', () => {
    const f = clone(captureValid()) as Record<string, unknown>;
    f.format = 'not-a-song';
    expectReject(f, 'format');
  });

  it('an unknown version', () => {
    const f = clone(captureValid()) as Record<string, unknown>;
    f.version = 3;
    expectReject(f, 'version');
  });

  it('a missing required section', () => {
    const f = clone(captureValid()) as Record<string, unknown>;
    delete f.seqBanks;
    expectReject(f, 'seqBanks');
  });

  it('a non-number param value', () => {
    const f = clone(captureValid());
    (f.params as Record<string, unknown>)['transport.bpm'] = 'fast';
    expectReject(f, 'params.transport.bpm');
  });

  it('a NaN param value', () => {
    const f = clone(captureValid());
    f.params['transport.bpm'] = NaN;
    expectReject(f, 'params.transport.bpm');
  });

  it('a wrong bank count', () => {
    const f = clone(captureValid());
    f.drumBanks = f.drumBanks.slice(0, 3);
    expectReject(f, 'drumBanks');
  });

  it('an out-of-range seq velocity, naming its path', () => {
    const f = clone(captureValid());
    f.seqBanks[0]![2]!.velocity = 2;
    expectReject(f, 'seqBanks[0][2].velocity');
  });

  it('an out-of-range drum ratchet, naming its path', () => {
    const f = clone(captureValid());
    f.drumBanks[1]![3]![7]!.ratchet = 5;
    expectReject(f, 'drumBanks[1][3][7].ratchet');
  });

  it('a chain bank index out of range', () => {
    const f = clone(captureValid());
    f.seqChain = { enabled: true, steps: [7] };
    expectReject(f, 'seqChain.steps[0]');
  });

  it('a sampleNames array of the wrong length', () => {
    const f = clone(captureValid());
    f.sampleNames = [null, null, null];
    expectReject(f, 'sampleNames');
  });
});

describe('Song.parse / fromJSON', () => {
  it('parse() returns the file for valid JSON', () => {
    const res = Song.parse(Song.toJSON(captureValid()));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.file.name).toBe('Valid');
  });

  it('parse() reports a JSON syntax error distinctly', () => {
    const res = Song.parse('{ not json');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join('\n')).toContain('JSON');
  });

  it('parse() reports structural errors for valid-JSON-but-wrong-shape', () => {
    const res = Song.parse(JSON.stringify({ format: 'websynth-song' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
  });

  it('fromJSON() keeps its null contract', () => {
    expect(Song.fromJSON('{ not json')).toBeNull();
    expect(Song.fromJSON(JSON.stringify({ hello: 'world' }))).toBeNull();
    expect(Song.fromJSON(Song.toJSON(captureValid()))).not.toBeNull();
  });
});

describe('published JSON Schema file', () => {
  // Vitest runs from the repo root, so resolve the shipped schema from cwd.
  const text = readFileSync(
    path.resolve(process.cwd(), 'public/schema/websynth-song.schema.json'),
    'utf8',
  );

  it('is well-formed JSON, draft 2020-12, with the expected contract', () => {
    const schema = JSON.parse(text) as {
      $schema: string;
      required: string[];
      $defs: Record<string, unknown>;
    };
    expect(schema.$schema).toContain('2020-12');
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'format', 'version', 'name', 'params',
        'seqBanks', 'drumBanks', 'seqChain', 'drumChain',
      ]),
    );
    for (const def of ['stepSettings', 'seqStep', 'triggerCell', 'chainData']) {
      expect(schema.$defs).toHaveProperty(def);
    }
  });
});
