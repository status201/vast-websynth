import { describe, it, expect } from 'vitest';
import {
  encodeClip,
  buildProjectZip,
  parseProjectZip,
  parseSongOrProject,
  projectFilename,
  sniffImportKind,
  type ProjectClipOut,
} from '../../src/state/project';
import { zipWrite, zipRead } from '../../src/utils/zip';
import { Song, type SongFile } from '../../src/state/song';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';

/** Minimal Arrangement stand-in: only the surface Song.capture touches. */
function fakeArr() {
  return {
    seq: { enabled: false, steps: [0] as number[] },
    drum: { enabled: false, steps: [0] as number[] },
    sampler: { enabled: false, steps: [0] as number[] },
  };
}

/** A guaranteed-valid current-version file with optional sample names. */
function captureValid(sampleNames: Record<number, string> = {}): SongFile {
  const bus = new ParamBus();
  registerDefaults(bus);
  const patterns = new PatternStore();
  for (const [slot, name] of Object.entries(sampleNames)) {
    patterns.setSampleName(Number(slot), name);
  }
  return Song.capture(bus, patterns, fakeArr() as never, 'Proj');
}

const bytesOf = (s: string) => new TextEncoder().encode(s);
const textOf = (b: Uint8Array) => new TextDecoder().decode(b);

const clip = (slot: number, payload: string, ext: 'wav' | 'mp3' = 'wav'): ProjectClipOut =>
  ({ slot, data: bytesOf(payload), ext });

describe('buildProjectZip', () => {
  it('lays out song.json + samples/<slot>-<name>.<ext> and embeds Song.toJSON verbatim', async () => {
    const file = captureValid({ 0: 'kick.wav', 3: 'Amen Break.mp3' });
    const zip = await buildProjectZip(file, [clip(0, 'K'), clip(3, 'A', 'mp3')]);
    const entries = await zipRead(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'song.json',
      'samples/0-kick.wav',
      'samples/3-Amen_Break.mp3',
    ]);
    expect(textOf(entries[0]!.data)).toBe(Song.toJSON(file));
  });

  it('sanitizes hostile names and disambiguates collisions by slot prefix', async () => {
    const file = captureValid({ 0: '../../evil.wav', 1: 'same.wav', 2: 'same.wav', 4: '' });
    const zip = await buildProjectZip(file, [clip(0, 'a'), clip(1, 'b'), clip(2, 'c'), clip(4, 'd')]);
    const names = (await zipRead(zip)).map((e) => e.name);
    expect(names).toContain('samples/1-same.wav');
    expect(names).toContain('samples/2-same.wav');           // slot prefix disambiguates
    expect(names).toContain('samples/4-clip.wav');           // empty name falls back
    const evil = names.find((n) => n.startsWith('samples/0-'))!;
    expect(evil.slice('samples/'.length)).not.toContain('/'); // ../ neutralized
  });
});

