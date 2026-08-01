import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PwmDriver, PWM_CONTROL_HZ, PWM_RATE_MAX, type PwmVoice } from '../../src/audio/pwm';
import { PWM_MIN_WIDTH, PWM_MAX_WIDTH } from '../../src/audio/oscillator';

/**
 * The PWM control loop (oscillators.md REQ-7..REQ-10).
 *
 * PWM is the one modulation path that is not an audio connection, so this is
 * where its cost contract lives: the timer exists only for the `pulse`
 * destination, and the sweep is unipolar-upward and rate-capped.
 */

const PULSE = 4;
const CUTOFF = 1;
const TICK_MS = 1000 / PWM_CONTROL_HZ;

/** Records every width each oscillator is asked for. */
function fakeVoices(n = 2) {
  const widths: [number[], number[]] = [[], []];
  const voices: PwmVoice[] = Array.from({ length: n }, () => ({
    osc1: { setPulseWidth: (w: number) => widths[0].push(w) } as unknown as PwmVoice['osc1'],
    osc2: { setPulseWidth: (w: number) => widths[1].push(w) } as unknown as PwmVoice['osc2'],
  }));
  return { voices, widths };
}

/** Audio time advances with the fake timers, as it would in the real context. */
function build(n = 2) {
  const { voices, widths } = fakeVoices(n);
  let t = 0;
  const pwm = new PwmDriver(voices, () => t);
  const advance = (ms: number) => {
    // Step tick-by-tick so `now()` moves between fires, as in the real context.
    const steps = Math.round(ms / TICK_MS);
    for (let i = 0; i < steps; i++) { t += TICK_MS / 1000; vi.advanceTimersByTime(TICK_MS); }
  };
  return { pwm, widths, advance };
}

describe('PwmDriver lifecycle (REQ-8)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('schedules nothing for any destination but pulse', () => {
    const { pwm, widths, advance } = build();
    pwm.setAmount(1);
    pwm.setDest(CUTOFF);
    advance(500);
    expect(widths[0]).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts on pulse and stops again when the destination moves away', () => {
    const { pwm, widths, advance } = build();
    pwm.setAmount(1);

    pwm.setDest(PULSE);
    expect(vi.getTimerCount()).toBe(1);
    advance(100);
    expect(widths[0].length).toBeGreaterThan(0);

    pwm.setDest(CUTOFF);
    expect(vi.getTimerCount()).toBe(0);
    const settled = widths[0].length;
    advance(500);
    expect(widths[0].length).toBe(settled); // no further writes
  });

  it('leaves the oscillators at the knob base, not mid-sweep', () => {
    const { pwm, widths, advance } = build();
    pwm.setBase(0, 0.7);
    pwm.setAmount(1);
    pwm.setDest(PULSE);
    advance(200);

    pwm.setDest(CUTOFF);
    expect(widths[0].at(-1)).toBeCloseTo(0.7, 6);
  });

  it('re-entering pulse does not stack timers', () => {
    const { pwm } = build();
    pwm.setDest(PULSE);
    pwm.setDest(PULSE);
    expect(vi.getTimerCount()).toBe(1);
    pwm.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies a base written while idle straight away', () => {
    const { pwm, widths } = build();
    pwm.setBase(0, 0.8);
    expect(widths[0].at(-1)).toBeCloseTo(0.8, 6);
  });

  it('writes to every voice in the pool', () => {
    const { pwm, widths, advance } = build(4);
    pwm.setAmount(1);
    pwm.setDest(PULSE);
    advance(TICK_MS * 3);
    expect(widths[0].length % 4).toBe(0);
    expect(widths[0].length).toBeGreaterThanOrEqual(4);
  });
});

