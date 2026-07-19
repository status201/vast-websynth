/**
 * Generic bounded undo stack with time-window coalescing — the storage half of
 * the pattern undo (`specs/features/pattern-undo.md` REQ-1/REQ-4); pure and
 * reusable for any inverse-state entry type.
 *
 * Coalescing: a push whose `coalesceKey` matches the previous push's key,
 * within `coalesceMs` of it, keeps the existing top entry (its older `before`
 * already spans the whole gesture) and refreshes the window — so a drag
 * emitting dozens of same-target writes lands as ONE undo step.
 */
export class UndoHistory<T> {
  private readonly entries: T[] = [];
  private readonly depth: number;
  private readonly coalesceMs: number;
  private lastKey: string | undefined;
  private lastAt = -Infinity;
  private readonly listeners = new Set<() => void>();

  constructor(opts?: { depth?: number; coalesceMs?: number }) {
    this.depth = opts?.depth ?? 50;
    this.coalesceMs = opts?.coalesceMs ?? 400;
  }

  /** `now` is injectable for tests; defaults to wall-clock. */
  push(entry: T, coalesceKey?: string, now = Date.now()): void {
    const coalesce =
      coalesceKey !== undefined &&
      coalesceKey === this.lastKey &&
      now - this.lastAt <= this.coalesceMs &&
      this.entries.length > 0;
    this.lastKey = coalesceKey;
    this.lastAt = now;
    if (coalesce) return; // top entry already holds the gesture's pre-state
    this.entries.push(entry);
    if (this.entries.length > this.depth) this.entries.shift();
    this.emit();
  }

  pop(): T | undefined {
    if (this.entries.length === 0) return undefined;
    const e = this.entries.pop();
    // The popped entry is gone — a follow-up same-key edit must not coalesce
    // onto whatever is underneath.
    this.lastKey = undefined;
    this.emit();
    return e;
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries.length = 0;
    this.lastKey = undefined;
    this.emit();
  }

  get size(): number {
    return this.entries.length;
  }

  /** Fires whenever the stack's size changes (push/pop/clear). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
