import type { TickSubscriber, TickListener } from '../../../src/audio/transport/tick-source';
import { MAX_STEP } from '../../../src/state/limits';

/** Mirrors the real `Clock`'s ingress bound (transport.md REQ-10): clamped, not
 *  masked, so a lane length that does not divide a power of two keeps its phase. */
function clampStep(step: number): number {
  if (!Number.isFinite(step)) return 0;
  return Math.max(0, Math.min(MAX_STEP, Math.floor(step)));
}

/**
 * A synchronous mock clock for testing transport modules.
 * Instead of using setTimeout/AudioContext, the test fires ticks manually
 * via `fireTick()` and asserts the behaviour directly.
 */
export class TestClock implements TickSubscriber {
  playing = false;
  step = 0;
  cue = 0;
  private readonly tickListeners = new Set<TickListener>();
  private readonly startListeners = new Set<() => void>();
  private readonly stopListeners = new Set<() => void>();
  private readonly seekListeners = new Set<() => void>();
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

  onSeek(fn: () => void): () => void {
    this.seekListeners.add(fn);
    return () => { this.seekListeners.delete(fn); };
  }

  sixteenthDuration(): number {
    return 60 / this.bpm / 4;
  }

  setBpm(bpm: number): void {
    this.bpm = Math.max(20, Math.min(400, bpm));
  }

  /** Settable so a test can drive lane-relative swing (meter.md REQ-16) without
   *  reimplementing the real Clock's grid. */
  swing = 0;

  swingOffset(step: number): number {
    return (step & 1) === 1 ? this.swing * 0.5 * this.sixteenthDuration() : 0;
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

  fireStart(fromStep = 0): void {
    this.playing = true;
    this.step = clampStep(fromStep); // mirrors Clock.start(fromStep) (transport.md REQ-5/REQ-10)
    for (const l of this.startListeners) l();
  }

  fireStop(): void {
    this.playing = false;
    for (const l of this.stopListeners) l();
  }

  /** Mirrors Clock.seek: moves the step + cue, leaves the grid alone
   *  (transport.md REQ-6/REQ-7). */
  fireSeek(step: number): void {
    this.cue = this.step = clampStep(step);
    for (const l of this.seekListeners) l();
  }

  start(fromStep = this.cue): void { this.fireStart(fromStep); }
  stop(): void { this.fireStop(); }
  seek(step: number): void { this.fireSeek(step); }
}
