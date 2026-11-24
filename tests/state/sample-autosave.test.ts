// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SampleAutosave, LEGACY_CLIP_SESSION, type ClipKv, type ClipSource, type StoredClip,
} from '../../src/state/sample-autosave';
import { SAMPLER_SLOT_COUNT } from '../../src/state/patterns';
import { makeStubBuffer } from '../audio/mock-audio-context';
import { ListenerSet } from '../../src/utils/listeners';

/**
 * Unit tests for the sampler-clip store (specs/features/sample-persistence.md).
 * jsdom has no IndexedDB, which is exactly why the backend is injectable: these
 * drive an in-memory `ClipKv` (the storage-mock idiom) plus fake timers. The
 * real IndexedDB code — the key ranges and the v1 → v2 upgrade — is pinned by
 * e2e/sample-persistence.spec.ts.
 */

const A = 'websynth.session.taba';
const B = 'websynth.session.tabb';

/** In-memory ClipKv keyed by session + slot, with call counters. */
function makeKv() {
  const rows = new Map<string, StoredClip>();
  const key = (session: string, slot: number): string => `${session}|${slot}`;
  const calls = { readSession: 0, write: 0, delete: 0, deleteSession: 0, clear: 0 };
  const kv: ClipKv = {
    readSession: (session) => {
      calls.readSession++;
      return Promise.resolve([...rows.values()].filter((r) => r.session === session).sort((a, b) => a.slot - b.slot));
    },
    sessions: () => Promise.resolve([...new Set([...rows.values()].map((r) => r.session))]),
    write: (rec) => { calls.write++; rows.set(key(rec.session, rec.slot), rec); return Promise.resolve(); },
    delete: (session, slot) => { calls.delete++; rows.delete(key(session, slot)); return Promise.resolve(); },
    deleteSession: (session) => {
      calls.deleteSession++;
      for (const [k, r] of rows) if (r.session === session) rows.delete(k);
      return Promise.resolve();
    },
    clear: () => { calls.clear++; rows.clear(); return Promise.resolve(); },
  };
  const get = (session: string, slot: number): StoredClip | undefined => rows.get(key(session, slot));
  const put = (session: string, slot: number, data = new Uint8Array(8)): void => {
    rows.set(key(session, slot), { session, slot, data });
  };
  return { kv, rows, calls, get, put };
}

/** A ClipKv where every operation rejects (quota / private mode / no IDB). */
function makeFailingKv(): ClipKv {
  const boom = (): Promise<never> => Promise.reject(new Error('storage unavailable'));
  return { readSession: boom, sessions: boom, write: boom, delete: boom, deleteSession: boom, clear: boom };
}

/** The narrow SamplerMachine view the store reads, driven by hand. */
function makeSampler(): ClipSource & { set(slot: number, buf: AudioBuffer | null): void } {
  const buffers: (AudioBuffer | null)[] = Array(SAMPLER_SLOT_COUNT).fill(null);
  const listeners = new ListenerSet<[number]>();
  return {
    buffers,
    onBufferChange: (fn) => listeners.add(fn),
    set(slot, buf) { buffers[slot] = buf; listeners.emit(slot); },
  };
}

/** A store for session A whose session is already stored, unless told otherwise. */
function makeStore(
  sampler: ClipSource,
  kv: ClipKv,
  debounceMs: number,
  opts: { session?: string; exists?: boolean } = {},
): SampleAutosave {
  return new SampleAutosave(sampler, kv, {
    debounceMs,
    session: opts.session ?? A,
    sessionExists: () => opts.exists ?? true,
  });
}

/** Let the awaited encode/write chain inside a reconcile pass settle. */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => {});

