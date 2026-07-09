/**
 * Tempo estimation from MIDI clock pulses (0xF8, 24 PPQN). Pure — no clocks,
 * no `performance`, no Web MIDI; timestamps come in as plain numbers (ms).
 *
 * MIDI clock carries tempo implicitly in the pulse spacing, and USB/OS
 * delivery adds jitter, so a single interval is useless. Strategy: measure the
 * span of a rolling window of intervals (default 24 = one beat, so the window
 * itself averages a beat's worth of jitter), then EMA-smooth successive window
 * readings so tempo changes glide instead of stepping.
 */

export interface PulseBpmEstimatorOptions {
  /** Intervals per window reading; 24 = one beat at 24 PPQN. */
  windowPulses?: number;
  /** EMA smoothing factor for successive window readings. */
  emaAlpha?: number;
  /** An inter-pulse gap above this clears the window (stall / stop). */
  gapResetMs?: number;
}

export class PulseBpmEstimator {
  private readonly windowPulses: number;
  private readonly emaAlpha: number;
  private readonly gapResetMs: number;
  /** Rolling pulse timestamps, newest last; at most windowPulses + 1 entries. */
  private times: number[] = [];
  private ema: number | null = null;

  constructor(opts?: PulseBpmEstimatorOptions) {
    this.windowPulses = opts?.windowPulses ?? 24;
    this.emaAlpha = opts?.emaAlpha ?? 0.25;
    this.gapResetMs = opts?.gapResetMs ?? 250;
  }

  addPulse(atMs: number): void {
    const last = this.times[this.times.length - 1];
    // A long gap (stall, stop, port swap) would smear one huge interval across
    // the whole window — start over instead. The EMA survives so the previous
    // lock is still reported until fresh pulses replace it.
    if (last !== undefined && atMs - last > this.gapResetMs) this.times = [];
    this.times.push(atMs);
    if (this.times.length > this.windowPulses + 1) this.times.shift();
    if (this.times.length < this.windowPulses + 1) return;

    const first = this.times[0]!;
    const spanMs = atMs - first; // exactly windowPulses intervals
    if (spanMs <= 0) return;
    const bpm = 60000 / ((spanMs / this.windowPulses) * 24);
    this.ema = this.ema === null ? bpm : this.ema + this.emaAlpha * (bpm - this.ema);
  }

  /** Smoothed tempo, or null until the first full window has arrived. */
  get bpm(): number | null {
    return this.ema;
  }

  reset(): void {
    this.times = [];
    this.ema = null;
  }
}
