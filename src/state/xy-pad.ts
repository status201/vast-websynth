/**
 * XY Pad axis assignment — which `ParamBus` param each axis of the XY controller
 * drives. Pure state (no DOM, no bus, no localStorage): the UI reads/writes it and
 * `Song.apply`/`capture` persist it, so it stands alone even when the pad window is
 * closed. See `specs/features/xy-pad.md`.
 */

export interface XyAssign {
  /** ParamBus id driven by the horizontal axis. */
  x: string;
  /** ParamBus id driven by the vertical axis (up = more). */
  y: string;
}

/** Default axes: cutoff × resonance — the classic filter-sweep pad. */
export const XY_DEFAULT_ASSIGN: XyAssign = { x: 'filter.cutoff', y: 'filter.resonance' };

export class XyPadStore {
  private assign: XyAssign = { ...XY_DEFAULT_ASSIGN };
  private readonly listeners = new Set<(a: XyAssign) => void>();

  /** The current assignment (a copy — mutating it never touches the store). */
  get(): XyAssign {
    return { ...this.assign };
  }

  /**
   * `get()` into a caller-owned holder, for the frame loop
   * (runtime-performance.md REQ-6). Copies the fields out for the same reason
   * `get` does — the store's own object is never handed to a caller.
   */
  readAssignInto(out: XyAssign): void {
    out.x = this.assign.x;
    out.y = this.assign.y;
  }

  /** Merge a partial assignment; notifies subscribers only when x or y changes. */
  set(partial: Partial<XyAssign>): void {
    const next: XyAssign = { ...this.assign, ...partial };
    if (next.x === this.assign.x && next.y === this.assign.y) return;
    this.assign = next;
    const snap = this.get();
    this.listeners.forEach((l) => l(snap));
  }

  /** Subscribe to assignment changes; returns an unsubscribe. Does NOT fire now. */
  onChange(cb: (a: XyAssign) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
