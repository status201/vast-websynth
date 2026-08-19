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
const DJ_HP_REST_HZ = 20;

function makePerf() {
  const ctx = makeMockAudioContext();
  const clock = new TestClock();
  const bus = new ParamBus();
  registerDefaults(bus);
  // A SERIES pair (performance.md REQ-9): lowpass then highpass, each holding the
  // type it was built with. `type` is set here only as the constructor would.
  const djLow = makeMockBiquadFilter();
  const djHigh = makeMockBiquadFilter();
  djLow.type = 'lowpass';
  djHigh.type = 'highpass';
  const perf = new Performance(
    ctx as unknown as AudioContext,
    clock,
    bus,
    djLow as unknown as BiquadFilterNode,
    djHigh as unknown as BiquadFilterNode,
  );
  return { ctx, clock, bus, djLow, djHigh, perf };
}

/** Last frequency a side was ramped to, or null if it was never touched. */
const rampedTo = (node: { frequency: { exponentialRampToValueAtTime: { mock: { calls: unknown[][] } } } }) =>
  (node.frequency.exponentialRampToValueAtTime.mock.calls.at(-1)?.[0] as number | undefined) ?? null;

// performance.md REQ-7 — the stutter window is anchored to an ABSOLUTE step, so
// a playhead jump would otherwise be folded back into the old window.
describe('Performance stutter re-anchor on seek', () => {
  it('re-anchors to the new position instead of replaying the old window', () => {
    const { clock, perf } = makePerf();
    clock.step = 4;
    perf.setStutterSize(2);
    perf.setStutter(true);            // anchor = 4 → the window is [4, 6)
    expect(perf.mapStep(9)).toBe(5);  // folded back into the old window

    clock.fireSeek(40);
    expect(perf.mapStep(40)).toBe(40);
    expect(perf.mapStep(41)).toBe(41);
    expect(perf.mapStep(42)).toBe(40); // a fresh window at the new position
  });

  it('handles a backwards jump (the case that used to replay forever)', () => {
    const { clock, perf } = makePerf();
    clock.step = 100;
    perf.setStutterSize(4);
    perf.setStutter(true);
    clock.fireSeek(8);
    expect(perf.mapStep(8)).toBe(8);
    expect(perf.mapStep(11)).toBe(11);
    expect(perf.mapStep(12)).toBe(8);
  });

  it('changes nothing while stutter is off (mapStep stays the identity)', () => {
    const { clock, perf } = makePerf();
    clock.fireSeek(37);
    expect(perf.mapStep(5)).toBe(5);
    expect(perf.mapStep(99)).toBe(99);
  });
});

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
  it('rests both sides transparent near zero', () => {
    const { perf, djLow, djHigh } = makePerf();
    perf.setDjFilter(0);
    expect(rampedTo(djLow)).toBe(DJ_OPEN_HZ);
    expect(rampedTo(djHigh)).toBe(DJ_HP_REST_HZ);
  });

  it('dives the lowpass side for negative values, leaving the highpass at rest', () => {
    const { perf, djLow, djHigh } = makePerf();
    perf.setDjFilter(-0.5);
    expect(rampedTo(djLow)).toBeLessThan(DJ_OPEN_HZ); // swept down from open
    expect(rampedTo(djHigh)).toBe(DJ_HP_REST_HZ);     // untouched, transparent
  });

  it('raises the highpass side for positive values, leaving the lowpass open', () => {
    const { perf, djLow, djHigh } = makePerf();
    perf.setDjFilter(0.5);
    expect(rampedTo(djHigh)).toBeGreaterThan(DJ_HP_REST_HZ);
    expect(rampedTo(djLow)).toBe(DJ_OPEN_HZ);
  });

  /**
   * REQ-9, regression. This is the whole point of the pair: a motion lane whose
   * anchors straddle centre used to flip a live biquad's type six times a bar,
   * and each flip swapped the coefficients under the filter's own state — a click
   * on the master bus, heard on every voice.
   */
  it('never reassigns either filter type while sweeping through centre', () => {
    const { perf, djLow, djHigh } = makePerf();
    for (let x = -1; x <= 1.0001; x += 0.01) perf.setDjFilter(Number(x.toFixed(3)));
    expect(djLow.type).toBe('lowpass');
    expect(djHigh.type).toBe('highpass');
  });

  it('is a no-op while a Filter Drop is held', () => {
    const { perf, djLow } = makePerf();
    perf.setDrop(true); // drop now owns the lowpass side
    vi.clearAllMocks();
    perf.setDjFilter(0.8);
    expect(djLow.frequency.cancelScheduledValues).not.toHaveBeenCalled();
  });
});

describe('Performance.setDrop', () => {
  it('dives the lowpass side on press and restores on release', () => {
    const { perf, djLow, djHigh } = makePerf();
    perf.setDrop(true);
    expect(djLow.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(160, expect.any(Number));
    expect(djLow.Q.linearRampToValueAtTime).toHaveBeenCalledWith(9, expect.any(Number));
    // REQ-3: the drop overrides the knob, so the highpass side opens back out
    // rather than band-passing the dive.
    expect(rampedTo(djHigh)).toBe(DJ_HP_REST_HZ);

    vi.clearAllMocks();
    perf.setDrop(false); // returns to the (default 0) knob position → both transparent
    expect(rampedTo(djLow)).toBe(DJ_OPEN_HZ);
    expect(rampedTo(djHigh)).toBe(DJ_HP_REST_HZ);
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
