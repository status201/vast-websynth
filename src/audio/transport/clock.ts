/**
 * Look-ahead transport clock. Subscribers receive a callback with the
 * (stepIndex, audioContextTime) pair for each upcoming 16th-note tick,
 * scheduled ~100 ms ahead so events can be set on AudioParams with
 * sample-accurate timing.
 *
 * Design follows the classic "two clocks" pattern (Chris Wilson, 2013):
 * setInterval timer wakes us up every 25 ms to enqueue work; the actual
 * triggering uses absolute AudioContext time via setValueAtTime etc.
 */
export type TickListener = (step: number, when: number) => void;

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_S = 0.1;

export class Clock {
  private bpm = 120;
  private _playing = false;
  private nextStepTime = 0;
  private _step = 0;
  private timer: number | null = null;
  private readonly listeners = new Set<TickListener>();
  private readonly startListeners = new Set<() => void>();
  private readonly stopListeners = new Set<() => void>();

  constructor(private readonly ctx: AudioContext) {}

  get playing(): boolean { return this._playing; }
  get step(): number { return this._step; }

  setBpm(b: number): void {
    this.bpm = Math.max(20, Math.min(400, b));
  }

  start(): void {
    if (this._playing) return;
    this._playing = true;
    this.nextStepTime = this.ctx.currentTime + 0.05;
    this._step = 0;
    for (const l of this.startListeners) l();
    this.tick();
  }

  stop(): void {
    if (!this._playing) return;
    this._playing = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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

  private tick = (): void => {
    while (this._playing && this.nextStepTime < this.ctx.currentTime + SCHEDULE_AHEAD_S) {
      for (const l of this.listeners) l(this._step, this.nextStepTime);
      const secondsPerBeat = 60 / this.bpm;
      const sixteenth = secondsPerBeat / 4;
      this.nextStepTime += sixteenth;
      this._step = (this._step + 1) & 0xffff; // monotonic; subscribers do their own modulo
    }
    if (this._playing) {
      this.timer = window.setTimeout(this.tick, LOOKAHEAD_MS);
    }
  };

  /** Duration of one 16th note at the current BPM, in seconds. */
  sixteenthDuration(): number {
    return 60 / this.bpm / 4;
  }
}
