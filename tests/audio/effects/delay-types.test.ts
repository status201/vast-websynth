// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Delay } from '../../../src/audio/effects/delay';
import {
  pingPongWidth, pingPongGains, saturationCurve, ANALOG_VOICINGS,
} from '../../../src/audio/effects/delay-cores';
import { DELAY_SPILL_S } from '../../../src/audio/effects/delay-switch';
import { DISCONNECT_DELAY_MS } from '../../../src/audio/effects/effect';
import { DELAY_TYPE_LABELS, delayTypeOf } from '../../../src/state/delay';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import { eqStageCoeffs } from '../../../src/state/eq';
import {
  makeMockAudioContext, installMockAudioWorkletNode, MockAudioWorkletNode, type MockAudioParam,
} from '../mock-audio-context';

/**
 * specs/features/delay-types.md — the main-thread side: the type table, the
 * DIGITAL no-op, core switching with its spill and drain, the lazy load and its
 * failure, ping-pong's level and the analog loop's bound. The reverse DSP is
 * pinned by tests/audio/reverse-delay-worklet.test.ts; the sound by ear (ADR-010).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeEach(() => { vi.useFakeTimers(); installMockAudioWorkletNode(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Spy = ReturnType<typeof vi.fn>;
type Gate = { gain: MockAudioParam; connect: Spy; disconnect: Spy };
type Slot = { inGate: Gate; outGate: Gate; state: string; connected: boolean; core: any };

function bound(prefix = 'fx.delay', addModule: Spy = vi.fn(async () => {})) {
  const ctx = makeMockAudioContext(48000);
  ctx.audioWorklet.addModule = addModule;
  const delay = new Delay(ctx as unknown as AudioContext);
  const bus = new ParamBus();
  registerDefaults(bus);
  delay.bind(bus, prefix);
  /** The switch's slots, read live; empty while the delay is still DIGITAL alone. */
  const map = (): Map<string, Slot> => (delay as any).sw?.slots ?? new Map();
  const slots = {
    get: (t: string) => map().get(t),
    has: (t: string) => map().has(t),
    keys: () => map().keys(),
    values: () => map().values(),
  };
  const wrap = (delay as any).wrap as { processedIn: { connect: Spy; disconnect: Spy }; processedOut: unknown };
  /** Wait for the switch's import and any core load in flight to land. */
  const settle = async (): Promise<void> => {
    await (delay as any).loading;
    await Promise.all([...((delay as any).sw?.loading.values() ?? [])]);
  };
  /** Select a type by label and wait for any load. */
  const select = async (label: string): Promise<void> => {
    bus.set(`${prefix}.type`, DELAY_TYPE_LABELS.indexOf(label));
    await settle();
  };
  return { ctx, delay, bus, slots, wrap, select, settle, addModule };
}

/** A core's (first) feedback param, held by its HeldFeedback. */
const loopParam = (core: any): MockAudioParam => core.loop.params[0];

/** The last value a param was told to reach, by call order across both schedulers. */
function last(p: MockAudioParam): number {
  const calls = [p.setValueAtTime.mock, p.setTargetAtTime.mock].flatMap((m) =>
    m.calls.map((c, i) => ({ v: c[0] as number, order: m.invocationCallOrder[i]! })));
  calls.sort((a, b) => a.order - b.order);
  return calls.at(-1)?.v ?? p.value;
}

describe('the type table (REQ-the-delay-type-is-one-append-only-table)', () => {
  it('is append-only with DIGITAL first', () => {
    expect(DELAY_TYPE_LABELS).toEqual(['DIGITAL', 'PING PONG', 'TAPE', 'BBD', 'SPACE ECHO', 'REVERSE']);
  });

  it('resolves an unknown or non-finite index to digital, never throwing', () => {
    for (const v of [NaN, -1, 99, Infinity]) expect(delayTypeOf(v)).toBe('digital');
    expect(delayTypeOf(2)).toBe('tape');
    expect(delayTypeOf(4.6)).toBe('reverse');
  });
});

