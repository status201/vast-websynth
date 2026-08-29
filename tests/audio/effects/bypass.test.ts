import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BypassWrapper, DISCONNECT_DELAY_MS, DRAIN_DEFAULT_S } from '../../../src/audio/effects/effect';
import { Compressor } from '../../../src/audio/effects/compressor';
import { Delay } from '../../../src/audio/effects/delay';
import { Reverb } from '../../../src/audio/effects/reverb';
import { Phaser } from '../../../src/audio/effects/phaser';
import { Distortion } from '../../../src/audio/effects/distortion';
import { makeMockAudioContext, installMockAudioWorkletNode, MockAudioWorkletNode } from '../mock-audio-context';

/**
 * True bypass (ADR-012, effects.md REQ-2/REQ-2c): a bypassed wrapper disconnects
 * its own two edges so the processed DSP stops being rendered; un-bypassing
 * reconnects them *before* ramping.
 *
 * Since v8 the two edges go down in **two stages**, because dropping both at
 * once freezes the DSP rather than clearing it — a delay line keeps its ring
 * buffer, and re-enabling replays the previous song. So the input edge goes at
 * `DISCONNECT_DELAY_MS`, the effect quiesces any feedback loop, and the output
 * edge follows only after `drainSeconds()` of silence has washed through.
 */
describe('BypassWrapper true bypass', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  type Spy = ReturnType<typeof vi.fn>;
  const DRAIN_MS = DRAIN_DEFAULT_S * 1000;

  function build(hooks?: { drainSeconds?: number; quiesce?: Spy }) {
    const ctx = makeMockAudioContext();
    const quiesce = hooks?.quiesce ?? vi.fn();
    const wrap = new BypassWrapper(ctx as unknown as AudioContext, 1, {
      drainSeconds: () => hooks?.drainSeconds ?? DRAIN_DEFAULT_S,
      quiesce: (on: boolean) => quiesce(on),
    });
    return {
      wrap,
      quiesce,
      inConnect: wrap.input.connect as unknown as Spy,
      inDisconnect: wrap.input.disconnect as unknown as Spy,
      outDisconnect: wrap.processedOut.disconnect as unknown as Spy,
      outConnect: wrap.processedOut.connect as unknown as Spy,
    };
  }

  /** Past both stages: the input cut, then the drain. */
  const settleTeardown = (drainMs = DRAIN_MS): void => {
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS);
    vi.advanceTimersByTime(drainMs);
  };

  it('boots bypassed and cuts the input first, the output only after the drain', () => {
    const { wrap, inDisconnect, outDisconnect, quiesce } = build({ drainSeconds: 2 });
    expect(inDisconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DISCONNECT_DELAY_MS);
    expect(inDisconnect).toHaveBeenCalledExactlyOnceWith(wrap.processedIn);
    // The output edge is still up: the DSP has to keep rendering to empty itself.
    expect(outDisconnect).not.toHaveBeenCalled();
    expect(quiesce).toHaveBeenCalledExactlyOnceWith(true);

    vi.advanceTimersByTime(2000);
    expect(outDisconnect).toHaveBeenCalledExactlyOnceWith(wrap.wet);
  });

  it('a re-enable during the drain cancels it and undoes the quiesce (REQ-2c)', () => {
    const { wrap, inConnect, outDisconnect, quiesce } = build({ drainSeconds: 2 });
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS);      // input cut, draining
    vi.advanceTimersByTime(500);                      // still mid-drain

    wrap.setBypass(false);
    expect(inConnect).toHaveBeenLastCalledWith(wrap.processedIn);
    expect(quiesce).toHaveBeenLastCalledWith(false);

    // The pending output disconnect must not land afterwards.
    vi.advanceTimersByTime(5000);
    expect(outDisconnect).not.toHaveBeenCalled();
  });

  it('a fully drained effect reconnects both edges, in wiring order', () => {
    const { wrap, inConnect, outConnect, outDisconnect } = build();
    settleTeardown();
    expect(outDisconnect).toHaveBeenCalledExactlyOnceWith(wrap.wet);

    wrap.setBypass(false);
    // Output first, then input: the path is whole before anything can enter it.
    const outIdx = outConnect.mock.invocationCallOrder.at(-1)!;
    const inIdx = inConnect.mock.invocationCallOrder.at(-1)!;
    expect(outIdx).toBeLessThan(inIdx);
  });

  it('un-bypass reconnects both edges (before the ramp), bypass re-disconnects', () => {
    const { wrap, inConnect, inDisconnect, outConnect } = build();
    settleTeardown(); // fully torn down

    wrap.setBypass(false);
    expect(inConnect).toHaveBeenLastCalledWith(wrap.processedIn);
    expect(outConnect).toHaveBeenLastCalledWith(wrap.wet);

    wrap.setBypass(true);
    expect(inDisconnect).toHaveBeenCalledTimes(1); // not yet — ramp first
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS);
    expect(inDisconnect).toHaveBeenCalledTimes(2);
  });

  it('a rapid bypass→un-bypass toggle never disconnects mid-ramp', () => {
    const { inDisconnect, wrap } = build();
    wrap.setBypass(false); // cancels the boot-time disconnect

    wrap.setBypass(true);
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS / 2);
    wrap.setBypass(false); // re-enabled before the delay elapsed

    vi.advanceTimersByTime(DISCONNECT_DELAY_MS * 4);
    expect(inDisconnect).not.toHaveBeenCalled();
  });

  it('setMix while bypassed-and-disconnected does not reconnect', () => {
    const { wrap, inConnect } = build();
    settleTeardown(); // fully torn down
    const connectsBefore = inConnect.mock.calls.length;

    wrap.setMix(0.5);
    expect(inConnect.mock.calls.length).toBe(connectsBefore);
  });

  it('compressor attach while bypassed-and-disconnected stays intact on enable', () => {
    installMockAudioWorkletNode();
    const ctx = makeMockAudioContext();
    const comp = new Compressor(ctx as unknown as AudioContext, 'vca');
    const inConnect = comp.input.connect as unknown as ReturnType<typeof vi.fn>;
    const inDisconnect = comp.input.disconnect as unknown as ReturnType<typeof vi.fn>;
    // Constructor wired input→dry then input→processedIn.
    const processedIn = inConnect.mock.calls[1]![0];

    vi.advanceTimersByTime(DISCONNECT_DELAY_MS);
    expect(inDisconnect).toHaveBeenCalledWith(processedIn);
    vi.advanceTimersByTime(DRAIN_MS);

    comp.attachWorklet(); // splices processedIn → worklet → processedOut internally
    const worklet = MockAudioWorkletNode.instances[0]!;
    expect(worklet.connect).toHaveBeenCalled(); // node.output → processedOut held

    comp.setBypass(false);
    expect(inConnect).toHaveBeenLastCalledWith(processedIn); // wrapper edge back
  });
});

