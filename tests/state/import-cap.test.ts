import { describe, it, expect } from 'vitest';
import { fileKindOf, importCapFor, oversizedFileMessage } from '../../src/state/import-cap';
import { MAX_SONG_JSON_BYTES, MAX_ZIP_TOTAL_BYTES } from '../../src/state/limits';

// untrusted-input.md REQ-a-file-is-sized-before-it-is-read: the one function every
// file door asks before it reads a byte.
describe('fileKindOf', () => {
  it('sorts by name and type before anything is read', () => {
    expect(fileKindOf({ name: 'Set.websynth.zip', type: '' })).toBe('zip');
    expect(fileKindOf({ name: 'song.json', type: '' })).toBe('json');
    expect(fileKindOf({ name: 'reply.txt', type: 'text/plain' })).toBe('json');
    expect(fileKindOf({ name: 'kick.wav', type: 'audio/wav' })).toBe('audio');
    expect(fileKindOf({ name: 'paper.pdf', type: 'application/pdf' })).toBe('other');
  });

  it('knows the zip type Chromium on Windows reports', () => {
    expect(fileKindOf({ name: 'download', type: 'application/x-zip-compressed' })).toBe('zip');
  });
});

describe('importCapFor', () => {
  it('holds a zip to the archive cap, by name or by type', () => {
    expect(importCapFor({ name: 'Song.websynth.zip', type: '' })).toBe(MAX_ZIP_TOTAL_BYTES);
    expect(importCapFor({ name: 'SONG.ZIP', type: '' })).toBe(MAX_ZIP_TOTAL_BYTES);
    expect(importCapFor({ name: 'download', type: 'application/zip' })).toBe(MAX_ZIP_TOTAL_BYTES);
    expect(importCapFor({ name: 'download', type: 'application/x-zip-compressed' })).toBe(MAX_ZIP_TOTAL_BYTES);
  });

  it('holds JSON and text to the song cap', () => {
    expect(importCapFor({ name: 'a.websynth.json', type: '' })).toBe(MAX_SONG_JSON_BYTES);
    expect(importCapFor({ name: 'reply.txt', type: '' })).toBe(MAX_SONG_JSON_BYTES);
    expect(importCapFor({ name: 'download', type: 'application/json' })).toBe(MAX_SONG_JSON_BYTES);
  });

  it('gives a name that says neither kind the larger cap rather than guessing', () => {
    expect(importCapFor({ name: 'song', type: '' })).toBe(Math.max(MAX_ZIP_TOTAL_BYTES, MAX_SONG_JSON_BYTES));
  });
});

describe('oversizedFileMessage', () => {
  it('passes a file at its cap and refuses one byte over, naming the limit', () => {
    expect(oversizedFileMessage({ name: 'a.zip', type: '', size: MAX_ZIP_TOTAL_BYTES })).toBeNull();
    expect(oversizedFileMessage({ name: 'a.zip', type: '', size: MAX_ZIP_TOTAL_BYTES + 1 }))
      .toBe('"a.zip" is larger than the 256 MB limit.');
    expect(oversizedFileMessage({ name: 'a.json', type: '', size: MAX_SONG_JSON_BYTES + 1 }))
      .toBe('"a.json" is larger than the 8 MB limit.');
  });

  it('lets a 9 MB project through that the song cap would have refused', () => {
    expect(oversizedFileMessage({ name: 'p.websynth.zip', type: '', size: 9 * 1024 * 1024 })).toBeNull();
  });
});