describe('DIGITAL is the unchanged delay (REQ-digital-is-the-unchanged-delay)', () => {
  it('defaults every bus to DIGITAL, CHAR 0.5', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    for (const p of ['fx.delay', 'fx.drum.delay', 'fx.sampler.delay']) {
      expect(bus.get(`${p}.type`)).toBe(0);
      expect(bus.get(`${p}.char`)).toBe(0.5);
    }
  });

  it('builds today\'s graph — one line, one lowpass, no gates — and loads no switch', async () => {
    const { ctx, delay, wrap, settle } = bound();
    await settle();
    expect(ctx.createDelay).toHaveBeenCalledTimes(1);
    expect(ctx.createBiquadFilter).toHaveBeenCalledTimes(1);
    expect(ctx.createWaveShaper).not.toHaveBeenCalled();
    // The wrapper's six gains and the feedback gain: nothing else.
    expect(ctx.createGain).toHaveBeenCalledTimes(7);
    expect((delay as any).sw).toBeNull();
    expect(wrap.processedIn.connect).toHaveBeenCalledWith((delay as any).delay);
  });

  it('splices the digital line through unity gates when the switch takes over', async () => {
    const { delay, slots, select, wrap } = bound();
    await select('TAPE');
    const d = slots.get('digital')!;
    expect(d.inGate.gain.value).toBe(1);
    expect(d.outGate.gain.value).toBe(1);
    expect(wrap.processedIn.disconnect).toHaveBeenCalledWith((delay as any).delay);
    expect(wrap.processedIn.connect).toHaveBeenCalledWith(d.inGate);
  });

  it('writes no AudioParam when CHAR moves at DIGITAL', () => {
    const { bus, ctx } = bound();
    const params = (fn: Spy) => fn.mock.results.map((r) => r.value as Record<string, MockAudioParam>);
    const all = [
      ...params(ctx.createDelay).map((n) => n.delayTime!),
      ...params(ctx.createGain).map((n) => n.gain!),
      ...params(ctx.createBiquadFilter).flatMap((n) => [n.frequency!, n.Q!]),
    ];
    const before = all.map((p) => p.setTargetAtTime.mock.calls.length + p.setValueAtTime.mock.calls.length);
    bus.set('fx.delay.char', 0.9);
    const after = all.map((p) => p.setTargetAtTime.mock.calls.length + p.setValueAtTime.mock.calls.length);
    expect(after).toEqual(before);
  });
});

describe('a type switch is click-free and spills (REQ-a-type-switch-is-click-free-and-spills)', () => {
  it('closes the old input, keeps its output, opens the new core, then retires the old', async () => {
    const { slots, select, wrap } = bound();
    await select('TAPE');
    const dig = slots.get('digital')!;
    const tape = slots.get('tape')!;
    expect(last(dig.inGate.gain)).toBe(0);
    expect(last(dig.outGate.gain)).toBe(1);
    expect(dig.state).toBe('spill');
    expect(tape.state).toBe('live');
    expect(last(tape.inGate.gain)).toBe(1);
    expect(last(tape.outGate.gain)).toBe(1);
    expect(wrap.processedIn.connect).toHaveBeenCalledWith(tape.inGate);

    vi.advanceTimersByTime(DELAY_SPILL_S * 1000);
    expect(last(dig.outGate.gain)).toBe(0);
    expect(dig.state).toBe('idle');
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS + 2000);
    expect(dig.connected).toBe(false);
    expect(wrap.processedIn.disconnect).toHaveBeenCalledWith(dig.inGate);
  });

  it('takes a still-spilling type back as it is, rebuilding nothing', async () => {
    const { ctx, slots, select } = bound();
    await select('TAPE');
    const built = ctx.createDelay.mock.calls.length;
    await select('DIGITAL');
    const dig = slots.get('digital')!;
    expect(dig.state).toBe('live');
    expect(dig.connected).toBe(true);
    expect(last(dig.inGate.gain)).toBe(1);
    expect(slots.get('tape')!.state).toBe('spill');
    // Back to TAPE: the core built the first time is reused.
    await select('TAPE');
    expect(ctx.createDelay.mock.calls.length).toBe(built);
  });

  // Regression: retire stepped the loop to 0 while the output gate was still
  // fading, so at a short TIME the cut reached the output while it was heard.
  it('zeroes a retiring core\'s loop only once its output gate has closed', async () => {
    const { bus, slots, select } = bound();
    bus.set('fx.delay.on', 1); // a bypassed delay keeps every loop pinned
    bus.set('fx.delay.time', 0.02);
    bus.set('fx.delay.feedback', 0.9);
    await select('TAPE');
    const fb = (slots.get('digital')!.core as any).loop.params[0] as MockAudioParam;
    vi.advanceTimersByTime(DELAY_SPILL_S * 1000);
    expect(last(fb)).toBe(0.9); // fading out, still ringing
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS);
    expect(last(fb)).toBe(0);
  });

  it('a bypass during that wait zeroes the loop at once', async () => {
    const { delay, bus, slots, select } = bound();
    bus.set('fx.delay.on', 1);
    bus.set('fx.delay.feedback', 0.9);
    await select('TAPE');
    vi.advanceTimersByTime(DELAY_SPILL_S * 1000);
    (delay as any).quiesce(true);
    expect(last((slots.get('digital')!.core as any).loop.params[0])).toBe(0);
  });

  // Regression: SPACE ECHO's spring loop was stepped back up to its gain when
  // the core was taken back mid-drain, while the tank still rang.
  it('a SPACE ECHO taken back mid-drain glides its spring loop back in', async () => {
    const { bus, slots, select } = bound();
    bus.set('fx.delay.on', 1);
    await select('SPACE ECHO');
    await select('DIGITAL');
    vi.advanceTimersByTime(DELAY_SPILL_S * 1000 + DISCONNECT_DELAY_MS);
    const spring = (slots.get('spaceecho')!.core as any).spring.loop.gain as MockAudioParam;
    expect(last(spring)).toBe(0);
    const steps = spring.setValueAtTime.mock.calls.length;
    await select('SPACE ECHO');
    expect(spring.setValueAtTime.mock.calls.length).toBe(steps);
    expect(spring.setTargetAtTime).toHaveBeenLastCalledWith(0.55, expect.any(Number), expect.any(Number));
  });

  it('seeds a newly live core with the knobs as they stand', async () => {
    const { bus, slots, select } = bound();
    bus.set('fx.delay.time', 0.5);
    bus.set('fx.delay.feedback', 0.7);
    await select('PING PONG');
    const pp = slots.get('pingpong')!.core;
    expect(last(pp.dL.delayTime)).toBe(0.5);
    expect(last(loopParam(pp))).toBe(0.7);
  });
});

