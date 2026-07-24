import { SAMPLER_SLOT_COUNT } from './patterns';
import { IdbClipKv } from './idb-clip-kv';
import { encodeWav } from '../audio/recorder/encode';
import { audioBufferToCaptured } from '../audio/recorder/audio-buffer';

/**
 * Sampler-clip persistence — the audio half of the reload safety net
 * (`specs/features/sample-persistence.md`; the song half is `SessionAutosave`,
 * which this module deliberately mirrors: same debounce/flush/static-load
 * shape). Binary clips don't fit localStorage, so they live in IndexedDB as
 * 16-bit WAV bytes (the existing pure `encodeWav`), keyed by slot index.
 *
 * The storage backend is injected as a `ClipKv` so the reconcile logic is
 * unit-testable under jsdom, which has no IndexedDB. Every operation is a
 * silent no-op on failure (REQ-10) — the app never breaks because a clip could
 * not be persisted.
 */

/** One slot's persisted audio: WAV file bytes. Names are NOT stored (REQ-4). */
export interface StoredClip {
  slot: number;
  data: Uint8Array;
}

/** The storage surface this module needs. `IdbClipKv` is the production impl. */
export interface ClipKv {
  readAll(): Promise<StoredClip[]>;
  write(rec: StoredClip): Promise<void>;
  delete(slot: number): Promise<void>;
  clear(): Promise<void>;
}

/** The narrow view of `SamplerMachine` this store reads (ADR-009 in spirit). */
export interface ClipSource {
  readonly buffers: readonly (AudioBuffer | null)[];
  onBufferChange(fn: (slot: number) => void): () => void;
}

const DEFAULT_DEBOUNCE_MS = 800;

/** One shared connection for the whole app — opened lazily on first use. */
let defaultKv: ClipKv | undefined;
function sharedKv(): ClipKv {
  defaultKv ??= new IdbClipKv();
  return defaultKv;
}

export class SampleAutosave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;
  /** What is currently in storage per slot, by AudioBuffer *reference* — the
   *  identity check that keeps an unchanged clip from being re-encoded (REQ-3). */
  private readonly written: (AudioBuffer | null)[] = Array(SAMPLER_SLOT_COUNT).fill(null);
  private readonly bytes: number[] = Array(SAMPLER_SLOT_COUNT).fill(0);
  /** Serializes reconcile passes so a burst of edits never interleaves two. */
  private pass: Promise<void> = Promise.resolve();

  constructor(
    private readonly sampler: ClipSource,
    private readonly kv: ClipKv = sharedKv(),
    opts?: { debounceMs?: number },
  ) {
    this.debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Wire the one mutation hook. Call once at boot, AFTER the restore has run
   * and `noteRestored` has seeded the identity table — otherwise the restore
   * itself would schedule a pointless re-encode of every clip.
   */
  attach(): void {
    this.sampler.onBufferChange(() => this.touch());
    // IndexedDB cannot be flushed synchronously, so there is no `pagehide`
    // handler (REQ-11): hidden-visibility is the one chance to land a pending
    // write. Losing that race degrades to the pre-feature `.needs-reload`.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush();
    });
  }

  /** Arm (or re-arm) the debounced reconcile. */
  touch(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.schedule();
    }, this.debounceMs);
  }

  /** Run a pending reconcile now; resolves when the in-flight pass settles. */
  flush(): Promise<void> {
    if (this.timer === undefined) return this.pass;
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.schedule();
  }

  /**
   * Seed the identity table from the boot restore: these buffers came *out* of
   * storage, so they are already written and must not be encoded again.
   */
  noteRestored(clips: readonly StoredClip[], buffers: readonly (AudioBuffer | null)[]): void {
    for (const c of clips) {
      const buf = buffers[c.slot];
      if (!buf) continue;
      this.written[c.slot] = buf;
      this.bytes[c.slot] = c.data.length;
    }
  }

  /** What the Debug panel reports — in-memory bookkeeping, never an IDB read. */
  stats(): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (let slot = 0; slot < SAMPLER_SLOT_COUNT; slot++) {
      if (!this.written[slot]) continue;
      count++;
      bytes += this.bytes[slot] ?? 0;
    }
    return { count, bytes };
  }

  private schedule(): Promise<void> {
    this.pass = this.pass.then(() => this.reconcile());
    return this.pass;
  }

  /** Bring storage in line with the live slots — one pass over all of them. */
  private async reconcile(): Promise<void> {
    for (let slot = 0; slot < SAMPLER_SLOT_COUNT; slot++) {
      const buf = this.sampler.buffers[slot] ?? null;
      if (buf === this.written[slot]) continue; // unchanged (covers null/null)
      try {
        if (!buf) {
          await this.kv.delete(slot);
          this.written[slot] = null;
          this.bytes[slot] = 0;
          continue;
        }
        const { left, right, sampleRate } = audioBufferToCaptured(buf);
        const data = new Uint8Array(await encodeWav(left, right, sampleRate).arrayBuffer());
        await this.kv.write({ slot, data });
        this.written[slot] = buf;
        this.bytes[slot] = data.length;
      } catch {
        // Quota / private mode / no IndexedDB: stand down silently, and leave
        // `written` untouched so the next pass retries this slot.
      }
    }
  }

  /** Every persisted clip, slot-ordered. Never rejects (empty on failure). */
  static async loadAll(kv: ClipKv = sharedKv()): Promise<StoredClip[]> {
    try {
      return await kv.readAll();
    } catch {
      return [];
    }
  }

  /** Drop one slot's clip (an orphan at restore time). Never rejects. */
  static async drop(slot: number, kv: ClipKv = sharedKv()): Promise<void> {
    try {
      await kv.delete(slot);
    } catch {
      // storage unavailable — nothing to drop
    }
  }

  /** Wipe the store (factory reset, or a boot with no session). Never rejects. */
  static async clear(kv: ClipKv = sharedKv()): Promise<void> {
    try {
      await kv.clear();
    } catch {
      // storage unavailable — nothing to clear
    }
  }
}
