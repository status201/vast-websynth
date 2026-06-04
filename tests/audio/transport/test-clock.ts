import type { TickSubscriber, TickListener } from '../../../src/audio/transport/tick-source';

/**
 * A synchronous mock clock for testing transport modules.
 * Instead of using setTimeout/AudioContext, the test fires ticks manually
 * via `fireTick()` and asserts the behaviour directly.
 */
export class TestClock implements TickSubscriber {
  playing = false;
  step = 0;
  private readonly tickListeners = new Set<TickListener>();
  private readonly startListeners = new Set<() => void>();
  private readonly stopListeners = new Set<() => void>();
  private bpm = 120;

  onTick(fn: TickListener): () => void {
    this.tickListeners.add(fn);
    return () => { this.tickListeners.delete(fn); };
  }

  onStart(fn: () => void): () => void {
    this.startListeners.add(fn);
    return () => { this.startListeners.delete(fn); };
  }

  onStop(fn: () => void): () => void {
    this.stopListeners.add(fn);
    return () => { this.stopListeners.delete(fn); };
  }

  sixteenthDuration(): number {
    return 60 / this.bpm / 4;
  }

  setBpm(bpm: number): void {
    this.bpm = Math.max(20, Math.min(400, bpm));
  }

  /** Fire one tick at a given audio time (default 0). */
  fireTick(when = 0): void {
    for (const l of this.tickListeners) l(this.step, when);
    this.step++;
  }

  /** Fire N consecutive ticks starting from `step` 0. */
  fireTicks(n: number, when = 0): void {
    for (let i = 0; i < n; i++) this.fireTick(when + i * 0.125);
  }

  fireStart(): void {
    this.playing = true;
    this.step = 0;
    for (const l of this.startListeners) l();
  }

  fireStop(): void {
    this.playing = false;
    for (const l of this.stopListeners) l();
  }

  start(): void { this.fireStart(); }
  stop(): void { this.fireStop(); }
}
