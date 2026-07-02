/**
 * Timer worker for the transport clock (see `tick-timer.ts`). It only posts
 * empty wakeups on an interval — all scheduling stays on the main thread —
 * but running the interval here keeps the wakeups coming through main-thread
 * jank and background-tab timer throttling.
 */
type TimerCommand = { cmd: 'start'; ms: number } | { cmd: 'stop' };

let id: ReturnType<typeof setInterval> | null = null;

self.onmessage = (e: MessageEvent<TimerCommand>) => {
  if (id !== null) {
    clearInterval(id);
    id = null;
  }
  if (e.data.cmd === 'start') {
    id = setInterval(() => self.postMessage(0), e.data.ms);
  }
};
