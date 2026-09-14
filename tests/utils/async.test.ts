import { describe, it, expect, afterEach, vi } from 'vitest';
import { delay, withTimeout } from '../../src/utils/async';

afterEach(() => {
  vi.useRealTimers();
});

describe('delay', () => {
  it('resolves after the wait', async () => {
    vi.useFakeTimers();
    let done = false;
    void delay(100).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('resolves early, and never rejects, when the signal aborts', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const wait = delay(10_000, abort.signal);
    abort.abort();
    await expect(wait).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await expect(delay(10_000, abort.signal)).resolves.toBeUndefined(); // already aborted
  });
});

describe('withTimeout', () => {
  it("settles with the promise's value, clearing its timer", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(7), 1000, 0)).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back when the promise rejects', async () => {
    await expect(withTimeout(Promise.reject(new Error('no')), 1000, 'fallback')).resolves.toBe('fallback');
  });

  it('falls back when the promise hangs past the cap', async () => {
    vi.useFakeTimers();
    const settled = withTimeout(new Promise<number>(() => {}), 500, -1);
    await vi.advanceTimersByTimeAsync(500);
    await expect(settled).resolves.toBe(-1);
  });
});