describe('the other types load on first use (REQ-the-other-types-load-on-first-use)', () => {
  it('a failed reverse load logs, leaves no live core, throws into nobody, and retries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const addModule = vi.fn(async () => { if (fail) throw new Error('offline'); });
    const { bus, slots, select } = bound('fx.delay', addModule);
    await expect(select('REVERSE')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(slots.has('reverse')).toBe(false);
    expect([...slots.values()].some((s) => s.state === 'live')).toBe(false);

    fail = false;
    bus.set('fx.delay.type', 0);
    await select('REVERSE');
    expect(addModule).toHaveBeenCalledTimes(2);
    expect(addModule).toHaveBeenLastCalledWith('/worklets/reverse-delay.js');
    expect(slots.get('reverse')!.state).toBe('live');
    expect(MockAudioWorkletNode.instances.filter((n) => n.workletName === 'reverse-delay')).toHaveLength(1);
  });

  it('a type chosen and left while the switch loads is never built', async () => {
    const { bus, slots, settle } = bound();
    bus.set('fx.delay.type', 2); // TAPE
    bus.set('fx.delay.type', 3); // BBD, before the switch has landed
    await settle();
    expect(slots.has('tape')).toBe(false);
    expect(slots.get('bbd')?.state).toBe('live');
  });

  it('a reverse core chosen and left while its worklet loads is built idle, not live', async () => {
    const { bus, slots, select, settle } = bound();
    await select('TAPE');
    bus.set('fx.delay.type', 5); // REVERSE: the worklet starts loading
    bus.set('fx.delay.type', 3); // BBD, before it lands
    await settle();
    expect(slots.get('reverse')?.state).toBe('idle');
    expect(slots.get('reverse')?.connected).toBe(false);
    expect(slots.get('bbd')?.state).toBe('live');
  });

  it('a failed switch load logs, keeps DIGITAL, and the next choice retries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { delay, select } = bound();
    // Fail the import once by making the switch's constructor throw.
    const m = await import('../../../src/audio/effects/delay-switch');
    const spy = vi.spyOn(m, 'DelaySwitch').mockImplementationOnce(function () { throw new Error('offline'); });
    await select('TAPE');
    expect(warn).toHaveBeenCalledTimes(1);
    expect((delay as any).sw).toBeNull();
    spy.mockRestore();
    await select('BBD');
    expect((delay as any).sw).not.toBeNull();
  });

  it('switching the delay back on retries a failed load of the type it shows (regression)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bus, delay, settle } = bound();
    const m = await import('../../../src/audio/effects/delay-switch');
    const spy = vi.spyOn(m, 'DelaySwitch').mockImplementationOnce(function () { throw new Error('offline'); });
    bus.set('fx.delay.type', 2); // TAPE: the load fails
    await settle();
    expect((delay as any).sw).toBeNull();
    spy.mockRestore();
    // Re-picking TAPE is an equal write the bus ignores; the switch-on is what retries.
    bus.set('fx.delay.type', 2);
    await settle();
    expect((delay as any).sw).toBeNull();
    bus.set('fx.delay.on', 1);
    await settle();
    expect((delay as any).sw).not.toBeNull();
  });
});

