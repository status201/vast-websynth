import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The worker half of the wakeup timer (transport.md REQ-4). `tick-timer.test.ts`
 * pins the main-thread `WorkerTimer` against a stubbed `Worker`; this pins the
 * other end of that same protocol — the script the real Worker runs.
 *
 * The module wires `self.onmessage` at import time, so each case stubs `self`
 * and re-imports to get a worker with its own interval state.
 */

interface FakeSelf {
  onmessage: ((e: MessageEvent<unknown>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

/** A freshly-imported worker, with the messages it posts recorded. */
async function loadWorker(): Promise<FakeSelf> {
  const fake: FakeSelf = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal('self', fake);
  vi.resetModules();
  await import('../../../src/audio/transport/clock-timer-worker');
  expect(fake.onmessage).toBeTypeOf('function');
  return fake;
}

function send(worker: FakeSelf, data: unknown): void {
  worker.onmessage!({ data } as MessageEvent<unknown>);
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('clock timer worker', () => {
  it('posts a wakeup per interval after start', async () => {
    const worker = await loadWorker();
    send(worker, { cmd: 'start', ms: 10 });

    vi.advanceTimersByTime(35);
    expect(worker.postMessage).toHaveBeenCalledTimes(3);
  });

  it('posts nothing until it is started', async () => {
    const worker = await loadWorker();
    vi.advanceTimersByTime(1000);
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('stop clears the interval', async () => {
    const worker = await loadWorker();
    send(worker, { cmd: 'start', ms: 10 });
    vi.advanceTimersByTime(20);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);

    send(worker, { cmd: 'stop' });
    vi.advanceTimersByTime(100);
    expect(worker.postMessage).toHaveBeenCalledTimes(2); // no further wakeups
  });

  // The guard that matters: every message clears the previous interval first,
  // so a re-start (a tempo change re-arms the timer) cannot leave the old one
  // running and double the wakeup rate.
  it('a second start replaces the first rather than stacking', async () => {
    const worker = await loadWorker();
    send(worker, { cmd: 'start', ms: 10 });
    send(worker, { cmd: 'start', ms: 10 });

    vi.advanceTimersByTime(30);
    expect(worker.postMessage).toHaveBeenCalledTimes(3); // not 6
  });

  it('a re-start at a new interval uses only the new one', async () => {
    const worker = await loadWorker();
    send(worker, { cmd: 'start', ms: 10 });
    vi.advanceTimersByTime(10);
    send(worker, { cmd: 'start', ms: 50 });

    vi.advanceTimersByTime(40);
    expect(worker.postMessage).toHaveBeenCalledTimes(1); // the 10ms one is gone

    vi.advanceTimersByTime(10);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
  });

  it('a repeated stop is harmless', async () => {
    const worker = await loadWorker();
    send(worker, { cmd: 'start', ms: 10 });
    send(worker, { cmd: 'stop' });
    expect(() => send(worker, { cmd: 'stop' })).not.toThrow();
    vi.advanceTimersByTime(100);
    expect(worker.postMessage).not.toHaveBeenCalled();
  });
});
