import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Zoetrope } from '../../../src/audio/effects/zoetrope';
import { DISCONNECT_DELAY_MS } from '../../../src/audio/effects/effect';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import {
  makeMockAudioContext,
  installMockAudioWorkletNode,
  MockAudioWorkletNode,
  type MockAudioParam,
} from '../mock-audio-context';

interface SpyNode {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function build(opts?: { maxTaps?: number }) {
  const ctx = makeMockAudioContext();
  const fx = new Zoetrope(ctx as unknown as AudioContext, opts);
  return { ctx, fx };
}

function bound() {
  const bus = new ParamBus();
  registerDefaults(bus);
  return bus;
}

function node(): MockAudioWorkletNode {
  return MockAudioWorkletNode.instances[0]!;
}

function param(name: string): MockAudioParam {
  return node().parameters.get(name);
}

describe('Zoetrope (effect shell)', () => {
  beforeEach(() => {
    installMockAudioWorkletNode();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('builds the bypass plumbing and the external input synchronously', () => {
    const { fx } = build();
    expect(fx.input).toBeDefined();
    expect(fx.output).toBeDefined();
    expect(fx.extInput).toBeDefined();
    expect(MockAudioWorkletNode.instances).toHaveLength(0);
  });

  it('tolerates setters before attachWorklet and replays them at attach', () => {
    const { fx } = build();
    fx.setScatter(0.7);
    fx.setChaos(0.9);
    fx.setSmear(0.4);
    fx.setSieve(-0.5);
    fx.setDepth(32);
    fx.setSub(0.25);
    fx.setXfadeFloor(64);
    fx.setFreeze(true);

    fx.attachWorklet();
    expect(param('scatter').setValueAtTime).toHaveBeenCalledWith(0.7, 0);
    expect(param('chaos').setValueAtTime).toHaveBeenCalledWith(0.9, 0);
    expect(param('smear').setValueAtTime).toHaveBeenCalledWith(0.4, 0);
    expect(param('sieve').setValueAtTime).toHaveBeenCalledWith(-0.5, 0);
    expect(param('depth').setValueAtTime).toHaveBeenCalledWith(32, 0);
    expect(param('sub').setValueAtTime).toHaveBeenCalledWith(0.25, 0);
    expect(param('xfadeFloor').setValueAtTime).toHaveBeenCalledWith(64, 0);
    expect(param('freeze').setValueAtTime).toHaveBeenCalledWith(1, 0);
  });

  it('creates a two-input node and splices it in exactly once', () => {
    const { fx } = build();
    fx.attachWorklet();
    fx.attachWorklet(); // idempotent
    expect(MockAudioWorkletNode.instances).toHaveLength(1);
    expect(node().workletName).toBe('zoetrope');
    expect(node().options?.numberOfInputs).toBe(2);
  });

  it('leaves the external feed unconnected on SELF and connects it on DRUMS', () => {
    const { fx } = build();
    fx.attachWorklet();
    const ext = fx.extInput as unknown as SpyNode;
    // attachWorklet must not connect it — SELF is the default.
    expect(ext.connect).not.toHaveBeenCalled();

    fx.setSource(1);
    expect(ext.connect).toHaveBeenCalledWith(node(), 0, 1);

    fx.setSource(0);
    expect(ext.disconnect).toHaveBeenCalledWith(node(), 0, 1);

    // Re-setting the same source must not double-connect.
    ext.connect.mockClear();
    fx.setSource(0);
    expect(ext.connect).not.toHaveBeenCalled();
  });

  it('connects the pitch source while pitch lock is on and drops it when off', () => {
    const { ctx, fx } = build();
    const pitch = ctx.createConstantSource() as unknown as SpyNode;
    fx.attachWorklet();
    fx.setPitchSource(pitch as unknown as ConstantSourceNode);
    // pitchlock defaults on.
    expect(pitch.connect).toHaveBeenCalledWith(param('frequency'));

    fx.setPitchLock(false);
    expect(pitch.disconnect).toHaveBeenCalledWith(param('frequency'));
    // Back to 0 so the worklet falls back to zero-crossing detection.
    expect(param('frequency').setValueAtTime).toHaveBeenCalledWith(0, 0);
  });

  it('clamps the tap count to the perf-tier ceiling', () => {
    const { fx } = build({ maxTaps: 8 });
    fx.attachWorklet();
    fx.setTaps(16);
    expect(param('taps').setValueAtTime).toHaveBeenCalledWith(8, 0);
  });

  it('disconnects the processed path after bypassing (ADR-012)', () => {
    vi.useFakeTimers();
    const { fx } = build();
    fx.attachWorklet();
    fx.setBypass(false); // engage
    fx.setBypass(true);
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS + 1);
    // The wrapper's own edges are cut, which makes the worklet — and anything
    // feeding it, including the drum tap — unreachable from the destination.
    const out = fx.output as unknown as SpyNode;
    expect(out).toBeDefined();
    expect(node().disconnect).not.toHaveBeenCalled(); // only the wrapper's edges
  });

  it('clears the library on a note only while clearOnNote is engaged', () => {
    const { fx } = build();
    fx.attachWorklet();
    const post = node().port.postMessage;
    post.mockClear();

    fx.noteOn();
    expect(post).not.toHaveBeenCalledWith('clear');

    fx.setClearOnNote(true);
    fx.noteOn();
    expect(post).toHaveBeenCalledWith('clear');
  });

  it('asks for telemetry only when told to, and replays the state at attach', () => {
    const { fx } = build();
    fx.setMetering(true); // before the node exists
    fx.attachWorklet();
    expect(node().port.postMessage).toHaveBeenCalledWith({ type: 'meter', on: true });

    fx.setMetering(false);
    expect(node().port.postMessage).toHaveBeenCalledWith({ type: 'meter', on: false });
  });

  it('forwards cycle telemetry from the port to onCycles', () => {
    const { fx } = build();
    const seen: number[] = [];
    fx.onCycles((m) => seen.push(m.count));
    fx.attachWorklet();
    node().port.onmessage?.({ data: { type: 'cycles', peaks: new Float32Array(3), head: 2, lag: 1, count: 3, hz: 220 } });
    // Anything that isn't a cycles frame is ignored.
    node().port.onmessage?.({ data: 42 });
    expect(seen).toEqual([3]);
  });

  it('self-wires every param at its prefix (ADR-008)', () => {
    const bus = bound();
    const { fx } = build();
    fx.attachWorklet();
    fx.bind(bus, 'fx.zoetrope');

    bus.set('fx.zoetrope.scatter', 0.6);
    expect(param('scatter').setTargetAtTime).toHaveBeenCalledWith(0.6, 0, 0.02);

    bus.set('fx.zoetrope.depth', 24);
    expect(param('depth').setValueAtTime).toHaveBeenCalledWith(24, 0);

    bus.set('fx.zoetrope.source', 1);
    expect(param('source').setValueAtTime).toHaveBeenCalledWith(1, 0);

    bus.set('fx.zoetrope.freeze', 1);
    expect(param('freeze').setValueAtTime).toHaveBeenCalledWith(1, 0);
  });

  it('boots bypassed from the registry defaults', () => {
    const bus = bound();
    const { fx } = build();
    const spy = vi.spyOn(fx, 'setBypass');
    fx.bind(bus, 'fx.zoetrope');
    // subscribe fires immediately with the current value — `on` defaults to 0.
    expect(spy).toHaveBeenCalledWith(true);
  });
});
