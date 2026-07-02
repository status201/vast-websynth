import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BypassWrapper, DISCONNECT_DELAY_MS } from '../../../src/audio/effects/effect';
import { Compressor } from '../../../src/audio/effects/compressor';
import { makeMockAudioContext, installMockAudioWorkletNode, MockAudioWorkletNode } from '../mock-audio-context';

/**
 * True bypass (ADR-012, effects.md REQ-2 v3): a bypassed wrapper disconnects
 * its own two edges after the crossfade settles so the processed DSP stops
 * being rendered; un-bypassing reconnects them *before* ramping.
 */
describe('BypassWrapper true bypass', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  type Spy = ReturnType<typeof vi.fn>;
  function build() {
    const ctx = makeMockAudioContext();
    const wrap = new BypassWrapper(ctx as unknown as AudioContext, 1);
    return {
      wrap,
      inConnect: wrap.input.connect as unknown as Spy,
      inDisconnect: wrap.input.disconnect as unknown as Spy,
      outDisconnect: wrap.processedOut.disconnect as unknown as Spy,
      outConnect: wrap.processedOut.connect as unknown as Spy,
    };
  }

  it('boots bypassed and disconnects both edges after the delay', () => {
    const { wrap, inDisconnect, outDisconnect } = build();
    expect(inDisconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DISCONNECT_DELAY_MS);
    expect(inDisconnect).toHaveBeenCalledExactlyOnceWith(wrap.processedIn);
    expect(outDisconnect).toHaveBeenCalledExactlyOnceWith(wrap.wet);
  });

  it('un-bypass reconnects both edges (before the ramp), bypass re-disconnects', () => {
    const { wrap, inConnect, inDisconnect, outConnect } = build();
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS); // disconnected

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
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS); // disconnected
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

    comp.attachWorklet(); // splices processedIn → worklet → processedOut internally
    const worklet = MockAudioWorkletNode.instances[0]!;
    expect(worklet.connect).toHaveBeenCalled(); // node.output → processedOut held

    comp.setBypass(false);
    expect(inConnect).toHaveBeenLastCalledWith(processedIn); // wrapper edge back
  });
});