describe('parseProjectZip', () => {
  it('round-trips a project (file + clips with slots and raw bytes)', async () => {
    const file = captureValid({ 0: 'kick.wav' });
    const zip = await buildProjectZip(file, [clip(0, 'kick-bytes')]);
    const res = await parseProjectZip(zip);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Song.toJSON(res.file)).toBe(Song.toJSON(file));
    expect(res.clips).toHaveLength(1);
    expect(res.clips[0]!.slot).toBe(0);
    expect(textOf(res.clips[0]!.data)).toBe('kick-bytes');
  });

  it('accepts entries nested one folder deep (Explorer re-zip)', async () => {
    const file = captureValid({ 2: 'snare.wav' });
    const zip = await zipWrite([
      { name: 'MyProj/song.json', data: bytesOf(Song.toJSON(file)) },
      { name: 'MyProj/samples/2-snare.wav', data: bytesOf('S') },
    ]);
    const res = await parseProjectZip(zip);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.clips).toHaveLength(1);
    expect(res.clips[0]!.slot).toBe(2);
    expect(res.clips[0]!.entryName).toBe('MyProj/samples/2-snare.wav');
    expect(textOf(res.clips[0]!.data)).toBe('S');
  });

  it('accepts backslash entry separators (PowerShell Compress-Archive re-zip)', async () => {
    const file = captureValid({ 1: 'hat.wav' });
    const zip = await zipWrite([
      { name: 'song.json', data: bytesOf(Song.toJSON(file)) },
      { name: 'samples\\1-hat.wav', data: bytesOf('H') },
    ]);
    const res = await parseProjectZip(zip);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.clips).toHaveLength(1);
    expect(res.clips[0]!.slot).toBe(1);
    expect(res.clips[0]!.entryName).toBe('samples/1-hat.wav'); // normalized
  });

  it('rejects a zip without song.json', async () => {
    const zip = await zipWrite([{ name: 'samples/0-kick.wav', data: bytesOf('K') }]);
    const res = await parseProjectZip(zip);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/song\.json/);
  });

  it('rejects an invalid song.json with the validator errors', async () => {
    const zip = await zipWrite([{ name: 'song.json', data: bytesOf('{"format":"nope"}') }]);
    const res = await parseProjectZip(zip);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
  });

  it('rejects non-zip bytes with a readable error', async () => {
    const res = await parseProjectZip(bytesOf('this is not a zip'));
    expect(res.ok).toBe(false);
  });

  it('skips clips for out-of-range slots without aborting', async () => {
    const file = captureValid({ 0: 'ok.wav' });
    const zip = await zipWrite([
      { name: 'song.json', data: bytesOf(Song.toJSON(file)) },
      { name: 'samples/0-ok.wav', data: bytesOf('a') },
      { name: 'samples/99-oob.wav', data: bytesOf('b') },
      { name: 'samples/readme.txt', data: bytesOf('ignored: no slot prefix') },
    ]);
    const res = await parseProjectZip(zip);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.clips.map((c) => c.slot)).toEqual([0]);
  });
});

describe('projectFilename', () => {
  it('applies the Song.download sanitize idiom + the project extension', () => {
    expect(projectFilename('My Song!')).toBe('My_Song_.websynth.zip');
    expect(projectFilename('')).toBe('song.websynth.zip');
  });
});

describe('sniffImportKind', () => {
  it('detects zip by PK magic regardless of extension', () => {
    expect(sniffImportKind(new Uint8Array([0x50, 0x4b, 3, 4]), 'renamed.json')).toBe('zip');
  });

  it('falls back to the extension when the magic is absent', () => {
    expect(sniffImportKind(bytesOf('{"fo'), 'song.websynth.json')).toBe('json');
    expect(sniffImportKind(new Uint8Array(0), 'song.websynth.zip')).toBe('zip');
  });
});

describe('parseSongOrProject', () => {
  it('routes plain-JSON song bytes to Song.parse with no clips', async () => {
    const file = captureValid();
    const res = await parseSongOrProject(bytesOf(Song.toJSON(file)), 'song.json');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Song.toJSON(res.file)).toBe(Song.toJSON(file));
    expect(res.clips).toEqual([]);
  });

  it('routes project-zip bytes to parseProjectZip (clips included)', async () => {
    const file = captureValid({ 0: 'kick.wav' });
    const zip = await buildProjectZip(file, [clip(0, 'K')]);
    const res = await parseSongOrProject(zip, 'proj.websynth.zip');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.clips).toHaveLength(1);
    expect(res.clips[0]!.slot).toBe(0);
  });

  it('trusts the PK magic over a misleading .json extension', async () => {
    const file = captureValid();
    const zip = await buildProjectZip(file, []);
    const res = await parseSongOrProject(zip, 'renamed.json');
    expect(res.ok).toBe(true);
    if (res.ok) expect(Song.toJSON(res.file)).toBe(Song.toJSON(file));
  });

  it('returns the validator errors for malformed JSON', async () => {
    const res = await parseSongOrProject(bytesOf('{"format":"nope"}'), 'bad.json');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
  });
});

describe('encodeClip', () => {
  const sine = (rate: number) => {
    const n = Math.floor(rate * 0.05);
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) left[i] = right[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
    return { left, right, sampleRate: rate };
  };

  it('derives the extension from the encoded blob type', () => {
    expect(encodeClip(sine(44100), 'wav').ext).toBe('wav');
    expect(encodeClip(sine(44100), 'mp3').ext).toBe('mp3');
  });

  it("mp3 at an unsupported rate falls back to WAV — ext must say 'wav'", () => {
    const out = encodeClip(sine(12345), 'mp3');
    expect(out.blob.type).toBe('audio/wav');
    expect(out.ext).toBe('wav');
  });
});
