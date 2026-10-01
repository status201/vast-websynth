// @vitest-environment jsdom
// paste-import.md REQ-a-dropped-file-takes-the-paste-routes.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dropKindOf, importDroppedFile, installFileDrop, type DropRoutes } from '../../src/ui/file-drop';
import { MAX_SONG_JSON_BYTES } from '../../src/state/limits';

function routes(): DropRoutes & { songs: string[]; presets: unknown[] } {
  const songs: string[] = [];
  const presets: unknown[] = [];
  return {
    songs,
    presets,
    onSong: vi.fn(async (_b: Uint8Array, name: string) => { songs.push(name); return true; }),
    onPresets: vi.fn((p: unknown) => { presets.push(p); }),
  };
}

const json = (o: unknown, name = 'x.json') => new File([JSON.stringify(o)], name, { type: 'application/json' });
const toastText = () => document.querySelector('[data-testid="file-drop-toast"]')?.textContent ?? '';

beforeEach(() => { document.body.innerHTML = ''; });

describe('dropKindOf', () => {
  it('sorts by name and type before anything is read', () => {
    expect(dropKindOf({ name: 'Set.websynth.zip', type: '' })).toBe('zip');
    expect(dropKindOf({ name: 'song.json', type: '' })).toBe('json');
    expect(dropKindOf({ name: 'reply.txt', type: 'text/plain' })).toBe('json');
    expect(dropKindOf({ name: 'kick.wav', type: 'audio/wav' })).toBe('audio');
    expect(dropKindOf({ name: 'paper.pdf', type: 'application/pdf' })).toBe('other');
  });
});

describe('importDroppedFile', () => {
  it('routes a song to the song import and a bank to the preset review', async () => {
    const r = routes();
    await importDroppedFile(json({ format: 'websynth-song-author', version: 1, name: 'S', params: {} }, 's.json'), r);
    expect(r.songs).toEqual(['s.json']);
    await importDroppedFile(json({
      format: 'websynth-preset-bank', version: 1, name: 'B', presets: { a: { 'filter.cutoff': 60 } },
    }), r);
    expect(r.presets).toHaveLength(1);
  });

  it('hands a zip to the song import untouched', async () => {
    const r = routes();
    await importDroppedFile(new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'p.websynth.zip'), r);
    expect(r.songs).toEqual(['p.websynth.zip']);
  });

  it('explains instead of importing an audio file, a stranger, or JSON with no format', async () => {
    const r = routes();
    await importDroppedFile(new File(['x'], 'kick.wav', { type: 'audio/wav' }), r);
    expect(toastText()).toContain('sampler slot');
    await importDroppedFile(new File(['x'], 'paper.pdf', { type: 'application/pdf' }), r);
    expect(toastText()).toContain('"paper.pdf" is not');
    await importDroppedFile(json({ hello: 1 }), r);
    expect(toastText()).toContain('"format"');
    expect(r.songs).toEqual([]);
    expect(r.presets).toEqual([]);
  });

  it('refuses an oversized JSON from its size, without reading it', async () => {
    const r = routes();
    const big = new File(['{}'], 'huge.json', { type: 'application/json' });
    Object.defineProperty(big, 'size', { value: MAX_SONG_JSON_BYTES + 1 });
    const text = vi.spyOn(big, 'text');
    await importDroppedFile(big, r);
    expect(text).not.toHaveBeenCalled();
    expect(toastText()).toContain('larger than');
  });
});

describe('installFileDrop', () => {
  /** jsdom has no DragEvent; the handler only reads `dataTransfer`. */
  const drag = (type: string, files: File[] = []): Event => {
    const e = new Event(type, { cancelable: true });
    Object.defineProperty(e, 'dataTransfer', {
      value: { types: ['Files'], files, dropEffect: 'none' },
    });
    window.dispatchEvent(e);
    return e;
  };

  it('claims every file drop so the browser never navigates to it', async () => {
    const r = routes();
    const off = installFileDrop(r);
    const over = drag('dragover');
    expect(over.defaultPrevented).toBe(true);
    const drop = drag('drop', [new File(['x'], 'paper.pdf', { type: 'application/pdf' })]);
    expect(drop.defaultPrevented).toBe(true);   // refused, but still claimed
    off();
  });

  it('shows the overlay while a file is over the window', () => {
    const off = installFileDrop(routes());
    const overlay = document.querySelector<HTMLElement>('[data-testid="file-drop-overlay"]')!;
    expect(overlay.hidden).toBe(true);
    drag('dragenter');
    expect(overlay.hidden).toBe(false);
    drag('dragleave');
    expect(overlay.hidden).toBe(true);
    off();
  });

  it('ignores a drag that carries no files (text, a link)', () => {
    const off = installFileDrop(routes());
    const e = new Event('dragover', { cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { types: ['text/plain'], files: [] } });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    off();
  });
});
