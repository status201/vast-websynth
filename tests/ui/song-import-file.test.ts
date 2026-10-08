// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildSongPanel } from '../../src/ui/panels/song-panel';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { UiBridge } from '../../src/ui/ui-bridge';
import { MAX_SONG_JSON_BYTES, MAX_ZIP_TOTAL_BYTES } from '../../src/state/limits';

/**
 * untrusted-input.md REQ-a-file-is-sized-before-it-is-read (v14, regression): the
 * Import button — and the PWA launchQueue, which reaches the same
 * `SongPanel.importFile` through `UiBridge.importSongFile` — refuses an oversized
 * file from `File.size` alone. Before v14 both called `arrayBuffer()` first.
 */

/**
 * Whatever the panel reaches for at build time: every property is another stub,
 * every call returns one, and it reads as 0 / '' where a primitive is wanted.
 * The refusal path under test never gets as far as the engine.
 */
function anything(): unknown {
  const fn = function () { /* stub */ };
  const proxy: unknown = new Proxy(fn, {
    get: (_t, key) => {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === Symbol.iterator) return function* () { /* empty */ };
      if (key === 'then') return undefined; // never a thenable
      return proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

function panel() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const a = anything() as never;
  return buildSongPanel(bus, a, a, a, new UiBridge(), a, a);
}

/** A File stand-in whose bytes would have to be fetched — so a read is observable. */
function sizedFile(name: string, size: number) {
  const arrayBuffer = vi.fn(async () => new TextEncoder().encode('{}').buffer);
  return { file: { name, type: '', size, arrayBuffer } as unknown as File, arrayBuffer };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('SongPanel.importFile — sized before it is read', () => {
  it('refuses a project zip over the archive cap without reading it', async () => {
    const { file, arrayBuffer } = sizedFile('huge.websynth.zip', MAX_ZIP_TOTAL_BYTES + 1);
    void panel().importFile(file);
    await vi.waitFor(() => expect(document.body.textContent).toContain('larger than the 256 MB limit'));
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses a song JSON over the song cap the same way', async () => {
    const { file, arrayBuffer } = sizedFile('huge.websynth.json', MAX_SONG_JSON_BYTES + 1);
    void panel().importFile(file);
    await vi.waitFor(() => expect(document.body.textContent).toContain('larger than the 8 MB limit'));
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('reads a file within its cap', async () => {
    const { file, arrayBuffer } = sizedFile('small.websynth.json', 2);
    void panel().importFile(file);
    await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalledOnce());
  });

  it('is the door the Import button uses', async () => {
    const p = panel();
    document.body.appendChild(p.el);
    const input = p.el.querySelector<HTMLInputElement>('[data-testid="song-import-file"]')!;
    const { file, arrayBuffer } = sizedFile('huge.websynth.zip', MAX_ZIP_TOTAL_BYTES + 1);
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('larger than the 256 MB limit'));
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
