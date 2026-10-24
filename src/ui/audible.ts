/**
 * The transport as it is *heard* (transport-position.md REQ-the-playhead-is-drawn-when-it-is-heard).
 *
 * The clock hands each step out up to `SCHEDULE_AHEAD_S` (100 ms) before it
 * sounds, and a display that paints on that hand-off runs ahead of the music.
 * This runs UI work at the audio time instead — the same `setTimeout` deferral
 * the on-screen keyboard's sequencer highlights use (`shell/bottom.ts`) — and
 * keeps the step being heard, for displays that read a position rather than
 * react to one.
 *
 * One per clock, shared by every display: built on first use, never torn down
 * (the clock lives as long as the page).
 */

interface AudibleClock {
  readonly playing: boolean;
  readonly step: number;
  onTick(fn: (step: number, when: number) => void): () => void;
  onStart(fn: () => void): () => void;
  onStop(fn: () => void): () => void;
}

interface AudibleSource {
  readonly ctx: { readonly currentTime: number };
  readonly clock: AudibleClock;
}

export class AudibleTimeline {
  private readonly timers = new Set<number>();
  private readonly stepListeners = new Set<(step: number) => void>();
  private _step = 0;

  constructor(private readonly src: AudibleSource) {
    src.clock.onStart(() => { this._step = src.clock.step; });
    src.clock.onTick((step, when) => this.at(when, () => {
      this._step = step;
      for (const fn of this.stepListeners) fn(step);
    }));
    // Nothing scheduled before a stop may paint after it.
    src.clock.onStop(() => this.cancel());
  }

  /** The transport step being heard now; the start step until the first one sounds. */
  get step(): number { return this._step; }

  /** Run `fn` when the audio clock reaches `when` — now, if it already has. */
  at(when: number, fn: () => void): void {
    const ms = (when - this.src.ctx.currentTime) * 1000;
    if (!(ms > 0)) { fn(); return; }
    const id = window.setTimeout(() => { this.timers.delete(id); fn(); }, ms);
    this.timers.add(id);
  }

  /** Called with each transport step as it is heard. Returns an unsubscribe. */
  onStep(fn: (step: number) => void): () => void {
    this.stepListeners.add(fn);
    return () => { this.stepListeners.delete(fn); };
  }

  /** Drop every pending paint. */
  cancel(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
  }
}

const timelines = new WeakMap<object, AudibleTimeline>();

/** The shared timeline for this engine's clock. */
export function audibleTimeline(src: AudibleSource): AudibleTimeline {
  let t = timelines.get(src.clock);
  if (!t) {
    t = new AudibleTimeline(src);
    timelines.set(src.clock, t);
  }
  return t;
}
