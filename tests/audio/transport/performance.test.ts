import { describe, it, expect, vi, afterEach } from 'vitest';
import { Performance } from '../../../src/audio/transport/performance';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import { TestClock } from './test-clock';
import { makeMockAudioContext, makeMockBiquadFilter } from '../mock-audio-context';

/**
 * Tests for the Performance module's pure-logic paths.
 * `mapStep` (stutter) is pure math — no AudioContext required.
 * Filter Drop / DJ Filter / Tape Stop need real AudioContext / rAF
 * so they are tested via integration only.
 */
describe('Performance.mapStep (stutter)', () => {
  // Replicate the production math inline so we can test it without
  // constructing a full Performance (which needs AudioContext).
  function mapStep(rawStep: number, stutterOn: boolean, stutterSize: number, anchor: number): number {
    if (!stutterOn) return rawStep;
    const n = stutterSize;
    const off = (((rawStep - anchor) % n) + n) % n;
    return anchor + off;
  }

  it('passthrough when stutter is off', () => {
    expect(mapStep(5, false, 2, 0)).toBe(5);
  });

  it('repeats within stutter window (size=2)', () => {
    // anchor = 4, size = 2 → steps 4,5 loop
    expect(mapStep(4, true, 2, 4)).toBe(4);
    expect(mapStep(5, true, 2, 4)).toBe(5);
    expect(mapStep(6, true, 2, 4)).toBe(4);
    expect(mapStep(7, true, 2, 4)).toBe(5);
    expect(mapStep(8, true, 2, 4)).toBe(4);
  });

  it('repeats within stutter window (size=4)', () => {
    // anchor = 10, size = 4 → steps 10,11,12,13 loop
    expect(mapStep(10, true, 4, 10)).toBe(10);
    expect(mapStep(11, true, 4, 10)).toBe(11);
    expect(mapStep(12, true, 4, 10)).toBe(12);
    expect(mapStep(13, true, 4, 10)).toBe(13);
    expect(mapStep(14, true, 4, 10)).toBe(10);
    expect(mapStep(15, true, 4, 10)).toBe(11);
  });

  it('handles rawStep smaller than anchor', () => {
    // anchor = 10, size = 4 → step 9 maps to 13 (wrapping backwards)
    expect(mapStep(9, true, 4, 10)).toBe(13);
    expect(mapStep(8, true, 4, 10)).toBe(12);
  });

  it('single-step stutter', () => {
    expect(mapStep(0, true, 1, 0)).toBe(0);
    expect(mapStep(1, true, 1, 0)).toBe(0);
    expect(mapStep(2, true, 1, 0)).toBe(0);
  });

  it('size=1 with negative offset from anchor', () => {
    // anchor = 5, size = 1 → step 4 wraps to 5
    expect(mapStep(4, true, 1, 5)).toBe(5);
  });
});

const DJ_OPEN_HZ = 20000;

function makePerf() {
  const ctx = makeMockAudioContext();
  const clock = new TestClock();
  const bus = new ParamBus();
  registerDefaults(bus);
  const djFilter = makeMockBiquadFilter();
  const perf = new Performance(
    ctx as unknown as AudioContext,
    clock,
    bus,
    djFilter as unknown as BiquadFilterNode,
  );
  return { ctx, clock, bus, djFilter, perf };
}

describe('Performance.setFill', () => {
  it('toggles the fillActive flag the machines read', () => {
    const { perf } = makePerf();
    expect(perf.fillActive).toBe(false);
    perf.setFill(true);
    expect(perf.fillActive).toBe(true);
    perf.setFill(false);
    expect(perf.fillActive).toBe(false);
  });
});

describe('Performance.setDjFilter', () => {
  it('opens fully to a lowpass at DJ_OPEN_HZ near zero', () => {
    const { perf, djFilter } = makePerf();
    perf.setDjFilter(0);
    expect(djFilter.type).toBe('lowpass');
    expect(djFilter.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(DJ_OPEN_HZ, expect.any(Number));
  });

  it('dives into a lowpass for negative values', () => {
    const { perf, djFilter } = makePerf();
    perf.setDjFilter(-0.5);
    expect(djFilter.type).toBe('lowpass');
    const target = djFilter.frequency.exponentialRampToValueAtTime.mock.calls.at(-1)![0] as number;
    expect(target).toBeLessThan(DJ_OPEN_HZ); // swept down from open
  });

  it('switches to a highpass for positive values', () => {
    const { perf, djFilter } = makePerf();
    perf.setDjFilter(0.5);
    expect(djFilter.type).toBe('highpass');
  });

  it('is a no-op while a Filter Drop is held', () => {
    const { perf, djFilter } = makePerf();
    perf.setDrop(true); // drop now owns the node
    vi.clearAllMocks();
    perf.setDjFilter(0.8);
    expect(djFilter.frequency.cancelScheduledValues).not.toHaveBeenCalled();
  });
});

describe('Performance.setDrop', () => {
  it('dives to a resonant lowpass on press and restores on release', () => {
    const { perf, djFilter } = makePerf();
    perf.setDrop(true);
    expect(djFilter.type).toBe('lowpass');
    expect(djFilter.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(160, expect.any(Number));
    expect(djFilter.Q.linearRampToValueAtTime).toHaveBeenCalledWith(9, expect.any(Number));

    vi.clearAllMocks();
    perf.setDrop(false); // returns to the (default 0) knob position → open lowpass
    expect(djFilter.type).toBe('lowpass');
    expect(djFilter.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(DJ_OPEN_HZ, expect.any(Number));
  });
});

describe('Performance.setTapeStop', () => {
  let now = 0;
  afterEach(() => vi.unstubAllGlobals());

  function stubRaf() {
    // One synchronous frame that advances the clock past the ramp duration so
    // the ease reaches its endpoint in a single step.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { now += 100000; cb(now); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('performance', { now: () => now });
  }

  it('ramps the BPM and pitch down on press', () => {
    now = 1000;
    stubRaf();
    const { perf, clock, bus } = makePerf();
    const setBpm = vi.spyOn(clock, 'setBpm');

    perf.setTapeStop(true);
    expect(setBpm).toHaveBeenLastCalledWith(20); // dives to the floor BPM
    expect(bus.get('master.pitchBend')).toBe(-1); // and bends pitch fully down
  });

  it('recovers the BPM and pitch on release', () => {
    now = 1000;
    stubRaf();
    const { perf, clock, bus } = makePerf();
    perf.setTapeStop(true);
    const setBpm = vi.spyOn(clock, 'setBpm');

    perf.setTapeStop(false);
    expect(setBpm).toHaveBeenLastCalledWith(120); // back to the original BPM
    expect(bus.get('master.pitchBend')).toBe(0);
  });

  it('gates the clock ramp while slaved: pitch bends but the clock is never set', () => {
    now = 1000;
    stubRaf();
    const { perf, clock, bus } = makePerf();
    perf.clockRampAllowed = () => false; // as the Engine sets it while slaved
    const setBpm = vi.spyOn(clock, 'setBpm');

    perf.setTapeStop(true);
    expect(setBpm).not.toHaveBeenCalled();        // per-frame ramp skipped
    expect(bus.get('master.pitchBend')).toBe(-1); // pitch still bends fully down

    perf.setTapeStop(false);
    expect(setBpm).not.toHaveBeenCalled();        // the restore is skipped too
    expect(bus.get('master.pitchBend')).toBe(0);  // pitch still recovers
  });
});