describe('a new core lands on its knobs (REQ-a-type-switch-is-click-free-and-spills)', () => {
  it('writes the seed values at once, not as a glide from the nodes\' defaults (regression)', async () => {
    const { bus, slots, select } = bound();
    bus.set('fx.delay.time', 0.5);
    await select('TAPE');
    const core = slots.get('tape')!.core;
    expect(core.line.delayTime.value).toBe(0.5);
    expect(core.line.delayTime.setTargetAtTime).not.toHaveBeenCalled();
    // The wow depth is seconds of swing, never the GainNode default of 1.
    expect(core.wowGain.gain.value).toBeLessThan(0.01);
    // Awake now: a knob turn glides.
    bus.set('fx.delay.time', 0.4);
    expect(core.line.delayTime.setTargetAtTime).toHaveBeenLastCalledWith(0.4, expect.any(Number), expect.any(Number));
  });

  it('gives the analog line headroom over TIME for the swing (regression)', async () => {
    const { ctx, select } = bound();
    await select('TAPE');
    const maxes = ctx.createDelay.mock.calls.map((c) => c[0] as number);
    expect(Math.max(...maxes)).toBeGreaterThan(2);
  });

  it('runs the wow and flutter sines only while the core is connected (regression)', async () => {
    const { ctx, slots, select } = bound();
    await select('TAPE');
    const oscs = ctx.createOscillator.mock.results.map((r) => r.value as { start: Spy; stop: Spy });
    expect(oscs).toHaveLength(2);
    for (const o of oscs) expect(o.start).toHaveBeenCalled();
    await select('DIGITAL');
    vi.advanceTimersByTime(DELAY_SPILL_S * 1000 + 3000); // spill, retire, drain, disconnect
    expect(slots.get('tape')!.connected).toBe(false);
    for (const o of oscs) expect(o.stop).toHaveBeenCalled();
    // Taken back: fresh sines, since a stopped oscillator cannot restart.
    await select('TAPE');
    expect(ctx.createOscillator).toHaveBeenCalledTimes(4);
  });

  it('glides the loop back when a core is taken back mid-drain (regression)', async () => {
    const { bus, slots, select } = bound();
    bus.set('fx.delay.on', 1); // a bypassed delay keeps every loop pinned
    await select('TAPE');
    await select('DIGITAL');
    vi.advanceTimersByTime(DELAY_SPILL_S * 1000 + DISCONNECT_DELAY_MS); // TAPE retires: loop pinned, still connected
    const fb = loopParam(slots.get('tape')!.core);
    expect(fb.setValueAtTime).toHaveBeenLastCalledWith(0, expect.any(Number));
    const pins = fb.setValueAtTime.mock.calls.length;
    await select('TAPE');
    expect(fb.setValueAtTime.mock.calls.length).toBe(pins); // no step back up
    expect(last(fb)).toBe(0.4);
    expect(fb.setTargetAtTime).toHaveBeenLastCalledWith(0.4, expect.any(Number), expect.any(Number));
  });
});

