import type { Clock } from './clock';
import { DEFAULT_BAR_TICKS } from '../../state/meter';
import { type LoopRange, type TransportLoop, effectiveLoopRange, routeLoopStep } from './transport-loop';

export interface LoopDriverDeps {
  clock: Pick<Clock, 'setStepRouter' | 'playing' | 'cue'>;
  loop: TransportLoop;
  /** `Arrangement.songBars()` — 0 when no chain lane is enabled. */
  songBars(): number;
  /** `Engine.canSeek` — a wrap is a seek, refused in the same states (REQ-6). */
  canSeek(): boolean;
  /** `Engine.seekTo` — the guarded entry point, for REQ-4's cue move. */
  seekTo(step: number): boolean;
}

/**
 * Puts the transport loop in front of the clock (transport-loop.md). The model
 * decides *what* the range is; the clock decides *when* a step is emitted; this
 * is the seam between them, so neither has to learn about the other.
 *
 * - The router is installed **only while the loop is engaged** (REQ-14), so an
 *   unlooped transport pays one null check per tick and a looping one does a
 *   modulo per tick and the real work once per bar.
 * - Engaging it while stopped cues the transport into the range (REQ-4).
 */
export class LoopDriver {
  private barTicks = DEFAULT_BAR_TICKS;
  private wasEngaged = false;
  private lastRange: LoopRange | null = null;

  constructor(private readonly deps: LoopDriverDeps) {
    deps.loop.onChange(this.sync);
    this.sync();
  }

  /** The song's bar in ticks, pushed from `Engine.applyMeter` (REQ-11). */
  setBarTicks(ticks: number): void {
    this.barTicks = Number.isFinite(ticks) ? Math.max(1, Math.round(ticks)) : DEFAULT_BAR_TICKS;
  }

  private readonly route = (next: number): number => {
    if (next % this.barTicks !== 0) return next; // only a bar line decides (REQ-3)
    const range = effectiveLoopRange(this.deps.loop.range, this.deps.songBars());
    const to = routeLoopStep(next, range, this.barTicks);
    // Checked only when a jump is due: an export or a slaved clock plays through
    // an engaged loop instead of being bent by it (REQ-6).
    return to !== next && this.deps.canSeek() ? to : next;
  };

  private readonly sync = (): void => {
    const { clock, loop } = this.deps;
    const engaged = loop.engaged;
    clock.setStepRouter(engaged ? this.route : null);
    // A pick makes a new range object, so identity says "the range changed";
    // a first pick (anchor only) changes neither and must not move the cue.
    const changed = engaged && (!this.wasEngaged || loop.range !== this.lastRange);
    this.wasEngaged = engaged;
    this.lastRange = loop.range;
    if (changed && !clock.playing) this.cueInto();
  };

  /** REQ-4: Play should start inside the loop — unless the cue already is. */
  private cueInto(): void {
    const range = effectiveLoopRange(this.deps.loop.range, this.deps.songBars());
    if (!range) return;
    const start = range.start * this.barTicks;
    const end = (range.end + 1) * this.barTicks;
    const cue = this.deps.clock.cue;
    if (cue >= start && cue < end) return;
    this.deps.seekTo(start);
  }
}
