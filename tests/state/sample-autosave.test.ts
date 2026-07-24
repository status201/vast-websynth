import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SampleAutosave, type ClipKv, type ClipSource, type StoredClip } from '../../src/state/sample-autosave';
import { SAMPLER_SLOT_COUNT } from '../../src/state/patterns';
import { makeStubBuffer } from '../audio/mock-audio-context';
import { ListenerSet } from '../../src/utils/listeners';

/**
 * Unit tests for the sampler-clip store (specs/features/sample-persistence.md).
 * jsdom has no IndexedDB, which is exactly why the backend is injectable: these
 * drive an in-memory `ClipKv` (the storage-mock idiom) plus fake timers.
 */

/** In-memory ClipKv with call counters, so re-encode/re-write can be asserted. */
function makeKv() {
  const rows = new Map<number, StoredClip>();
  const calls = { readAll: 0, write: 0, delete: 0, clear: 0 };
  const kv: ClipKv = {
    readAll: () => { calls.readAll++; return Promise.resolve([...rows.values()]); },
    write: (rec) => { calls.write++; rows.set(rec.slot, rec); return Promise.resolve(); },
    delete: (slot) => { calls.delete++; rows.delete(slot); return Promise.resolve(); },
    clear: () => { calls.clear++; rows.clear(); return Promise.resolve(); },
  };
  return { kv, rows, calls };
}

/** A ClipKv where every operation rejects (quota / private mode / no IDB). */
function makeFailingKv(): ClipKv {
  const boom = (): Promise<never> => Promise.reject(new Error('storage unavailable'));
  return { readAll: boom, write: boom, delete: boom, clear: boom };
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

/** Let the awaited encode/write chain inside a reconcile pass settle. */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => {});

describe('SampleAutosave', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('debounces a filled slot into one WAV write (REQ-1/REQ-2)', async () => {
    const { kv, rows, calls } = makeKv();
    const sampler = makeSampler();
    const store = new SampleAutosave(sampler, kv, { debounceMs: 800 });
    store.attach();

    sampler.set(0, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(799);
    expect(calls.write).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(calls.write).toBe(1);
    const rec = rows.get(0)!;
    expect(rec.slot).toBe(0);
    // A RIFF/WAVE header — the bytes really are the shared encodeWav output.
    expect(new TextDecoder().decode(rec.data.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(rec.data.subarray(8, 12))).toBe('WAVE');
  });

  it('never re-encodes an unchanged buffer (REQ-3)', async () => {
    const { kv, calls } = makeKv();
    const sampler = makeSampler();
    const store = new SampleAutosave(sampler, kv, { debounceMs: 10 });
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

  it('deletes a cleared slot (REQ-3)', async () => {
    const { kv, rows, calls } = makeKv();
    const sampler = makeSampler();
    const store = new SampleAutosave(sampler, kv, { debounceMs: 10 });
    store.attach();

    sampler.set(0, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(rows.has(0)).toBe(true);

    sampler.set(0, null); // New song, or a slot cleared by hand
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(rows.has(0)).toBe(false);
    expect(calls.delete).toBe(1);
  });

  it('does not write clips handed back by the boot restore (noteRestored)', async () => {
    const { kv, calls } = makeKv();
    const sampler = makeSampler();
    const buf = makeStubBuffer();
    sampler.buffers[0] = buf; // as main.ts's restore leaves it

    const store = new SampleAutosave(sampler, kv, { debounceMs: 10 });
    store.noteRestored([{ slot: 0, data: new Uint8Array(64) }], sampler.buffers);
    store.attach();

    // Some other slot changes, forcing a full reconcile pass.
    sampler.set(2, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(calls.write).toBe(1); // slot 2 only
  });

  it('reports count and bytes for the Debug panel (REQ-12)', async () => {
    const { kv, rows } = makeKv();
    const sampler = makeSampler();
    const store = new SampleAutosave(sampler, kv, { debounceMs: 10 });
    store.attach();
    expect(store.stats()).toEqual({ count: 0, bytes: 0 });

    sampler.set(0, makeStubBuffer());
    sampler.set(1, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(10);
    await settle();

    const expected = rows.get(0)!.data.length + rows.get(1)!.data.length;
    expect(store.stats()).toEqual({ count: 2, bytes: expected });
  });

  it('is a silent no-op when storage fails (REQ-10)', async () => {
    const sampler = makeSampler();
    const store = new SampleAutosave(sampler, makeFailingKv(), { debounceMs: 10 });
    store.attach();

    sampler.set(0, makeStubBuffer());
    await vi.advanceTimersByTimeAsync(10);
    await expect(settle()).resolves.toBeUndefined();
    // Nothing was recorded as written, so the next pass retries the slot.
    expect(store.stats()).toEqual({ count: 0, bytes: 0 });

    await expect(SampleAutosave.loadAll(makeFailingKv())).resolves.toEqual([]);
    await expect(SampleAutosave.clear(makeFailingKv())).resolves.toBeUndefined();
    await expect(SampleAutosave.drop(0, makeFailingKv())).resolves.toBeUndefined();
  });

  it('flush() writes a pending save immediately', async () => {
    const { kv, calls } = makeKv();
    const sampler = makeSampler();
    const store = new SampleAutosave(sampler, kv, { debounceMs: 10_000 });
    store.attach();

    sampler.set(0, makeStubBuffer());
    await store.flush();
    expect(calls.write).toBe(1);
  });

  it('loadAll / drop / clear go through the injected store', async () => {
    const { kv, rows, calls } = makeKv();
    rows.set(1, { slot: 1, data: new Uint8Array([1, 2, 3]) });
    rows.set(0, { slot: 0, data: new Uint8Array([4]) });

    expect((await SampleAutosave.loadAll(kv)).map((c) => c.slot).sort()).toEqual([0, 1]);
    await SampleAutosave.drop(1, kv);
    expect(rows.has(1)).toBe(false);
    await SampleAutosave.clear(kv);
    expect(rows.size).toBe(0);
    expect(calls.clear).toBe(1);
  });
});
