// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Flanger } from '../../../src/audio/effects/flanger';
import { loadFlangerModule } from '../../../src/audio/effects/flanger-live';
import { createSynthChain, createSamplerChain, createDrumChain } from '../../../src/audio/effects/fx-chain';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import { SYNC_LABELS, syncedValue } from '../../../src/utils/tempo';
import {
  makeMockAudioContext, installMockAudioWorkletNode, MockAudioWorkletNode, type MockAudioParam,
} from '../mock-audio-context';

/**
 * specs/features/flanger.md — the main-thread side: the wire before the DSP,
 * the lazy load and its failure, the drain, the tempo lock and the chain order.
 * The DSP itself is pinned by tests/audio/flanger-worklet.test.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// An effect boots bypassed, so its constructor arms a real disconnect timer;
// fake timers keep it inside the test. Promises still settle under them.
beforeEach(() => { vi.useFakeTimers(); installMockAudioWorkletNode(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Spy = ReturnType<typeof vi.fn>;
type MockNode = { connect: Spy; disconnect: Spy };

function bound(prefix = 'fx.flanger', addModule: Spy = vi.fn(async () => {})) {
  const ctx = makeMockAudioContext(48000);
  ctx.audioWorklet.addModule = addModule;
  const flanger = new Flanger(ctx as unknown as AudioContext);
  const wrap = (flanger as any).wrap as { processedIn: MockNode; processedOut: MockNode; setBypass(b: boolean): void };
  // The wrapper's own bypass: what the shell lets through, as opposed to what the switch asked.
  const wrapBypass = vi.spyOn(wrap, 'setBypass');
  const bus = new ParamBus();
  registerDefaults(bus);
  flanger.bind(bus, prefix);
  /** Switch it on and wait for the import, the module load and the splice. */
  const engage = async (): Promise<MockAudioWorkletNode | undefined> => {
    bus.set(`${prefix}.on`, 1);
    await flanger.ensureLive(bus, prefix);
    return flangerNodes()[0];
  };
  /** Whether the shell has ever let the wrapper un-bypass. */
  const unbypassed = (): boolean => wrapBypass.mock.calls.some(([b]) => b === false);
  return { ctx, flanger, wrap, bus, addModule, engage, unbypassed };
}

const flangerNodes = () => MockAudioWorkletNode.instances.filter((n) => n.workletName === 'flanger');
const param = (n: MockAudioWorkletNode, name: string) => n.parameters.get(name) as unknown as MockAudioParam;
/** The value a param was last told to take, scheduled or approached, by call order. */
function last(p: MockAudioParam): number {
  const calls = [p.setValueAtTime.mock, p.setTargetAtTime.mock].flatMap((m) =>
    m.calls.map((c, i) => ({ v: c[0] as number, order: m.invocationCallOrder[i]! })));
  calls.sort((a, b) => a.order - b.order);
  return calls.at(-1)?.v ?? NaN;
}

describe('an unloaded flanger stays bypassed (flanger.md REQ-an-unloaded-flanger-stays-bypassed)', () => {
  it('loads nothing and holds the bypass until the DSP is spliced in, then un-bypasses', async () => {
    const { bus, flanger, wrap, addModule, unbypassed } = bound();
    expect(addModule).not.toHaveBeenCalled();
    bus.set('fx.flanger.on', 1);
    // The switch is on, but the crossfade waits for the node.
    expect(unbypassed()).toBe(false);
    await flanger.ensureLive(bus, 'fx.flanger');
    const node = flangerNodes()[0]!;
    expect(wrap.processedIn.connect).toHaveBeenCalledWith(node);
    expect(node.connect).toHaveBeenCalledWith(wrap.processedOut);
    expect(unbypassed()).toBe(true);
    // Never a stand-in wire to swap out mid-fade.
    expect(wrap.processedIn.connect).not.toHaveBeenCalledWith(wrap.processedOut);
  });

  it('honours a switch-off that lands before the splice', async () => {
    const { bus, flanger, unbypassed } = bound();
    bus.set('fx.flanger.on', 1);
    bus.set('fx.flanger.on', 0);
    await flanger.ensureLive(bus, 'fx.flanger');
    expect(flangerNodes()).toHaveLength(1);
    expect(unbypassed()).toBe(false);
  });

  it('starts the node on the knobs as they stand', async () => {
    const { bus, engage } = bound();
    bus.set('fx.flanger.rate', 1.5);
    bus.set('fx.flanger.depth', 0.4);
    bus.set('fx.flanger.feedback', 0.6);
    const node = (await engage())!;
    // The first write lands at once, rather than ramping from the processor's defaults.
    expect(param(node, 'rate').setValueAtTime).toHaveBeenCalledWith(1.5, expect.any(Number));
    expect(param(node, 'depth').setValueAtTime).toHaveBeenCalledWith(0.4, expect.any(Number));
    expect(param(node, 'feedback').setValueAtTime).toHaveBeenCalledWith(0.6, expect.any(Number));
    // Later turns ramp.
    bus.set('fx.flanger.depth', 0.9);
    expect(param(node, 'depth').setTargetAtTime).toHaveBeenLastCalledWith(0.9, expect.any(Number), expect.any(Number));
  });

  it('leaves the channel count to the input: no outputChannelCount is pinned', async () => {
    const node = (await bound().engage())!;
    expect(node.options).not.toHaveProperty('outputChannelCount');
  });
});