describe('PwmDriver sweep shape (REQ-7)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is unipolar and upward from the base, never below it', () => {
    const { pwm, widths, advance } = build(1);
    pwm.setBase(0, PWM_MIN_WIDTH);
    pwm.setAmount(1);
    pwm.setRate(2);
    pwm.setWave(0); // sine
    pwm.setDest(PULSE);
    advance(2000); // several full cycles

    const swept = widths[0];
    expect(Math.min(...swept)).toBeGreaterThanOrEqual(PWM_MIN_WIDTH - 1e-9);
    expect(Math.max(...swept)).toBeLessThanOrEqual(PWM_MAX_WIDTH + 1e-9);
    // A full-depth sweep from 0.5 should reach most of the way to the ceiling.
    expect(Math.max(...swept)).toBeGreaterThan(0.9);
  });

  it('narrows the sweep as the base rises, always ending at the ceiling', () => {
    const { pwm, widths, advance } = build(1);
    pwm.setBase(0, 0.8);
    pwm.setAmount(1);
    pwm.setRate(2);
    pwm.setDest(PULSE);
    advance(2000);

    expect(Math.min(...widths[0])).toBeGreaterThanOrEqual(0.8 - 1e-9);
    expect(Math.max(...widths[0])).toBeLessThanOrEqual(PWM_MAX_WIDTH + 1e-9);
  });

  it('holds the base at zero depth', () => {
    const { pwm, widths, advance } = build(1);
    pwm.setBase(0, 0.6);
    pwm.setAmount(0);
    pwm.setDest(PULSE);
    advance(500);
    for (const w of widths[0]) expect(w).toBeCloseTo(0.6, 6);
  });

  it('crosses the whole range on a square wave (edge)', () => {
    const { pwm, widths, advance } = build(1);
    pwm.setBase(0, PWM_MIN_WIDTH);
    pwm.setAmount(1);
    pwm.setRate(4);
    pwm.setWave(3); // square — two values only
    pwm.setDest(PULSE);
    advance(1000);

    const uniq = [...new Set(widths[0].map((w) => w.toFixed(4)))].sort();
    expect(uniq).toEqual(['0.5000', '0.9500']);
  });
});

describe('PwmDriver rate cap (REQ-9)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Rising zero-crossings of the sine sweep ≈ cycles completed. */
  function cycles(widths: number[], base: number, span: number): number {
    let n = 0;
    let above = false;
    for (const w of widths) {
      const hot = w > base + span * 0.5;
      if (hot && !above) n++;
      above = hot;
    }
    return n;
  }

  it('runs a 20 Hz LFO at the cap, not at 20 Hz', () => {
    const span = PWM_MAX_WIDTH - PWM_MIN_WIDTH;
    const fast = build(1);
    fast.pwm.setAmount(1);
    fast.pwm.setRate(20); // double the cap
    fast.pwm.setDest(PULSE);
    fast.advance(2000);

    const capped = build(1);
    capped.pwm.setAmount(1);
    capped.pwm.setRate(PWM_RATE_MAX);
    capped.pwm.setDest(PULSE);
    capped.advance(2000);

    expect(cycles(fast.widths[0], PWM_MIN_WIDTH, span))
      .toBe(cycles(capped.widths[0], PWM_MIN_WIDTH, span));
  });

  it('leaves rates under the cap alone', () => {
    const span = PWM_MAX_WIDTH - PWM_MIN_WIDTH;
    const { pwm, widths, advance } = build(1);
    pwm.setAmount(1);
    pwm.setRate(2);
    pwm.setDest(PULSE);
    advance(2000); // 2 s at 2 Hz ≈ 4 cycles

    expect(cycles(widths[0], PWM_MIN_WIDTH, span)).toBe(4);
  });
});

describe('PwmDriver background throttling (REQ-10)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('caps a stalled tick so the duty freezes instead of jumping', () => {
    const { voices, widths } = fakeVoices(1);
    let t = 0;
    const pwm = new PwmDriver(voices, () => t);
    pwm.setBase(0, PWM_MIN_WIDTH);
    pwm.setAmount(1);
    pwm.setRate(PWM_RATE_MAX);
    pwm.setDest(PULSE);

    t += TICK_MS / 1000;
    vi.advanceTimersByTime(TICK_MS);
    const before = widths[0].at(-1)!;

    // A backgrounded tab: audio time ran on for a minute, the timer did not.
    t += 60;
    vi.advanceTimersByTime(TICK_MS);
    const after = widths[0].at(-1)!;

    // Without the cap this would land at an arbitrary phase and click.
    const maxStep = PWM_RATE_MAX * (4 / PWM_CONTROL_HZ) * (PWM_MAX_WIDTH - PWM_MIN_WIDTH) * Math.PI;
    expect(Math.abs(after - before)).toBeLessThan(maxStep);
  });
});