describe('SampleAutosave', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('debounces a filled slot into one WAV write (REQ-clips-persist-in-indexeddb/REQ-clip-writes-are-debounced-through-one-hook)', async () => {
    const { kv, get, calls } = makeKv();
    const sampler = makeSampler();
    const store = makeStore(sampler, kv, 800);
    store.attach();

    sampler.set(0, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(799);
    expect(calls.write).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(calls.write).toBe(1);
    const rec = get(A, 0)!;
    expect(rec.slot).toBe(0);
    expect(rec.session).toBe(A);
    // A RIFF/WAVE header — the bytes really are the shared encodeWav output.
    expect(new TextDecoder().decode(rec.data.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(rec.data.subarray(8, 12))).toBe('WAVE');
  });

  it('never re-encodes an unchanged buffer (REQ-a-write-pass-reconciles-every-slot)', async () => {
    const { kv, calls } = makeKv();
    const sampler = makeSampler();
    const store = makeStore(sampler, kv, 10);
    store.attach();

    sampler.set(0, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(calls.write).toBe(1);

    // A second slot changes; slot 0's buffer reference is untouched.
    sampler.set(3, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(calls.write).toBe(2); // slot 3 only — slot 0 was skipped
  });

  it('deletes a cleared slot (REQ-a-write-pass-reconciles-every-slot)', async () => {
    const { kv, get, calls } = makeKv();
    const sampler = makeSampler();
    const store = makeStore(sampler, kv, 10);
    store.attach();

    sampler.set(0, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(get(A, 0)).toBeDefined();

    sampler.set(0, null); // New song, or a slot cleared by hand
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(get(A, 0)).toBeUndefined();
    expect(calls.delete).toBe(1);
  });

  it('does not write clips handed back by the boot restore (noteRestored)', async () => {
    const { kv, calls } = makeKv();
    const sampler = makeSampler();
    const buf = makeStubBuffer();
    sampler.buffers[0] = buf; // as main.ts's restore leaves it

    const store = makeStore(sampler, kv, 10);
    store.noteRestored({ from: A, clips: [{ session: A, slot: 0, data: new Uint8Array(64) }] }, sampler.buffers);
    store.attach();

    // Some other slot changes, forcing a full reconcile pass.
    sampler.set(2, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(calls.write).toBe(1); // slot 2 only
  });

  it('reports count and bytes for the Debug panel (REQ-debug-shows-the-clip-store-size)', async () => {
    const { kv, get } = makeKv();
    const sampler = makeSampler();
    const store = makeStore(sampler, kv, 10);
    store.attach();
    expect(store.stats()).toEqual({ count: 0, bytes: 0 });

    sampler.set(0, makeStubBuffer());
    sampler.set(1, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(10);
    await settle();

    const expected = get(A, 0)!.data.length + get(A, 1)!.data.length;
    expect(store.stats()).toEqual({ count: 2, bytes: expected });
  });

  it('is a silent no-op when storage fails (REQ-every-clip-storage-failure-is-survivable)', async () => {
    const sampler = makeSampler();
    const store = makeStore(sampler, makeFailingKv(), 10);
    store.attach();

    sampler.set(0, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(10);
    await expect(settle()).resolves.toBeUndefined();
    // Nothing was recorded as written, so the next pass retries the slot.
    expect(store.stats()).toEqual({ count: 0, bytes: 0 });

    await expect(SampleAutosave.loadFor(A, makeFailingKv())).resolves.toEqual({ from: A, clips: [] });
    await expect(SampleAutosave.clear(makeFailingKv())).resolves.toBeUndefined();
    await expect(SampleAutosave.drop(A, 0, makeFailingKv())).resolves.toBeUndefined();
    await expect(SampleAutosave.dropSession(A, makeFailingKv())).resolves.toBeUndefined();
    await expect(SampleAutosave.sweep(() => [], makeFailingKv())).resolves.toBeUndefined();
  });

  it('flush() writes a pending save immediately', async () => {
    const { kv, calls } = makeKv();
    const sampler = makeSampler();
    const store = makeStore(sampler, kv, 10_000);
    store.attach();

    sampler.set(0, makeStubBuffer());
    await store.flush();
    expect(calls.write).toBe(1);
  });

  it('loadFor / drop / dropSession / clear go through the injected store', async () => {
    const { kv, rows, calls, get, put } = makeKv();
    put(A, 1, new Uint8Array([1, 2, 3]));
    put(A, 0, new Uint8Array([4]));
    put(B, 0);

    const restore = await SampleAutosave.loadFor(A, kv);
    expect(restore.from).toBe(A);
    expect(restore.clips.map((c) => c.slot)).toEqual([0, 1]);
    await SampleAutosave.drop(A, 1, kv);
    expect(get(A, 1)).toBeUndefined();
    await SampleAutosave.dropSession(A, kv);
    expect(get(A, 0)).toBeUndefined();
    expect(get(B, 0)).toBeDefined(); // only that session
    await SampleAutosave.clear(kv);
    expect(rows.size).toBe(0);
    expect(calls.clear).toBe(1);
  });
});

// sample-persistence.md v3 — clips belong to a session.
describe('SampleAutosave — clips per session (v3)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // REQ-clips-belong-to-a-session (regression): one record per slot for the whole
  // browser let the last tab to write own every slot.
  it('two tabs filling the same slot keep their own audio', async () => {
    const { kv, get } = makeKv();
    const samplerA = makeSampler();
    const samplerB = makeSampler();
    const storeA = makeStore(samplerA, kv, 10, { session: A });
    const storeB = makeStore(samplerB, kv, 10, { session: B });
    storeA.attach();
    storeB.attach();

    samplerA.set(0, makeStubBuffer(100));
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    samplerB.set(0, makeStubBuffer(300)); // B writes last
    await vi.advanceTimersByTimeAsync(10);
    await settle();

    expect(get(A, 0)!.data.length).toBe(44 + 100 * 2);
    expect(get(B, 0)!.data.length).toBe(44 + 300 * 2);
    const restoreA = await SampleAutosave.loadFor(A, kv);
    expect(restoreA.clips.map((c) => c.data.length)).toEqual([44 + 100 * 2]);
  });

  // REQ-a-session-is-written-before-its-clips
  it('writes nothing until the session is stored, then everything loaded', async () => {
    const { kv, calls, get } = makeKv();
    const sampler = makeSampler();
    const store = makeStore(sampler, kv, 10, { exists: false });
    store.attach();

    sampler.set(0, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    await store.flush();
    expect(calls.write).toBe(0); // no session to belong to yet

    store.sessionWritten(true);
    await settle();
    expect(get(A, 0)).toBeDefined();
  });

  it('a tab that restored another tab\'s session writes that audio as its own on its first session write', async () => {
    const { kv, calls, get } = makeKv();
    const sampler = makeSampler();
    sampler.buffers[0] = makeStubBuffer();
    sampler.buffers[1] = makeStubBuffer();
    const store = makeStore(sampler, kv, 10, { exists: false });
    store.noteRestored({
      from: B,
      clips: [{ session: B, slot: 0, data: new Uint8Array(8) }, { session: B, slot: 1, data: new Uint8Array(8) }],
    }, sampler.buffers);
    store.attach();
    await settle();
    expect(calls.write).toBe(0); // nothing under A before A exists

    store.sessionWritten(true);
    await settle();
    expect(get(A, 0)).toBeDefined();
    expect(get(A, 1)).toBeDefined();
  });

  it('restored foreign audio is written straight away when this tab\'s session already exists', async () => {
    const { kv, get } = makeKv();
    const sampler = makeSampler();
    sampler.buffers[0] = makeStubBuffer();
    const store = makeStore(sampler, kv, 10);
    store.noteRestored({ from: B, clips: [{ session: B, slot: 0, data: new Uint8Array(8) }] }, sampler.buffers);
    store.attach();
    await settle();
    expect(get(A, 0)).toBeDefined();
  });

  it('a fresh session write re-writes every loaded slot; an ordinary one writes nothing', async () => {
    const { kv, calls } = makeKv();
    const sampler = makeSampler();
    const store = makeStore(sampler, kv, 10);
    store.attach();
    sampler.set(0, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(calls.write).toBe(1);

    store.sessionWritten(false);
    await settle();
    expect(calls.write).toBe(1);

    // The session was pruned (its clips went with it) and is written again.
    store.sessionWritten(true);
    await settle();
    expect(calls.write).toBe(2);
  });

  // REQ-clips-go-with-their-session
  it('sweep drops every session not kept, reading what to keep after listing', async () => {
    const { kv, get, put } = makeKv();
    put(A, 0);
    put(B, 0);
    put('websynth.session.gone', 0);
    const keep = vi.fn(() => [A, B]);
    await SampleAutosave.sweep(keep, kv);
    expect(keep).toHaveBeenCalledTimes(1);
    expect(get(A, 0)).toBeDefined();
    expect(get(B, 0)).toBeDefined();
    expect(get('websynth.session.gone', 0)).toBeUndefined();
  });

  // REQ-legacy-clips-are-adopted-once
  it('adopts the v2 store\'s clips when the restored session has none, prefers its own otherwise', async () => {
    const { kv, put } = makeKv();
    put(LEGACY_CLIP_SESSION, 0);
    expect((await SampleAutosave.loadFor(A, kv)).from).toBe(LEGACY_CLIP_SESSION);
    put(A, 2);
    const own = await SampleAutosave.loadFor(A, kv);
    expect(own.from).toBe(A);
    expect(own.clips.map((c) => c.slot)).toEqual([2]);
  });

  it('stores adopted legacy clips under this session, then deletes the legacy records', async () => {
    const { kv, get, put } = makeKv();
    put(LEGACY_CLIP_SESSION, 0);
    const sampler = makeSampler();
    sampler.buffers[0] = makeStubBuffer();
    const store = makeStore(sampler, kv, 10);
    store.noteRestored(await SampleAutosave.loadFor(A, kv), sampler.buffers);
    store.attach();
    await settle();
    expect(get(A, 0)).toBeDefined();
    expect(get(LEGACY_CLIP_SESSION, 0)).toBeUndefined();
  });

  it('keeps the legacy records when storing them here failed, so a later boot can adopt them again', async () => {
    const { kv, get, put } = makeKv();
    put(LEGACY_CLIP_SESSION, 0);
    const failingWrites: ClipKv = { ...kv, write: () => Promise.reject(new Error('quota')) };
    const sampler = makeSampler();
    sampler.buffers[0] = makeStubBuffer();
    const store = makeStore(sampler, failingWrites, 10);
    store.noteRestored(await SampleAutosave.loadFor(A, kv), sampler.buffers);
    store.attach();
    await settle();
    expect(get(LEGACY_CLIP_SESSION, 0)).toBeDefined();
  });
});

// sample-persistence.md REQ-clips-persist-in-indexeddb (v2, regression): a clip whose two
// channels are identical is stored as one, so it comes back from a reload mono.
describe('SampleAutosave — a mono clip is stored as mono', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const storedChannels = (rec: StoredClip): number => new DataView(rec.data.buffer, rec.data.byteOffset).getUint16(22, true);

  it('writes a dual-mono buffer as a one-channel WAV and a true stereo one as two', async () => {
    const { kv, get } = makeKv();
    const sampler = makeSampler();
    const store = makeStore(sampler, kv, 800);
    store.attach();

    const dual = makeStubBuffer(100, 44100, 2);
    dual.getChannelData(0)[5] = 0.5;
    dual.getChannelData(1)[5] = 0.5;
    const stereo = makeStubBuffer(100, 44100, 2);
    stereo.getChannelData(1)[5] = 0.5;
    sampler.set(0, dual);
    sampler.set(1, stereo);
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(storedChannels(get(A, 0)!)).toBe(1);
    expect(get(A, 0)!.data.length).toBe(44 + 100 * 2);
    expect(storedChannels(get(A, 1)!)).toBe(2);
  });
});
