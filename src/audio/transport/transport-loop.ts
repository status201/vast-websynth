import { MAX_CHAIN_STEPS } from '../../state/limits';

/**
 * The transport loop's state (transport-loop.md): whether Loop is on, which bars
 * it spans, and a half-made pick. A model only — it holds no clock. The wrap
 * itself is `routeLoopStep`, a pure function, and `LoopDriver` is what puts the
 * two in front of the clock.
 *
 * Nothing here is persisted (REQ-15): like the cue, a loop is where you are
 * working right now, not part of the song.
 */

/** Bar indices, inclusive, `start <= end`. */
export interface LoopRange {
  readonly start: number;
  readonly end: number;
}

/** A bar index made safe to store (REQ-7): non-finite refused, clamped. */
function clampBar(bar: number): number | null {
  if (!Number.isFinite(bar)) return null;
  return Math.max(0, Math.min(MAX_CHAIN_STEPS - 1, Math.floor(bar)));
}

export class TransportLoop {
  private _enabled = false;
  private _range: LoopRange | null = null;
  private _anchor: number | null = null;
  private readonly listeners = new Set<() => void>();

  get enabled(): boolean { return this._enabled; }
  /** The range as picked — never shortened by the song (REQ-7). */
  get range(): LoopRange | null { return this._range; }
  /** The first pick, waiting for its second (REQ-2). */
  get anchor(): number | null { return this._anchor; }
  /** On, with something to loop — the only state in which the transport wraps. */
  get engaged(): boolean { return this._enabled && this._range !== null; }

  /** Off keeps the range and drops a half-made pick (REQ-5). */
  setEnabled(on: boolean): void {
    if (on === this._enabled) return;
    this._enabled = on;
    if (!on) this._anchor = null;
    this.notify();
  }

  toggle(): void { this.setEnabled(!this._enabled); }

  /**
   * One scrubber click while Loop is on (REQ-2). The first sets the anchor; the
   * second sets the range between the two, in either order. The old range stays
   * in force until then, so re-picking never interrupts the loop.
   */
  pick(bar: number): void {
    if (!this._enabled) return;
    const b = clampBar(bar);
    if (b === null) return;
    if (this._anchor === null) {
      this._anchor = b;
    } else {
      this._range = { start: Math.min(this._anchor, b), end: Math.max(this._anchor, b) };
      this._anchor = null;
    }
    this.notify();
  }

  /** Forget everything — a loaded song's bars are not this song's (REQ-10). */
  clear(): void {
    if (!this._enabled && this._range === null && this._anchor === null) return;
    this._enabled = false;
    this._range = null;
    this._anchor = null;
    this.notify();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

/**
 * The range the song can actually play (REQ-7): clamped to its bars — `0` means
 * no chain lane is enabled, which is one repeating bar, as the scrubber draws it.
 * The stored range is left alone, so lengthening the chain again restores it.
 */
export function effectiveLoopRange(range: LoopRange | null, songBars: number): LoopRange | null {
  if (!range) return null;
  const last = Math.max(1, songBars) - 1;
  return { start: Math.min(range.start, last), end: Math.min(range.end, last) };
}

/**
 * The wrap rule (REQ-3): only a bar line decides. Inside the range, keep going;
 * at its end — or anywhere outside it — go to its first step. So a loop engaged
 * mid-song finishes the bar it is in and then enters, and never cuts in mid-bar.
 * `barTicks` is the song's bar, not 16 (REQ-11).
 */
export function routeLoopStep(next: number, range: LoopRange | null, barTicks: number): number {
  if (!range || barTicks <= 0 || next % barTicks !== 0) return next;
  const start = range.start * barTicks;
  const end = (range.end + 1) * barTicks;
  return next >= start && next < end ? next : start;
}