/**
 * The per-effect drain declarations (effects.md REQ-2c). These are the numbers
 * that decide whether a re-enabled effect is silent or replays the last song, so
 * they are pinned against the real classes rather than the wrapper's default.
 */
describe('what each effect declares about its own memory (REQ-2c)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  type Drainable = { drainSeconds(): number; quiesce(on: boolean): void };
  const asDrainable = (fx: object): Drainable => fx as unknown as Drainable;

  it('the delay declares its whole buffer, and zeroes feedback to empty it', () => {
    const ctx = makeMockAudioContext();
    const delay = new Delay(ctx as unknown as AudioContext);
    // The DelayNode is created with a 2 s maximum; silence in for that long is
    // silence throughout, whatever the read pointer is doing.
    expect(asDrainable(delay).drainSeconds()).toBe(2);

    const fb = (delay as unknown as { feedback: GainNode }).feedback.gain as unknown as {
      setValueAtTime: ReturnType<typeof vi.fn>;
    };
    delay.setFeedback(0.9);
    asDrainable(delay).quiesce(true);
    expect(fb.setValueAtTime).toHaveBeenLastCalledWith(0, expect.any(Number));

    // A knob move while quiesced is recorded, not applied …
    delay.setFeedback(0.4);
    expect(fb.setValueAtTime).toHaveBeenLastCalledWith(0, expect.any(Number));
    // … and the restore lands on what the knob says NOW, not on 0.9.
    asDrainable(delay).quiesce(false);
    expect(fb.setValueAtTime).toHaveBeenLastCalledWith(0.4, expect.any(Number));
  });

  it('the reverb declares its IR length, which a perf tier caps', () => {
    const ctx = makeMockAudioContext();
    expect(asDrainable(new Reverb(ctx as unknown as AudioContext)).drainSeconds()).toBe(4);
    expect(asDrainable(new Reverb(ctx as unknown as AudioContext, { maxIrS: 1.5 })).drainSeconds())
      .toBe(1.5);
  });

  it('the phaser declares its short feedback loop', () => {
    const ctx = makeMockAudioContext();
    expect(asDrainable(new Phaser(ctx as unknown as AudioContext)).drainSeconds()).toBe(0.1);
  });

  it('a stateless effect takes the default and quiesces nothing', () => {
    const ctx = makeMockAudioContext();
    const dist = new Distortion(ctx as unknown as AudioContext);
    expect(asDrainable(dist).drainSeconds()).toBe(DRAIN_DEFAULT_S);
    expect(() => asDrainable(dist).quiesce(true)).not.toThrow();
  });
});
