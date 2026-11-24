import type { ClipKv, StoredClip } from './sample-autosave';

/**
 * The IndexedDB implementation of `ClipKv` — sampler clips as WAV bytes, keyed
 * by session and slot (`specs/features/sample-persistence.md`
 * REQ-clips-belong-to-a-session). Kept in its own file so `sample-autosave.ts`
 * stays free of `indexedDB` and is unit-testable under jsdom (which has no
 * IndexedDB) with an in-memory `ClipKv`.
 *
 * Every operation is failure-tolerant by contract (REQ-every-clip-storage-failure-is-survivable): no IndexedDB,
 * private mode, quota, a blocked upgrade — all surface as a rejected promise
 * the caller swallows, never as a broken app.
 */

/**
 * The session id the v1 store's records move to at the upgrade
 * (REQ-legacy-clips-are-adopted-once). Owned here, where the upgrade writes it;
 * `sample-autosave.ts` re-exports it, so neither module needs the other at load time.
 */
export const LEGACY_CLIP_SESSION = 'legacy';

const DB_NAME = 'websynth';
/** 2 since sample-persistence v3: clips are keyed by session. */
const DB_VERSION = 2;
const STORE = 'sessionClips';
/** The v1 store — one record per slot for the whole browser. Moved, then deleted, at the upgrade. */
const LEGACY_STORE = 'clips';

/** Every key of one session: `[session, slot]` for any slot number. */
const sessionRange = (session: string): IDBKeyRange =>
  IDBKeyRange.bound([session, -Infinity], [session, Infinity]);

/** Promisify an IDBRequest. */
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * The 1 → 2 upgrade (REQ-legacy-clips-are-adopted-once): every v1 record moves
 * into the new store under the `legacy` session, then the old store goes. All
 * inside the upgrade's own transaction, so it lands whole or not at all.
 */
function upgrade(db: IDBDatabase, tx: IDBTransaction): void {
  if (!db.objectStoreNames.contains(STORE)) {
    db.createObjectStore(STORE, { keyPath: ['session', 'slot'] });
  }
  if (!db.objectStoreNames.contains(LEGACY_STORE)) return;
  const all = tx.objectStore(LEGACY_STORE).getAll() as IDBRequest<{ slot: number; data: Uint8Array }[]>;
  all.onsuccess = () => {
    const next = tx.objectStore(STORE);
    for (const rec of all.result) {
      if (typeof rec?.slot === 'number' && rec.data) {
        next.put({ session: LEGACY_CLIP_SESSION, slot: rec.slot, data: rec.data });
      }
    }
    db.deleteObjectStore(LEGACY_STORE);
  };
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
      r.onupgradeneeded = () => upgrade(r.result, r.transaction!);
      r.onsuccess = () => {
        const db = r.result;
        // A newer build in another tab wants to upgrade: step aside rather than
        // block it. The next operation here reopens (and then fails silently if
        // this build can no longer read the database).
        db.onversionchange = () => { db.close(); this.db = undefined; };
        resolve(db);
      };
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

  async readSession(session: string): Promise<StoredClip[]> {
    const recs = await this.tx('readonly', (s) => req(s.getAll(sessionRange(session)) as IDBRequest<StoredClip[]>));
    // Key order is [session, slot], so this is slot order already; sorted anyway
    // so the boot restore stays deterministic whatever the backend does.
    return recs.slice().sort((a, b) => a.slot - b.slot);
  }

  async sessions(): Promise<string[]> {
    // Keys only, never the audio: a sweep must not load every tab's clips.
    const keys = await this.tx('readonly', (s) => req(s.getAllKeys()));
    const out = new Set<string>();
    for (const k of keys) {
      if (Array.isArray(k) && typeof k[0] === 'string') out.add(k[0]);
    }
    return [...out];
  }

  async write(rec: StoredClip): Promise<void> {
    await this.tx('readwrite', (s) => req(s.put(rec)));
  }

  async delete(session: string, slot: number): Promise<void> {
    await this.tx('readwrite', (s) => req(s.delete([session, slot])));
  }

  async deleteSession(session: string): Promise<void> {
    await this.tx('readwrite', (s) => req(s.delete(sessionRange(session))));
  }

  async clear(): Promise<void> {
    await this.tx('readwrite', (s) => req(s.clear()));
  }
}
