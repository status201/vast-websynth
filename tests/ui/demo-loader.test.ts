import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDemoLoader, type DemoLoaderDeps } from '../../src/ui/panels/demo-loader';
import { Song, DEMO_SONGS, JSON_DEMOS, ZIP_DEMOS, type SongFile } from '../../src/state/song';
import { buildProjectZip } from '../../src/state/project';
import { installLocalStorageMock } from '../storage-mock';

/**
 * session-autosave.md REQ-superseded-async-work-must-not-leak / song-mode.md
 * REQ-drop-in-demos-are-fetched-on-click — the last demo asked for is the one
 * that loads. Demos are picked by KIND, never by name (tests never couple to
 * demo data, write-a-test.md).
 */

/** A response the test releases by hand, so downloads can finish in any order. */
function deferredFetch() {
  const pending = new Map<string, (body: { text?: string; bytes?: Uint8Array }) => void>();
  const fetchMock = vi.fn((url: string) => new Promise((resolve) => {
    pending.set(url, (body) => resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(body.text ?? ''),
      arrayBuffer: () => Promise.resolve((body.bytes ?? new Uint8Array()).slice().buffer),
    }));
  }));
  return { fetchMock, finish: (url: string, body: { text?: string; bytes?: Uint8Array }) => pending.get(url)!(body) };
}

function harness() {
  let token = 0;
  const loaded: string[] = []; // the demo each apply named, in order
  const song = {
    get applyToken() { return token; },
    slot: null as string | null,
    setLoadedDemo: vi.fn((name: string | null) => { if (name) loaded.push(name); }),
    applyWithUndo: vi.fn(() => { token++; }),
  };
  const io = {
    applyProjectBundle: vi.fn(async (_b: unknown, opts: { persist: boolean; name?: string }) => {
      token++;
      if (opts.name) loaded.push(opts.name);
    }),
  };
  const deps = {
    bridge: { cuePlay: vi.fn() },
    song,
    picker: { value: '', refresh: vi.fn(), select: vi.fn() },
    io,
  } as unknown as DemoLoaderDeps;
  return {
    loader: createDemoLoader(deps),
    loaded,
    /** Any other apply landing — Load, Import, New, Undo. */
    otherApply: () => { token++; },
  };
}

/** A valid song file to serve as a drop-in's body. */
const anySong = (): SongFile => Object.values(DEMO_SONGS)[0]!;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('demo loading — the last demo asked for wins (regression)', () => {
  let net: ReturnType<typeof deferredFetch>;
  beforeEach(() => {
    installLocalStorageMock(); // no saved slots: no shadow question
    net = deferredFetch();
    vi.stubGlobal('fetch', net.fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a drop-in still downloading is dropped when a built-in demo is clicked', async () => {
    expect(JSON_DEMOS.length).toBeGreaterThan(0);
    const dropIn = JSON_DEMOS[0]!;
    const builtIn = Object.keys(DEMO_SONGS)[0]!;
    const { loader, loaded } = harness();

    const first = loader.loadDemo(dropIn.name);
    await settle();
    await loader.loadDemo(builtIn); // applies at once
    net.finish(dropIn.url, { text: Song.toJSON(anySong()) });
    await first;

    expect(loaded).toEqual([builtIn]);
  });

  it('of two downloads, the one clicked last loads, whichever lands last', async () => {
    expect(JSON_DEMOS.length).toBeGreaterThan(1);
    const [a, b] = [JSON_DEMOS[0]!, JSON_DEMOS[1]!];
    const { loader, loaded } = harness();

    const first = loader.loadDemo(a.name);
    await settle();
    const second = loader.loadDemo(b.name);
    await settle();
    net.finish(a.url, { text: Song.toJSON(anySong()) }); // the earlier click lands first…
    await first;
    net.finish(b.url, { text: Song.toJSON(anySong()) }); // …the later one after it
    await second;

    expect(loaded).toEqual([b.name]);
  });

  it('a zip demo still downloading is dropped when another apply lands', async () => {
    expect(ZIP_DEMOS.length).toBeGreaterThan(0);
    const zip = ZIP_DEMOS[0]!;
    const { loader, loaded, otherApply } = harness();

    const pending = loader.loadDemo(zip.name);
    await settle();
    otherApply(); // the user loads a saved song meanwhile
    net.finish(zip.url, { bytes: await buildProjectZip(anySong(), []) });
    await pending;

    expect(loaded).toEqual([]);
  });

  it('a download nothing superseded still loads', async () => {
    const zip = ZIP_DEMOS[0]!;
    const { loader, loaded } = harness();
    const pending = loader.loadDemo(zip.name);
    await settle();
    net.finish(zip.url, { bytes: await buildProjectZip(anySong(), []) });
    await pending;
    expect(loaded).toEqual([zip.name]);
  });
});
