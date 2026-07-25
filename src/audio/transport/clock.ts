import type { TickSubscriber, TickListener } from './tick-source';
import { type TickTimer, defaultTickTimer } from './tick-timer';

/**
 * Look-ahead transport clock. Subscribers receive a callback with the
 * (stepIndex, audioContextTime) pair for each upcoming 16th-note tick,
 * scheduled ~100 ms ahead so events can be set on AudioParams with
 * sample-accurate timing.
 *
 * Design follows the classic "two clocks" pattern (Chris Wilson, 2013): a
 * timer wakes us up every 25 ms to enqueue work; the actual triggering uses
 * absolute AudioContext time via setValueAtTime etc. The wakeup timer runs in
 * a Worker (see tick-timer.ts) so it survives main-thread jank and
 * background-tab timer throttling; scheduling itself stays on this thread.
 */
export type { TickListener };

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_S = 0.1;

export interface ClockOptions {
  /** Wakeup source; defaults to a Worker timer (main-thread fallback). */
  timer?: TickTimer;
  /** Look-ahead horizon in seconds; perf tier may widen the default. */
  scheduleAheadS?: number;
}

export class Clock implements TickSubscriber {
  private _bpm = 120;
  private swing = 0;
  private _playing = false;
  private nextStepTime = 0;
  private _step = 0;
  private _cue = 0;
  private readonly timer: TickTimer;
  private readonly scheduleAheadS: number;
  private readonly listeners = new Set<TickListener>();
  private readonly startListeners = new Set<() => void>();
  private readonly stopListeners = new Set<() => void>();
  private readonly seekListeners = new Set<() => void>();

  constructor(private readonly ctx: AudioContext, opts?: ClockOptions) {
    this.timer = opts?.timer ?? defaultTickTimer();
    this.scheduleAheadS = opts?.scheduleAheadS ?? SCHEDULE_AHEAD_S;
  }

  get playing(): boolean { return this._playing; }
  get step(): number { return this._step; }
  /** Where a plain `start()` begins. 0 until the first `seek` (transport.md
   *  REQ-7), so a transport nobody has moved behaves exactly as it always did. */
  get cue(): number { return this._cue; }
  /** The tempo the transport is actually running at. Worth reading directly:
   *  a slaved clock is driven by `setBpm` from incoming MIDI pulses and never
   *  touches the bus, so `transport.bpm` can legitimately disagree with this
   *  (midi-clock-sync.md) — which is exactly what the Debug panel shows. */
  get bpm(): number { return this._bpm; }

  setBpm(b: number): void {
    this._bpm = Math.max(20, Math.min(400, b));
  }

  /** Shuffle amount, 0 (straight) .. 1. Delays the off-beat 16ths. */
  setSwing(s: number): void {
    this.swing = Math.max(0, Math.min(1, s));
  }

  /**
   * Start the transport. `fromStep` seeds the step counter *before* start
   * listeners fire, so a subscriber (the Arrangement) can read `clock.step` in
   * `onStart` and seek to the implied bar — used by clock-sync's Song-Position
   * join (midi-clock-sync REQ-10).
   *
   * The default is the **cue** (transport.md REQ-7), i.e. wherever the user last
   * moved the playhead — 0 until they do, so `start()` on an untouched transport
   * is unchanged. Callers that genuinely require step 0 (the recorders, which
   * bound their captures by absolute step number) must pass `0` explicitly.
   */
  start(fromStep = this._cue): void {
    if (this._playing) return;
    this._playing = true;
    this.nextStepTime = this.ctx.currentTime + 0.05;
    this._step = fromStep & 0xffff;
    for (const l of this.startListeners) l();
    this.tick(); // schedule the first horizon synchronously
    this.timer.start(this.tick, LOOKAHEAD_MS);
  }

  /**
   * Move the playhead (transport.md REQ-6). Deliberately does **not** touch
   * `nextStepTime`: the tempo grid is preserved, so a jump mid-play stays in
   * time — it changes *which* step is next, never *when* it sounds. (That is the
   * whole difference from `start()`, which re-origins the grid, and from
   * `nudge()`, which shifts the grid without changing the step.)
   *
   * Valid playing or stopped; while stopped it simply cues the next `start()`.
   * Listeners fire synchronously so the Arrangement — which subscribes first —
   * has settled the play banks before any machine reacts.
   */
  seek(step: number): void {
    this._cue = this._step = step & 0xffff;
    for (const l of this.seekListeners) l();
  }

  stop(): void {
    if (!this._playing) return;
    this._playing = false;
    this.timer.stop();
    for (const l of this.stopListeners) l();
  }

  toggle(): void {
    if (this._playing) this.stop();
    else this.start();
  }

  /** Subscribe to tick events. Returns an unsubscribe function. */
  onTick(listener: TickListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Fired when the transport (re)starts, before the first tick. */
  onStart(listener: () => void): () => void {
    this.startListeners.add(listener);
    return () => { this.startListeners.delete(listener); };
  }

  /** Fired when the transport stops (including via Engine.panic()). */
  onStop(listener: () => void): () => void {
    this.stopListeners.add(listener);
    return () => { this.stopListeners.delete(listener); };
  }

  /** Fired synchronously from `seek()`, before the next tick drains. */
  onSeek(listener: () => void): () => void {
    this.seekListeners.add(listener);
    return () => { this.seekListeners.delete(listener); };
  }

  private tick = (): void => {
    // A wakeup may land after stop() (worker message in flight) — emit nothing.
    while (this._playing && this.nextStepTime < this.ctx.currentTime + this.scheduleAheadS) {
      const sixteenth = 60 / this._bpm / 4;
      // Lay the off-beat 16ths back. Offset only the emitted time, never the
      // accumulated grid — so swing can't drift, and (max 0.5 * sixteenth) an
      // off-beat never crosses the next on-beat.
      const off = (this._step & 1) === 1 ? this.swing * 0.5 * sixteenth : 0;
      for (const l of this.listeners) l(this._step, this.nextStepTime + off);
      this.nextStepTime += sixteenth;
      this._step = (this._step + 1) & 0xffff; // monotonic; subscribers do their own modulo
    }
  };

  /** Duration of one 16th note at the current BPM, in seconds. */
  sixteenthDuration(): number {
    return 60 / this._bpm / 4;
  }

  /**
   * Shift the future step grid by `seconds` (positive = later). Used by MIDI
   * clock-sync slaving for gentle phase correction: only *future* ticks move,
   * so swing, the drain loop and `_step` are untouched. Clamped to ±0.05 s per
   * call (a correction should be inaudible); no-op while stopped.
   */
  nudge(seconds: number): void {
    if (!this._playing) return;
    this.nextStepTime += Math.max(-0.05, Math.min(0.05, seconds));
  }
}
