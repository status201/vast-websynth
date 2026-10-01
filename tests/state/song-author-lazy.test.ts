import { describe, it, expect, vi } from 'vitest';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { XyPadStore } from '../../src/state/xy-pad';
import { fakeArr } from '../fixtures/fake-arrangement';

/**
 * song-authoring-dialect.md REQ-the-expander-loads-with-the-first-author-file:
 * the expander is a lazy chunk. Mocked to throw on evaluation — what a rejected
 * chunk fetch looks like from the importer — a canonical file must still parse
 * (it never asks for the chunk), and an author file must come back as a refused
 * parse rather than an exception. Its own file because `vi.mock` is file-scoped.
 */
vi.mock('../../src/state/song-author', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

const { Song, AUTHOR_READER_UNAVAILABLE } = await import('../../src/state/song');

describe('Song.parse with the expander chunk unavailable', () => {
  it('parses a canonical file without loading it', async () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const file = Song.capture(bus, new PatternStore(), fakeArr(), 'Canon', new XyPadStore());
    const res = await Song.parse(Song.toJSON(file));
    expect(res.ok).toBe(true);
  });

  it('refuses an author file with the reader message instead of throwing', async () => {
    const res = await Song.parse(JSON.stringify({ format: 'websynth-song-author', version: 1, name: 'A' }));
    expect(res).toEqual({ ok: false, errors: [AUTHOR_READER_UNAVAILABLE] });
  });
});
