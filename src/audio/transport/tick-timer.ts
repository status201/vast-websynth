/**
 * Wakeup source for the transport clock. The scheduling logic stays on the
 * main thread (`clock.ts`); only the periodic wakeup is abstracted so it can
 * run in a Worker — worker timers are exempt from background-tab timer
 * throttling and keep firing through main-thread jank (rAF work, GC), which
 * otherwise starves the look-ahead horizon and bunches hits on mobile.
 */
export interface TickTimer {
  /** Fire `cb` every `intervalMs` until `stop()`. Restarts if already running. */
  start(cb: () => void, intervalMs: number): void;
  stop(): void;
}

/** `setInterval` in a dedicated Worker (bundled by Vite via `new URL`). */
export class WorkerTimer implements TickTimer {
  private worker: Worker | null = null;
  private cb: (() => void) | null = null;

  start(cb: () => void, intervalMs: number): void {
    this.cb = cb;
    if (!this.worker) {
      this.worker = new Worker(
        new URL('./clock-timer-worker.ts', import.meta.url),
        { type: 'module' },
      );
      // A wakeup may still be in flight after stop(); cb is nulled then.
      this.worker.onmessage = () => { this.cb?.(); };
    }
    this.worker.postMessage({ cmd: 'start', ms: intervalMs });
  }

  stop(): void {
    this.cb = null;
    this.worker?.postMessage({ cmd: 'stop' });
  }
}

/** Main-thread `setTimeout` loop — fallback where `Worker` is unavailable. */
export class TimeoutTimer implements TickTimer {
  private id: number | null = null;
  private running = false;

  start(cb: () => void, intervalMs: number): void {
    this.stop();
    this.running = true;
    const arm = (): void => {
      this.id = window.setTimeout(() => {
        if (!this.running) return;
        cb();
        if (this.running) arm(); // cb may have called stop()
      }, intervalMs);
    };
    arm();
  }

  stop(): void {
    this.running = false;
    if (this.id !== null) {
      clearTimeout(this.id);
      this.id = null;
    }
  }
}

/** Worker-backed when the platform supports it, else the main-thread loop. */
export function defaultTickTimer(): TickTimer {
  return typeof Worker !== 'undefined' ? new WorkerTimer() : new TimeoutTimer();
}
