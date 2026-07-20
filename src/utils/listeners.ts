/**
 * A set of callbacks with disposer-returning registration — the
 * `add → return () => delete` shape every `onStep`/`onFollowChange`-style hook
 * in the transport machines and the bank bar had open-coded.
 *
 * Backed by a `Set`, so a listener registered twice fires once and removal is
 * O(1). `emit` iterates the live set: a listener that unsubscribes itself
 * during emit is honoured, matching the previous per-machine behaviour.
 */
export class ListenerSet<Args extends unknown[] = []> {
  private readonly fns = new Set<(...args: Args) => void>();

  /** Register `fn`; the returned disposer removes it. */
  add(fn: (...args: Args) => void): () => void {
    this.fns.add(fn);
    return () => { this.fns.delete(fn); };
  }

  /** Call every listener, in registration order. */
  emit(...args: Args): void {
    for (const fn of this.fns) fn(...args);
  }
}
