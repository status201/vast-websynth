import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateSongFile } from '../../src/state/song-validate';
import { KNOWN_SONG_VERSIONS } from '../../src/state/song-version';
import { Song, DEMO_SONGS } from '../../src/state/song';
import { DROP_IN_DEMOS } from './demo-files';
import type { SongFile } from '../../src/state/song';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { MAX_CHAIN_STEPS, MAX_PARAM_KEYS } from '../../src/state/limits';

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
    motion: { enabled: false, steps: [0] as number[] },
  };
}

/** A guaranteed-valid, full-dimension current-version file (independent of the demos). */
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
  it('a freshly captured current-version song', () => {
    const res = validateSongFile(captureValid());
    expect(res.ok).toBe(true);
  });

  it('a v3 file with an xy axis assignment', () => {
    const f = captureValid() as SongFile & Record<string, unknown>;
    f.version = 3;
    f.xy = { x: 'lfo.rate', y: 'filter.cutoff' };
    expect(validateSongFile(f).ok).toBe(true);
  });

  it('a v2 file without an xy field (xy is optional)', () => {
    const f = captureValid() as SongFile & Record<string, unknown>;
    f.version = 2;
    delete f.xy;
    expect(validateSongFile(f).ok).toBe(true);
  });

  // Covers the hand-authored built-ins AND every on-disk drop-in. The app fetches
  // the drop-ins on click rather than bundling them (song-mode.md REQ-11), so they
  // come from the test-only eager glob — losing this coverage was the one real
  // risk in making them lazy: nothing else parses them before a user clicks.
  const shipped = { ...DROP_IN_DEMOS, ...DEMO_SONGS };
  it.each(Object.keys(shipped))('every shipped demo conforms: %s', (name) => {
    const res = validateSongFile(clone(shipped[name]!));
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

  it('a chain containing the REST sentinel (an empty bar)', () => {
    const f = clone(captureValid());
    f.seqChain = { enabled: true, steps: [0, -1, 1] };
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
    f.version = 99;
    expectReject(f, 'version');
  });

  it('a v3 xy field with a non-string axis, naming its path', () => {
    const f = clone(captureValid()) as SongFile & Record<string, unknown>;
    f.version = 3;
    f.xy = { x: 123, y: 'filter.cutoff' };
    expectReject(f, 'xy.x');
  });

  it('a v3 xy field with an empty-string axis', () => {
    const f = clone(captureValid()) as SongFile & Record<string, unknown>;
    f.version = 3;
    f.xy = { x: 'filter.cutoff', y: '' };
    expectReject(f, 'xy.y');
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

  it('a chain index below the REST sentinel', () => {
    const f = clone(captureValid());
    f.seqChain = { enabled: true, steps: [-2] };
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
      properties: { version: { enum: number[] }; xy?: { properties: Record<string, unknown> } };
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
    // The schema's enum must be exactly what the validator accepts — an
    // arrayContaining check here would not notice a version dropped from either.
    expect(schema.properties.version.enum).toEqual(KNOWN_SONG_VERSIONS);
    expect(schema.properties.xy?.properties).toHaveProperty('x');
    expect(schema.properties.xy?.properties).toHaveProperty('y');
  });
});

describe('validateSongFile — v4 motion fields', () => {
  const withMotion = () => {
    const f = clone(captureValid()) as Record<string, unknown>;
    // captureValid() already emits motionBanks/motionAssigns/motionChain (v4);
    // sanity-check that here so the rejects below mutate real fields.
    expect(f.motionBanks).toBeDefined();
    expect(f.motionAssigns).toBeDefined();
    expect(f.motionChain).toBeDefined();
    return f;
  };

  it('accepts a captured v4 file and sparse {on:false} motion steps', () => {
    const f = withMotion();
    (f.motionBanks as unknown[][])[0]![0] = { on: false };
    expect(validateSongFile(f).ok).toBe(true);
  });

  it('accepts a v3 file without any motion fields', () => {
    const f = clone(captureValid()) as Record<string, unknown>;
    delete f.motionBanks;
    delete f.motionAssigns;
    delete f.motionChain;
    f.version = 3;
    expect(validateSongFile(f).ok).toBe(true);
  });

  it('rejects an out-of-range coordinate, naming its path', () => {
    const f = withMotion();
    (f.motionBanks as unknown[][])[0]![3] = { on: true, x: 1.5, y: 0 };
    expectReject(f, 'motionBanks[0][3].x');
  });

  it('rejects a wrong motionAssigns shape', () => {
    const f = withMotion();
    f.motionAssigns = [null, null, null]; // 3 entries
    expectReject(f, 'motionAssigns must have 4 entries');
    const g = withMotion();
    (g.motionAssigns as unknown[])[1] = { x: '' };
    expectReject(g, 'motionAssigns[1].x');
  });

  it('rejects a bad motionChain step', () => {
    const f = withMotion();
    (f.motionChain as { steps: unknown[] }).steps = [9];
    expectReject(f, 'motionChain.steps[0]');
  });
});

// specs/features/untrusted-input.md — a song arrives by link, so the validator
// is the last place a range can be enforced (ADR-004: PatternStore never does).
describe('validateSongFile — bounds, not just shapes (untrusted-input)', () => {
  it('rejects an out-of-range note before it can reach the oscillator', () => {
    // The whole chain this closes: midiToHz(1e6) is Infinity ->
    // AudioParam.setValueAtTime throws -> the throw used to escape Clock.tick
    // and wedge the transport until a reload. One step object did it (ADR-015).
    for (const note of [1e6, 128, -1, 60.5]) {
      const f = clone(captureValid());
      (f.seqBanks[0]![0] as { note: number }).note = note;
      expectReject(f, 'seqBanks[0][0].note', '0..127');
    }
  });

  it('still accepts the whole legal MIDI range', () => {
    for (const note of [0, 60, 127]) {
      const f = clone(captureValid());
      (f.seqBanks[0]![0] as { note: number }).note = note;
      expect(validateSongFile(f).ok, `note ${note}`).toBe(true);
    }
  });

  it('rejects a chain longer than MAX_CHAIN_STEPS', () => {
    const f = clone(captureValid());
    // Compresses ~1000:1, so this fits in an address bar — and each step became
    // a button + listener in the transport scrubber on import.
    f.seqChain.steps = new Array<number>(MAX_CHAIN_STEPS + 1).fill(0);
    expectReject(f, 'seqChain.steps', String(MAX_CHAIN_STEPS));
  });

  it('accepts a chain exactly at the limit (boundary)', () => {
    const f = clone(captureValid());
    f.seqChain.steps = new Array<number>(MAX_CHAIN_STEPS).fill(0);
    expect(validateSongFile(f).ok).toBe(true);
  });

  it('rejects reserved keys on a cell and on params', () => {
    // JSON.parse makes __proto__ an OWN property, so it survives to
    // Object.assign(cell, DEFAULTS, cell) in PatternStore.restore — which
    // invokes the setter and re-points that cell's prototype.
    const cell = JSON.parse('{"on":true,"note":60,"__proto__":{"velocity":9}}') as unknown;
    const f = clone(captureValid());
    (f.seqBanks[0] as unknown[])[0] = cell;
    expectReject(f, '__proto__');

    const g = clone(captureValid());
    g.params = JSON.parse('{"__proto__":{"x":1}}') as Record<string, number>;
    expectReject(g, '__proto__');
  });

  it('rejects a params map with more than MAX_PARAM_KEYS entries', () => {
    const f = clone(captureValid());
    const params: Record<string, number> = {};
    for (let i = 0; i <= MAX_PARAM_KEYS; i++) params[`junk.${i}`] = 0;
    f.params = params;
    expectReject(f, 'params has', String(MAX_PARAM_KEYS));
  });

  it('still accepts unknown param ids (ADR-007 stays additive)', () => {
    const f = clone(captureValid());
    f.params['from.a.newer.build'] = 0.5;
    expect(validateSongFile(f).ok).toBe(true);
  });
});
