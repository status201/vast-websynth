import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Scope,
  SCOPE_SLEEP_AFTER_MS,
  SCOPE_WAKE_POLL_MS,
  SCOPE_STALL_MS,
  PEAK_HOLD_SEC,
  PEAK_DECAY_DB_PER_SEC,
  SPECTRUM_DB_RANGE,
} from '../../src/ui/components/scope';
import { frameScheduler, recordingCtx, sizeCanvas } from './scope-harness';

/**
 * scope.md REQ-a-scope-with-nothing-to-show-sleeps. Idle, the scope redrew a flat
 * line every vsync: most of the app's idle main-thread time, and a main-thread
 * frame that restyled the play button's composited pulse 60 times a second. A
 * silent scope now stops arming frames and polls its analysers instead.
 */

/** An analyser whose level the test sets; counts the time-domain reads the poll makes. */
function analyser() {
  const a = {
    level: 0,
    byte: 0,
    reads: 0,
    fftSize: 1024,
    frequencyBinCount: 512,
    smoothingTimeConstant: 0.2,
    context: { sampleRate: 48000 },
    getFloatTimeDomainData(b: Float32Array) { a.reads++; b.fill(a.level); },
    getByteFrequencyData(b: Uint8Array) { b.fill(a.byte); },
  };
  return a;
}

let hidden = false;
const setHidden = (v: boolean): void => {
  hidden = v;
  document.dispatchEvent(new Event('visibilitychange'));
};

function mount() {
  const frames = frameScheduler();
  const painter = recordingCtx();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(painter.ctx as unknown as RenderingContext);
  const an = analyser();
  const scope = new Scope({ mono: an as unknown as AnalyserNode });
  document.body.appendChild(scope.el);
  sizeCanvas(scope.el);
  /** Let `ms` pass, then deliver the queued frame, as a 60 Hz display would. */
  const frame = (ms = 16): void => {
    vi.advanceTimersByTime(ms);
    frames.run(performance.now());
  };
  /** Frames for `ms`; stops early if the loop stops arming them. */
  const frameFor = (ms: number, step = 16): void => {
    for (let t = 0; t < ms && frames.queued > 0; t += step) frame(step);
  };
  const putToSleep = (): void => {
    frameFor(SCOPE_SLEEP_AFTER_MS + 200);
    expect(scope.health.asleep).toBe(true);
  };
  return { frames, painter, an, scope, frame, frameFor, putToSleep };
}

beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'], now: 10_000 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('a scope with nothing to show sleeps (REQ-a-scope-with-nothing-to-show-sleeps)', () => {
  it('stops arming frames after SCOPE_SLEEP_AFTER_MS of silence, and only polls', () => {
    const { frames, painter, an, scope, frameFor } = mount();
    frameFor(SCOPE_SLEEP_AFTER_MS - 100);
    expect(frames.queued).toBe(1);          // not yet
    expect(scope.health.asleep).toBe(false);

    frameFor(300);
    expect(frames.queued).toBe(0);          // asleep: no frame armed
    expect(scope.health.asleep).toBe(true);

    painter.reset();
    const reads = an.reads;
    vi.advanceTimersByTime(SCOPE_WAKE_POLL_MS * 4);
    expect(an.reads - reads).toBe(4);       // one analyser read per poll…
    expect(painter.calls).toEqual([]);      // …and nothing drawn
    expect(frames.queued).toBe(0);
    scope.destroy();
  });

  it('a sound wakes it within one poll, and it draws', () => {
    const { frames, painter, an, scope, putToSleep } = mount();
    putToSleep();
    an.level = 0.1;
    vi.advanceTimersByTime(SCOPE_WAKE_POLL_MS);
    expect(scope.health.asleep).toBe(false);
    expect(frames.queued).toBe(1);
    painter.reset();
    frames.run(performance.now());
    expect(painter.drew()).toBe(true);
    expect(scope.health.restarts).toBe(0);  // a wake is not a recovery
    scope.destroy();
  });

  it('keeps a sounding scope drawing', () => {
    const { frames, an, scope, frameFor } = mount();
    an.level = 0.1;
    frameFor(3000);
    expect(frames.queued).toBe(1);
    expect(scope.health.asleep).toBe(false);
    scope.destroy();
  });

  it('the Spectrum stays awake until its held peak has fallen to the floor (edge)', () => {
    const { frames, an, scope, frame, frameFor } = mount();
    scope.setMode('spectrum');
    an.byte = 255;                          // a full-scale bar pins the peak at the top
    frameFor(200, 100);
    an.byte = 0;                            // then silence
    const fallS = PEAK_HOLD_SEC + SPECTRUM_DB_RANGE / PEAK_DECAY_DB_PER_SEC;
    frameFor((fallS - 2) * 1000, 100);
    expect(scope.health.asleep).toBe(false); // the marker is still moving
    expect(frames.queued).toBe(1);
    frameFor(3000 + SCOPE_SLEEP_AFTER_MS, 100);
    expect(scope.health.asleep).toBe(true);
    expect(frames.queued).toBe(0);
    frame();                                // nothing queued, nothing runs
    scope.destroy();
  });

  it('every control and the pointer wake it, uncounted, and it redraws', () => {
    const actions: [string, (s: Scope) => void][] = [
      ['setMode', (s) => s.setMode('spectrum')],
      ['setChannels', (s) => s.setChannels('mono')],
      ['setZones', (s) => s.setZones(true)],
      ['resetPeak', (s) => s.resetPeak()],
      ['setFps', (s) => s.setFps(30)],
      ['setFftSize', (s) => s.setFftSize(2048)],
      ['click', (s) => s.el.dispatchEvent(new Event('click'))],
      ['pointermove', (s) => {
        const e = new Event('pointermove');
        Object.defineProperties(e, { pointerType: { value: 'mouse' }, offsetX: { value: 40 }, offsetY: { value: 20 } });
        s.el.dispatchEvent(e);
      }],
    ];
    for (const [name, act] of actions) {
      const { frames, painter, scope, putToSleep } = mount();
      if (name === 'pointermove') scope.setMode('spectrum'); // hover is Spectrum-only
      putToSleep();
      act(scope);
      expect(scope.health.asleep, name).toBe(false);
      expect(frames.queued, name).toBe(1);
      expect(scope.health.restarts, name).toBe(0);
      painter.reset();
      frames.run(performance.now());
      expect(painter.drew(), name).toBe(true);
      scope.destroy();
      vi.restoreAllMocks();
      document.body.innerHTML = '';
    }
  });

  it('a hover cursor keeps it awake while the input is silent', () => {
    const { frames, scope, frameFor } = mount();
    scope.setMode('spectrum');
    const e = new Event('pointermove');
    Object.defineProperties(e, { pointerType: { value: 'mouse' }, offsetX: { value: 40 }, offsetY: { value: 20 } });
    scope.el.dispatchEvent(e);
    frameFor(SCOPE_SLEEP_AFTER_MS * 3);
    expect(scope.health.asleep).toBe(false);
    expect(frames.queued).toBe(1);
    scope.destroy();
  });

  it('is not a stall: the watchdog leaves it asleep, and health says asleep (REQ-a-watchdog-restarts-a-stalled-loop)', () => {
    const { frames, scope, putToSleep } = mount();
    putToSleep();
    vi.advanceTimersByTime(SCOPE_STALL_MS * 3);   // several watchdog ticks on a stopped loop
    expect(scope.health.restarts).toBe(0);
    expect(frames.queued).toBe(0);
    expect(scope.health.asleep).toBe(true);
    expect(scope.health.drawing).toBe(false);
    // A window focus is an ensureLive: it wakes the loop, and that is no restart either.
    window.dispatchEvent(new Event('focus'));
    expect(frames.queued).toBe(1);
    expect(scope.health.restarts).toBe(0);
    scope.destroy();
  });

  it('polls nothing while the page is hidden, and wakes on return', () => {
    const { frames, an, scope, putToSleep } = mount();
    putToSleep();
    setHidden(true);
    expect(scope.health.asleep).toBe(false);      // hidden is plain stopped
    const reads = an.reads;
    vi.advanceTimersByTime(SCOPE_WAKE_POLL_MS * 10);
    expect(an.reads).toBe(reads);
    setHidden(false);
    expect(frames.queued).toBe(1);
    scope.destroy();
  });

  it('destroy stops the wake poll', () => {
    const { an, scope, putToSleep } = mount();
    putToSleep();
    scope.destroy();
    const reads = an.reads;
    vi.advanceTimersByTime(SCOPE_WAKE_POLL_MS * 10);
    expect(an.reads).toBe(reads);
  });
});