describe('ping-pong keeps the digital level (REQ-ping-pong-keeps-the-digital-level)', () => {
  it('carries DIGITAL\'s echo power at any width, and leans the first repeat left', async () => {
    const { bus, slots, select } = bound();
    await select('PING PONG');
    const pp = slots.get('pingpong')!.core;
    for (const c of [0, 0.25, 0.5, 1]) {
      bus.set('fx.delay.char', c);
      for (let ch = 0; ch < 2; ch++) {
        // DIGITAL's mono echo up-mixes to L = R = x: a power of 2x² per repeat.
        expect(last(pp.near[ch].gain) ** 2 + last(pp.far[ch].gain) ** 2).toBeCloseTo(2, 12);
      }
      expect(last(pp.near[0].gain)).toBeGreaterThan(last(pp.far[1].gain));
    }
    expect(pingPongGains(1)[1]).toBeCloseTo(0, 12); // hard to one side
    expect(pingPongWidth(0)).toBeGreaterThan(0);
  });
});

describe('every type is bounded (REQ-every-type-is-bounded)', () => {
  it('the analog saturator has slope 1 at the origin and never exceeds 1', () => {
    for (const v of Object.values(ANALOG_VOICINGS)) {
      for (const k of [v.drive[0], v.drive[1]]) {
        const c = saturationCurve(k);
        const mid = (c.length - 1) / 2;
        const slope = (c[Math.ceil(mid)]! - c[Math.floor(mid)]!) / (2 / (c.length - 1));
        expect(slope).toBeCloseTo(1, 2);
        for (const y of c) expect(Math.abs(y)).toBeLessThanOrEqual(1);
      }
    }
  });

  // Regression: the loop filters were written with Q 0.707 / 0.6 / 0.5, which
  // Web Audio reads in dB, a resonant bump of up to ×1.22 per filter. At FB
  // 0.95 DIGITAL and PING PONG then grew without bound.
  it('no loop filter boosts any frequency, so FB 0.95 decays', async () => {
    const { ctx, select } = bound();
    for (const label of DELAY_TYPE_LABELS.filter((l) => l !== 'REVERSE')) await select(label);
    const filters = ctx.createBiquadFilter.mock.results
      .map((r) => r.value as { type: BiquadFilterType; frequency: MockAudioParam; Q: MockAudioParam })
      .filter((f) => f.type === 'lowpass' || f.type === 'highpass');
    // DIGITAL's damp, PING PONG's two, TAPE's 2, BBD's 3, SPACE ECHO's 2 + the spring's.
    expect(filters.length).toBe(11);
    for (const f of filters) {
      const [b0, b1, b2, a0, a1, a2] = eqStageCoeffs(f.type, f.frequency.value, f.Q.value, 0, 48000);
      let peak = 0;
      for (let hz = 10; hz < 24000; hz *= 1.01) {
        const w = (2 * Math.PI * hz) / 48000;
        const num = Math.hypot(b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), b1 * Math.sin(w) + b2 * Math.sin(2 * w));
        const den = Math.hypot(a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), a1 * Math.sin(w) + a2 * Math.sin(2 * w));
        peak = Math.max(peak, num / den);
      }
      expect(peak, `${f.type} at ${f.frequency.value} Hz, Q ${f.Q.value}`).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('clamps feedback to 0.95 on every type', async () => {
    const { bus, slots, select } = bound();
    bus.set('fx.delay.feedback', 0.95);
    await select('TAPE');
    expect(last(loopParam(slots.get('tape')!.core))).toBeLessThanOrEqual(0.95);
  });
});

describe('the delay drains every live core (REQ-the-delay-drains-every-live-core)', () => {
  it('quiesces the reverse core and covers its buffer in drainSeconds', async () => {
    const { delay, slots, select } = bound();
    await select('REVERSE');
    vi.advanceTimersByTime(DELAY_SPILL_S * 1000 + 3000); // the digital spill retires
    const rev = slots.get('reverse')!;
    const fb = loopParam(rev.core);
    (delay as any).quiesce(true);
    expect(fb.setValueAtTime).toHaveBeenLastCalledWith(0, expect.any(Number));
    expect((delay as any).drainSeconds()).toBeGreaterThanOrEqual(4);
    (delay as any).quiesce(false);
    expect(last(fb)).toBe(0.4); // restored by a glide, from the pinned 0
  });

  it('a bypass retires a spilling core at once', async () => {
    const { delay, slots, select } = bound();
    await select('TAPE');
    expect(slots.get('digital')!.state).toBe('spill');
    (delay as any).quiesce(true);
    expect(slots.get('digital')!.state).toBe('idle');
  });
});
