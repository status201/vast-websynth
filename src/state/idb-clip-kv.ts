import type { ClipKv, StoredClip } from './sample-autosave';

/**
 * The IndexedDB implementation of `ClipKv` — sampler clips as WAV bytes, keyed
 * by slot index (`specs/features/sample-persistence.md`). Kept in its own file
 * so `sample-autosave.ts` stays free of `indexedDB` and is unit-testable under
 * jsdom (which has no IndexedDB) with an in-memory `ClipKv`.
 *
 * Every operation is failure-tolerant by contract (REQ-10): no IndexedDB,
 * private mode, quota, a blocked upgrade — all surface as a rejected promise
 * the caller swallows, never as a broken app.
 */

const DB_NAME = 'websynth';
const DB_VERSION = 1;
const STORE = 'clips';

/** Promisify an IDBRequest. */
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

export class IdbClipKv implements ClipKv {
  /** One connection, opened lazily and reused. Reset on a failed open so a
   *  transient failure (private mode toggled, storage evicted) can retry. */
  private db: Promise<IDBDatabase> | undefined;

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    this.db = new Promise<IDBDatabase>((resolve, reject) => {
      // `indexedDB` is absent in jsdom and can throw on access in some
      // privacy modes — probe defensively rather than assume the global.
      const idb = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
      if (!idb) { reject(new Error('IndexedDB unavailable')); return; }
      const r = idb.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) {
          r.result.createObjectStore(STORE, { keyPath: 'slot' });
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
      // Another tab holds an older version open: fail rather than hang.
      r.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
    });
    this.db = this.db.catch((e: unknown) => { this.db = undefined; throw e; });
    return this.db;
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await this.open();
    return fn(db.transaction(STORE, mode).objectStore(STORE));
  }

  async readAll(): Promise<StoredClip[]> {
    const recs = await this.tx('readonly', (s) => req(s.getAll() as IDBRequest<StoredClip[]>));
    // Sort by slot so the boot restore is deterministic (getAll is key-ordered
    // in practice, but the spec only guarantees it per implementation).
    return recs.slice().sort((a, b) => a.slot - b.slot);
  }

  async write(rec: StoredClip): Promise<void> {
    await this.tx('readwrite', (s) => req(s.put(rec)));
  }

  async delete(slot: number): Promise<void> {
    await this.tx('readwrite', (s) => req(s.delete(slot)));
  }

  async clear(): Promise<void> {
    await this.tx('readwrite', (s) => req(s.clear()));
  }
}
