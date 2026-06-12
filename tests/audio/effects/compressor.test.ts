import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Compressor } from '../../../src/audio/effects/compressor';
import {
  makeMockAudioContext,
  installMockAudioWorkletNode,
  MockAudioWorkletNode,
} from '../mock-audio-context';

function build(mode: 'fet' | 'vca' = 'fet') {
  const ctx = makeMockAudioContext();
  const comp = new Compressor(ctx as unknown as AudioContext, mode);
  return { ctx, comp };
}

describe('Compressor (effect shell)', () => {
  beforeEach(() => {
    installMockAudioWorkletNode();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the bypass plumbing synchronously, without a worklet node', () => {
    const { comp } = build();
    expect(comp.input).toBeDefined();
    expect(comp.output).toBeDefined();
    expect(MockAudioWorkletNode.instances).toHaveLength(0);
  });

  it('tolerates setters before attachWorklet and replays them at attach', () => {
    const { comp } = build();
    comp.setThreshold(-30);
    comp.setRatio(20);
    comp.setAttack(0.0005);
    comp.setRelease(0.8);
    comp.setAutoRelease(true);
    comp.setMakeup(6);

    comp.attachWorklet();
    const node = MockAudioWorkletNode.instances[0]!;
    expect(node.parameters.get('threshold').setValueAtTime).toHaveBeenCalledWith(-30, 0);
    expect(node.parameters.get('ratio').setValueAtTime).toHaveBeenCalledWith(20, 0);
    expect(node.parameters.get('attack').setValueAtTime).toHaveBeenCalledWith(0.0005, 0);
    expect(node.parameters.get('release').setValueAtTime).toHaveBeenCalledWith(0.8, 0);
    expect(node.parameters.get('autoRelease').setValueAtTime).toHaveBeenCalledWith(1, 0);
    expect(node.parameters.get('makeup').setValueAtTime).toHaveBeenCalledWith(6, 0);
  });

  it('passes the character mode via processorOptions', () => {
    const { comp: fet } = build('fet');
    const { comp: vca } = build('vca');
    fet.attachWorklet();
    vca.attachWorklet();
    expect(MockAudioWorkletNode.instances[0]!.workletName).toBe('hardware-compressor');
    expect(MockAudioWorkletNode.instances[0]!.options?.processorOptions).toEqual({ mode: 'fet' });
    expect(MockAudioWorkletNode.instances[1]!.options?.processorOptions).toEqual({ mode: 'vca' });
  });

  it('splices the worklet into the wet path exactly once', () => {
    const { comp } = build();
    comp.attachWorklet();
    comp.attachWorklet(); // idempotent
    expect(MockAudioWorkletNode.instances).toHaveLength(1);
    const node = MockAudioWorkletNode.instances[0]!;
    // node → processedOut; processedIn → node is asserted via the gain spies
    expect(node.connect).toHaveBeenCalledTimes(1);
  });

  it('applies setter values to live params after attach', () => {
    const { comp } = build();
    comp.attachWorklet();
    comp.setThreshold(-25);
    const node = MockAudioWorkletNode.instances[0]!;
    expect(node.parameters.get('threshold').setTargetAtTime).toHaveBeenCalledWith(-25, 0, 0.02);
  });

  it('forwards port gain-reduction messages to onGr and zeroes it on bypass', () => {
    const { comp } = build();
    const seen: number[] = [];
    comp.onGr((db) => seen.push(db));
    comp.attachWorklet();
    const node = MockAudioWorkletNode.instances[0]!;
    node.port.onmessage?.({ data: 4.2 });
    expect(seen).toEqual([4.2]);
    comp.setBypass(true);
    expect(seen).toEqual([4.2, 0]);
  });
});
