/**
 * A bounded undo/redo stack of whole snapshots (sample-recorder.md
 * REQ-undo-is-a-stack). Pure and generic: the sample studio stores
 * `CapturedAudio` in it, but nothing here knows what a snapshot is beyond its
 * `size`, which is what the budget is counted in.
 *
 * Two bounds, both needed: `depth` caps how far back Undo reaches, and `budget`
 * caps what the two stacks may hold together, so a few long takes cannot pin
 * hundreds of MB. Past the budget the oldest undo entries go first; the newest
 * one always stays, so the last edit is always undoable.
 */
export interface EditHistoryOptions<T> {
  depth: number;
  budget: number;
  size: (snapshot: T) => number;
}

export class EditHistory<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(private readonly opts: EditHistoryOptions<T>) {}

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  /** An edit replaced `previous`: keep it for Undo, and forget Redo. */
  record(previous: T): void {
    this.past.push(previous);
    this.future = [];
    this.trim();
  }

  /** The snapshot to go back to, keeping `current` for Redo — or null. */
  undo(current: T): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(current);
    return prev;
  }

  /** The snapshot to go forward to, keeping `current` for Undo — or null. */
  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    this.trim();
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  private held(): number {
    let n = 0;
    for (const s of this.past) n += this.opts.size(s);
    for (const s of this.future) n += this.opts.size(s);
    return n;
  }

  private trim(): void {
    while (this.past.length > this.opts.depth) this.past.shift();
    while (this.past.length > 1 && this.held() > this.opts.budget) this.past.shift();
  }
}