describe('the flanger loads on first use (flanger.md REQ-the-flanger-loads-on-first-use)', () => {
  it('requests nothing until a flanger is on, then loads the worklet once for both buses', async () => {
    const ctx = makeMockAudioContext(48000);
    const addModule = vi.fn(async () => {});
    ctx.audioWorklet.addModule = addModule;
    const bus = new ParamBus();
    registerDefaults(bus);
    const synth = createSynthChain(ctx as unknown as AudioContext);
    const sampler = createSamplerChain(ctx as unknown as AudioContext);
    synth.bind(bus);
    sampler.bind(bus);
    expect(addModule).not.toHaveBeenCalled();

    bus.set('fx.flanger.on', 1);
    await synth.fx.flanger.ensureLive(bus, 'fx.flanger');
    bus.set('fx.sampler.flanger.on', 1);
    await sampler.fx.flanger.ensureLive(bus, 'fx.sampler.flanger');

    expect(addModule).toHaveBeenCalledTimes(1);
    expect(addModule).toHaveBeenCalledWith('/worklets/flanger.js');
    expect(flangerNodes()).toHaveLength(2);
  });

  it('a failed load stays bypassed, logs, throws into nobody, and the next switch-on retries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const addModule = vi.fn(async () => { if (fail) throw new Error('offline'); });
    const { bus, flanger, unbypassed } = bound('fx.flanger', addModule);
    expect(() => bus.set('fx.flanger.on', 1)).not.toThrow();
    await expect(flanger.ensureLive(bus, 'fx.flanger')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(flangerNodes()).toHaveLength(0);
    expect(unbypassed()).toBe(false);

    // The network is back: switching it on again works.
    fail = false;
    bus.set('fx.flanger.on', 0);
    bus.set('fx.flanger.on', 1);
    await flanger.ensureLive(bus, 'fx.flanger');
    expect(flangerNodes()).toHaveLength(1);
    expect(unbypassed()).toBe(true);
  });

  it('memoises the module per context', async () => {
    const ctx = makeMockAudioContext(48000);
    const addModule = vi.fn(async () => {});
    ctx.audioWorklet.addModule = addModule;
    await Promise.all([loadFlangerModule(ctx as unknown as AudioContext), loadFlangerModule(ctx as unknown as AudioContext)]);
    expect(addModule).toHaveBeenCalledTimes(1);
  });
});

describe('the drain (flanger.md REQ-the-flanger-drains-before-disconnect)', () => {
  it('pins feedback to 0 while quiesced and restores the knob after', async () => {
    const { bus, flanger, engage } = bound();
    bus.set('fx.flanger.feedback', 0.6);
    const fb = param((await engage())!, 'feedback');
    (flanger as any).quiesce(true);
    expect(last(fb)).toBe(0);
    // A knob turned mid-drain is remembered, not applied.
    bus.set('fx.flanger.feedback', 0.7);
    expect(last(fb)).toBe(0);
    (flanger as any).quiesce(false);
    expect(last(fb)).toBeCloseTo(0.7, 12);
    expect((flanger as any).drainSeconds()).toBe(0.05);
  });

  it('quiesces a flanger that attaches mid-drain', async () => {
    const { bus, flanger } = bound();
    (flanger as any).quiesce(true);
    bus.set('fx.flanger.on', 1);
    await flanger.ensureLive(bus, 'fx.flanger');
    expect(last(param(flangerNodes()[0]!, 'feedback'))).toBe(0);
  });
});

describe('the rate locks to the tempo (flanger.md REQ-the-flanger-rate-can-be-tempo-locked)', () => {
  it('runs at the division at the live tempo, leaving fx.flanger.rate untouched', async () => {
    const { bus, engage } = bound();
    const rate = param((await engage())!, 'rate');
    const div = SYNC_LABELS.indexOf('1/1');
    expect(div).toBeGreaterThan(0);
    bus.set('fx.flanger.sync', div);
    bus.set('transport.bpm', 90);
    expect(last(rate)).toBeCloseTo(syncedValue(div, 90, 'freq')!, 9);
    expect(bus.get('fx.flanger.rate')).toBe(0.2);
    bus.set('fx.flanger.sync', 0);
    expect(last(rate)).toBeCloseTo(0.2, 12);
  });
});

describe('chain position (flanger.md REQ-the-flanger-sits-between-phaser-and-chorus)', () => {
  it('wires phaser -> flanger -> chorus on the synth and sampler buses', () => {
    for (const make of [createSynthChain, createSamplerChain]) {
      const ctx = makeMockAudioContext(48000);
      const chain = make(ctx as unknown as AudioContext);
      const fx = chain.fx as Record<string, { input: AudioNode; output: MockNode }>;
      chain.wire(ctx.createGain() as unknown as AudioNode, ctx.createGain() as unknown as AudioNode);
      expect(fx.phaser!.output.connect).toHaveBeenCalledWith(fx.flanger!.input);
      expect(fx.flanger!.output.connect).toHaveBeenCalledWith(fx.chorus!.input);
    }
  });

  it('gives the drum bus no flanger', () => {
    const ctx = makeMockAudioContext(48000);
    expect('flanger' in createDrumChain(ctx as unknown as AudioContext).fx).toBe(false);
  });
});
