import { describe, it, expect } from 'vitest';
import { ClockOffsetEstimator } from '../../../../src/audio/transport/sync/clock-offset';

/**
 * Build a ping/pong sample for a symmetric round-trip: the remote clock is
 * `trueOffset` ms ahead of the local clock, and the remote replies at the
 * round-trip midpoint (so the raw offset recovers `trueOffset` exactly).
 */
const sample = (a: number, rtt: number, trueOffset: number) => ({
  a,
  now: a + rtt,
  b: a + rtt / 2 + trueOffset,
});

describe('ClockOffsetEstimator', () => {
  it('converges on the true offset and maps remote → local', () => {
    const est = new ClockOffsetEstimator();
    for (let i = 0; i < 20; i++) est.addSample(sample(i * 1000, 20, 500));
    expect(est.offsetMs!).toBeCloseTo(500, 0);
    // remote ≈ local + 500, so a remote timestamp of 1500 is local 1000.
    expect(est.toLocal(1500)).toBeCloseTo(1000, 0);
  });

  it('gates a high-RTT (delayed) sample carrying a wrong offset', () => {
    const est = new ClockOffsetEstimator();
    for (let i = 0; i < 20; i++) est.addSample(sample(i * 1000, 20, 500));
    const before = est.offsetMs!;
    // rtt 200 >> 1.5 × min(20) → rejected even though it claims offset 5000.
    est.addSample(sample(20_000, 200, 5000));
    expect(est.offsetMs!).toBeCloseTo(before, 6);
  });

  it('is identity until the first accepted sample (cold)', () => {
    const est = new ClockOffsetEstimator();
    expect(est.offsetMs).toBeNull();
    expect(est.toLocal(1500)).toBe(1500);
  });

  it('ignores a backwards round-trip (now < a)', () => {
    const est = new ClockOffsetEstimator();
    est.addSample({ a: 100, b: 100, now: 50 });
    expect(est.offsetMs).toBeNull();
  });

  it('reset clears the estimate and the RTT window', () => {
    const est = new ClockOffsetEstimator();
    for (let i = 0; i < 20; i++) est.addSample(sample(i * 1000, 20, 500));
    est.reset();
    expect(est.offsetMs).toBeNull();
    expect(est.toLocal(1500)).toBe(1500);
  });

  it('EMA-smooths a step change toward the new offset', () => {
    const est = new ClockOffsetEstimator({ emaAlpha: 0.25 });
    for (let i = 0; i < 20; i++) est.addSample(sample(i * 1000, 20, 500));
    // The offset jumps to 600; the EMA glides rather than snapping.
    est.addSample(sample(20_000, 20, 600));
    expect(est.offsetMs!).toBeGreaterThan(500);
    expect(est.offsetMs!).toBeLessThan(600);
  });
});
