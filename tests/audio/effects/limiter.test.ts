// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Limiter } from '../../../src/audio/effects/limiter';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import {
  makeMockAudioContext,
  installMockAudioWorkletNode,
  MockAudioWorkletNode,
} from '../mock-audio-context';

function build() {
  const ctx = makeMockAudioContext();
  const lim = new Limiter(ctx as unknown as AudioContext);
  // The wrapper's internals, for edge assertions (the mock records connect calls).
  const wrap = (lim as unknown as {
    wrap: { processedIn: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }; processedOut: unknown };
  }).wrap;
  return { ctx, lim, wrap };
}

describe('Limiter (effect shell)', () => {
  beforeEach(() => {
    installMockAudioWorkletNode();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a wire until its worklet attaches (REQ-a-failed-load-never-mutes-the-master)', () => {
    const { lim, wrap } = build();
    expect(MockAudioWorkletNode.instances).toHaveLength(0);
    expect(lim.attached).toBe(false);
    expect(wrap.processedIn.connect).toHaveBeenCalledWith(wrap.processedOut);
  });

  it('swaps the passthrough for the node and replays drive and ceiling', () => {
    const { lim, wrap } = build();
    lim.setDrive(6);
    lim.setCeiling(-1);
    lim.attachWorklet();

    const node = MockAudioWorkletNode.instances[0]!;
    expect(node.workletName).toBe('master-limiter');
    expect(wrap.processedIn.disconnect).toHaveBeenCalledWith(wrap.processedOut);
    expect(wrap.processedIn.connect).toHaveBeenCalledWith(node);
    expect(node.connect).toHaveBeenCalledWith(wrap.processedOut);
    expect(node.parameters.get('drive').setValueAtTime).toHaveBeenCalledWith(6, 0);
    expect(node.parameters.get('ceiling').setValueAtTime).toHaveBeenCalledWith(-1, 0);
    expect(lim.attached).toBe(true);

    lim.attachWorklet(); // idempotent
    expect(MockAudioWorkletNode.instances).toHaveLength(1);
  });

  it('smooths drive and ceiling once attached (REQ-drive-and-ceiling-are-continuous)', () => {
    const { lim } = build();
    lim.attachWorklet();
    const node = MockAudioWorkletNode.instances[0]!;
    lim.setDrive(3);
    lim.setCeiling(-2);
    expect(node.parameters.get('drive').setTargetAtTime).toHaveBeenCalledWith(3, 0, expect.any(Number));
    expect(node.parameters.get('ceiling').setTargetAtTime).toHaveBeenCalledWith(-2, 0, expect.any(Number));
  });

  it('binds .on/.drive/.ceiling, on by default, and bypass clears the meter', () => {
    const { lim } = build();
    const bus = new ParamBus();
    registerDefaults(bus);
    const bypass = vi.spyOn(lim, 'setBypass');
    lim.bind(bus, 'fx.master.limit');
    expect(bus.get('fx.master.limit.on')).toBe(1);
    expect(bypass).toHaveBeenLastCalledWith(false);

    const gr = vi.fn();
    lim.onGr(gr);
    bus.set('fx.master.limit.on', 0);
    expect(bypass).toHaveBeenLastCalledWith(true);
    expect(gr).toHaveBeenLastCalledWith(0);
  });

  it('drops a draining worklet’s late post, and resets it before the disconnect (REQ-re-engaging-starts-at-rest)', () => {
    vi.useFakeTimers();
    try {
      const { lim } = build();
      const gr = vi.fn();
      lim.onGr(gr);
      lim.attachWorklet();
      lim.setBypass(false);
      const node = MockAudioWorkletNode.instances[0]!;
      node.port.onmessage?.({ data: 4 });
      expect(gr).toHaveBeenLastCalledWith(4);

      lim.setBypass(true);
      expect(gr).toHaveBeenLastCalledWith(0);
      node.port.onmessage?.({ data: 4 }); // the worklet still runs through the drain
      expect(gr).toHaveBeenLastCalledWith(0);

      expect(node.port.postMessage).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000); // past the input cut and the drain
      expect(node.port.postMessage).toHaveBeenCalledWith('reset');
    } finally {
      vi.useRealTimers();
    }
  });

  it('relays the worklet’s gain reduction to the meter', () => {
    const { lim } = build();
    const gr = vi.fn();
    lim.onGr(gr);
    lim.attachWorklet();
    lim.setBypass(false);
    const node = MockAudioWorkletNode.instances[0]!;
    node.port.onmessage?.({ data: 4.5 } as MessageEvent);
    expect(gr).toHaveBeenCalledWith(4.5);
  });
});
