import { describe, it, expect } from 'vitest';
import { PulseBpmEstimator } from '../../../../src/audio/transport/sync/bpm-estimator';

/** Inter-pulse interval in ms at a BPM (24 PPQN). */
const intervalMs = (bpm: number): number => 60000 / (bpm * 24);

/** Deterministic bounded jitter, period 5 so window endpoints never cancel. */
const jitter = (i: number): number => [3, -3, 1.5, -1.5, 0][i % 5]!;

describe('PulseBpmEstimator', () => {
  it('is null until the first full window (24 intervals)', () => {
    const est = new PulseBpmEstimator();
    const dt = intervalMs(120);
    for (let i = 0; i < 24; i++) est.addPulse(i * dt);
    expect(est.bpm).toBeNull();
    est.addPulse(24 * dt); // 25th timestamp completes the window
    expect(est.bpm).not.toBeNull();
  });

  it('reads a perfectly steady 120 BPM exactly', () => {
    const est = new PulseBpmEstimator();
    const dt = intervalMs(120);
    for (let i = 0; i < 60; i++) est.addPulse(i * dt);
    expect(est.bpm!).toBeCloseTo(120, 3);
  });

  it('stays within ±1 BPM under ±3 ms jitter at 120', () => {
    const est = new PulseBpmEstimator();
    const dt = intervalMs(120);
    for (let i = 0; i < 200; i++) {
      est.addPulse(i * dt + jitter(i));
      if (est.bpm !== null) expect(Math.abs(est.bpm - 120)).toBeLessThan(1);
    }
  });

  it('follows a tape-stop-shaped ramp 120 → 60 and settles', () => {
    const est = new PulseBpmEstimator();
    let t = 0;
    // Warm at 120.
    for (let i = 0; i < 30; i++) { est.addPulse(t); t += intervalMs(120); }
    // Ramp down over 48 pulses.
    for (let i = 0; i < 48; i++) {
      const bpm = 120 - (i / 48) * 60;
      est.addPulse(t); t += intervalMs(bpm);
    }
    // Settle at 60.
    for (let i = 0; i < 100; i++) { est.addPulse(t); t += intervalMs(60); }
    expect(est.bpm!).toBeCloseTo(60, 0);
  });

  it('resets the window across a gap (> 250 ms) instead of smearing it', () => {
    const est = new PulseBpmEstimator();
    const dt120 = intervalMs(120);
    for (let i = 0; i < 30; i++) est.addPulse(i * dt120);
    expect(est.bpm!).toBeCloseTo(120, 1);
    // 400 ms stall, then a new tempo. The huge interval must not enter the
    // window: every post-gap reading is a clean 90.
    let t = 30 * dt120 + 400;
    const dt90 = intervalMs(90);
    for (let i = 0; i < 80; i++) { est.addPulse(t); t += dt90; }
    expect(est.bpm!).toBeCloseTo(90, 1);
  });

  it('stays burst-immune: bunched delivery of a single stream reads the true tempo', () => {
    // Real Web MIDI delivery bunches pulses on the event loop. The window-span
    // math must cancel that out — a per-interval duplicate heuristic would
    // reject burst-followers and read low (the v3 field regression: a 111 BPM
    // master read as ~76).
    const est = new PulseBpmEstimator();
    const dt = intervalMs(111);
    for (let i = 0; i < 120; i++) {
      // Pairs arrive together: even pulses ~a full interval late, odd on time.
      const burst = i % 2 === 0 ? dt * 0.9 : 0;
      est.addPulse(i * dt + burst);
      if (est.bpm !== null) expect(Math.abs(est.bpm - 111)).toBeLessThan(2);
    }
  });

  it('re-locks after a hard tempo jump (tape-stop release shape)', () => {
    const est = new PulseBpmEstimator();
    let t = 0;
    for (let i = 0; i < 30; i++) { est.addPulse(t); t += intervalMs(60); } // lock at 60
    // Instant jump to 200 BPM: the window slides through and the EMA re-locks.
    for (let i = 0; i < 200; i++) { est.addPulse(t); t += intervalMs(200); }
    expect(est.bpm!).toBeGreaterThan(190);
  });

  it('reset() clears both window and smoothing', () => {
    const est = new PulseBpmEstimator();
    const dt = intervalMs(120);
    for (let i = 0; i < 30; i++) est.addPulse(i * dt);
    est.reset();
    expect(est.bpm).toBeNull();
  });
});
