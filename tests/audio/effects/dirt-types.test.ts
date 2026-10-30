// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Dirt } from '../../../src/audio/effects/dirt';
import { TYPE_DIP_S, TYPE_SWAP_MS } from '../../../src/audio/effects/dirt-switch';
import * as voicings from '../../../src/audio/effects/dirt-voicings';
import { dirtCurve } from '../../../src/audio/effects/dirt-voicings';
import { DISCONNECT_DELAY_MS } from '../../../src/audio/effects/effect';
import { DIRT_TYPES, DIRT_TYPE_LABELS, dirtTypeOf } from '../../../src/state/dirt';
import { DRIVE_CURVE_STEPS } from '../../../src/audio/drive-curve';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import { makeMockAudioContext, type MockAudioParam } from '../mock-audio-context';

/**
 * specs/features/dirt-types.md — the type table, the unchanged DISTORTION
 * graph, each voicing's wiring, the click-free swap (`DirtSwitch`, loaded on the
 * first other type), the failed load and the curves' bound. The
 * sound itself is verified by ear (REQ-every-dirt-type-is-heard, ADR-010).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

type Spy = ReturnType<typeof vi.fn>;
type Node = { connect: Spy; disconnect: Spy; type?: string; frequency?: MockAudioParam; gain?: MockAudioParam };

function bound(on: 0 | 1 = 1, Ctor: typeof Dirt = Dirt) {
  const ctx = makeMockAudioContext(48000);
  const dist = new Ctor(ctx as unknown as AudioContext);
  const bus = new ParamBus();
  registerDefaults(bus);
  bus.set('fx.dist.on', on);
  dist.bind(bus, 'fx.dist');
  // Past the wrapper's boot disconnect: a bypassed effect has quiesced by now.
  vi.advanceTimersByTime(DISCONNECT_DELAY_MS + 100);
  const d = dist as any;
  const nodes = {
    preGain: d.nodes.preGain as Node & { gain: MockAudioParam },
    shaper: d.nodes.shaper as Node & { curve: Float32Array },
    tone: d.nodes.tone as Node,
    postGain: d.nodes.postGain as Node & { gain: MockAudioParam },
  };
  const pool = () => (d.sw?.router?.pool ?? null) as { pre: Node[]; post: Node[] } | null;
  /** Let the switch's import land, then the dip run out. */
  const settle = async (): Promise<void> => {
    await d.loading;
    vi.advanceTimersByTime(TYPE_SWAP_MS);
    await d.loading;
  };
  /** Set TYPE and let the swap land. */
  const pick = async (type: number): Promise<void> => {
    bus.set('fx.dist.type', type);
    await settle();
  };
  return { ctx, dist, bus, nodes, pool, settle, pick };
}

/** What each node was last connected to, following the series from preGain to tone. */
function series(n: ReturnType<typeof bound>['nodes']): Node[] {
  const out: Node[] = [n.preGain];
  let at: Node = n.preGain;
  while (at !== n.tone) {
    const next = at.connect.mock.lastCall?.[0] as Node | undefined;
    if (!next || out.includes(next)) throw new Error('series broken');
    out.push(next);
    at = next;
  }
  return out;
}

describe('the type table (REQ-the-dirt-type-is-one-append-only-table)', () => {
  it('is DISTORTION · OVERDRIVE · FUZZ, index 0 the original', () => {
    expect(DIRT_TYPE_LABELS).toEqual(['DISTORTION', 'OVERDRIVE', 'FUZZ']);
    expect(DIRT_TYPES.map((t) => t[0])).toEqual(['distortion', 'overdrive', 'fuzz']);
  });

  it('resolves a bad stored value to DISTORTION', () => {
    for (const v of [NaN, -1, 99, Infinity, -Infinity]) expect(dirtTypeOf(v)).toBe('distortion');
    expect(dirtTypeOf(1)).toBe('overdrive');
    expect(dirtTypeOf(2.2)).toBe('fuzz');
  });

  it('registers fx.dist.type and fx.sampler.dist.type, discrete, default 0', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    for (const id of ['fx.dist.type', 'fx.sampler.dist.type']) {
      expect(bus.get(id)).toBe(0);
      bus.set(id, 7);
      expect(bus.get(id)).toBe(2);
    }
  });
});

describe('DISTORTION is the unchanged Dirt (REQ-distortion-is-the-unchanged-dirt)', () => {
  it('wires preGain → shaper → tone and builds no pool', () => {
    const { ctx, nodes, pool } = bound();
    expect(series(nodes)).toEqual([nodes.preGain, nodes.shaper, nodes.tone]);
    expect(pool()).toBeNull();
    expect(ctx.createBiquadFilter).toHaveBeenCalledTimes(1); // the tone alone
  });

  it('keeps the original gain laws and tanh table', () => {
    const { dist, nodes } = bound();
    nodes.preGain.gain.setTargetAtTime.mockClear();
    nodes.postGain.gain.setTargetAtTime.mockClear();
    dist.setDrive(0.5);
    expect(nodes.preGain.gain.setTargetAtTime.mock.lastCall?.[0]).toBe(1 + 0.5 * 8);
    expect(nodes.postGain.gain.setTargetAtTime.mock.lastCall?.[0]).toBe(1 / (1 + 0.5 * 1.5));
    const curve = nodes.shaper.curve;
    expect(curve).toBe(dirtCurve('distortion', 0.5));
    const k = 1 + (Math.round(0.5 * (DRIVE_CURVE_STEPS - 1)) / (DRIVE_CURVE_STEPS - 1)) * 50;
    expect(curve[curve.length - 1]).toBeCloseTo(1, 6);
    expect(curve[300]).toBeCloseTo(Math.tanh(k * ((300 / 2047) * 2 - 1)) / Math.tanh(k), 6);
  });
});

describe('each type wires exactly its voicing (REQ-every-type-is-one-voicing)', () => {
  it('OVERDRIVE, FUZZ, then DISTORTION again', async () => {
    const { nodes, pool, pick } = bound();

    await pick(1);
    const p = pool()!;
    expect(series(nodes)).toEqual([nodes.preGain, p.pre[0], nodes.shaper, p.post[0], p.post[1], nodes.tone]);
    expect([p.pre[0]!.type, p.post[0]!.type, p.post[1]!.type]).toEqual(['lowshelf', 'highpass', 'lowshelf']);

    await pick(2);
    expect(series(nodes)).toEqual([nodes.preGain, nodes.shaper, p.post[0], p.post[1], nodes.tone]);
    expect([p.post[0]!.type, p.post[1]!.type]).toEqual(['highpass', 'peaking']);

    await pick(0);
    expect(series(nodes)).toEqual([nodes.preGain, nodes.shaper, nodes.tone]);
    expect(nodes.shaper.curve).toBe(dirtCurve('distortion', 0.3));
  });

  it('leaves every unused pool node disconnected', async () => {
    const { pool, pick } = bound();
    await pick(1);
    const pre = pool()!.pre[0]!;
    pre.connect.mockClear();
    pre.disconnect.mockClear();
    await pick(2);
    expect(pre.disconnect).toHaveBeenCalled();
    expect(pre.connect).not.toHaveBeenCalled();
  });
});

describe('every curve is bounded (REQ-every-dirt-type-is-bounded)', () => {
  it.each(DIRT_TYPES.map((t) => t[0]))('%s: max |y| = 1 and f(0) = 0 at every bucket', (type) => {
    for (let b = 0; b < DRIVE_CURVE_STEPS; b++) {
      const curve = dirtCurve(type, b / (DRIVE_CURVE_STEPS - 1));
      // One assertion per bucket, not per tap: 64 × 2048 expects starve under a full run.
      let peak = 0;
      let finite = true;
      for (const y of curve) {
        if (!Number.isFinite(y)) finite = false;
        peak = Math.max(peak, Math.abs(y));
      }
      expect(finite).toBe(true);
      expect(peak).toBeCloseTo(1, 6);
      // 2048 taps straddle 0: the two centre taps average to the curve at 0.
      const mid = curve.length / 2;
      expect(Math.abs((curve[mid - 1]! + curve[mid]!) / 2)).toBeLessThan(2e-3);
    }
  });
});

describe('a type switch is click-free (REQ-a-dirt-type-switch-is-click-free)', () => {
  it('a live switch dips first, then swaps and glides back', async () => {
    const { bus, dist, nodes, pool, settle } = bound(1);
    nodes.postGain.gain.setTargetAtTime.mockClear();
    bus.set('fx.dist.type', 1);
    await (dist as any).loading;
    expect(nodes.postGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, TYPE_DIP_S);
    expect(pool()).toBeNull();
    await settle();
    expect(pool()).not.toBeNull();
    expect(nodes.postGain.gain.setTargetAtTime.mock.lastCall?.[0]).toBeCloseTo(0.65, 9);
    expect(nodes.preGain.gain.setTargetAtTime.mock.lastCall?.[0]).toBeCloseTo((5 * Math.pow(20, 0.3)) / (3 + 0.3 * 3), 9);
  });

  it('a rapid flip swaps once, to the last value', async () => {
    const { bus, nodes, pool, settle } = bound(1);
    const route = vi.spyOn(voicings.VoicingRouter.prototype, 'route');
    bus.set('fx.dist.type', 1);
    vi.advanceTimersByTime(TYPE_SWAP_MS / 2);
    bus.set('fx.dist.type', 2);
    await settle();
    expect(route).toHaveBeenCalledTimes(1);
    expect(series(nodes)).toEqual([nodes.preGain, nodes.shaper, pool()!.post[0], pool()!.post[1], nodes.tone]);
  });

  it('a flip back before the swap wires nothing', async () => {
    const { bus, pool, settle } = bound(1);
    bus.set('fx.dist.type', 1);
    bus.set('fx.dist.type', 0);
    await settle();
    expect(pool()).toBeNull();
  });

  it('a DRIVE move during the dip keeps the wet down until the swap', async () => {
    const { bus, dist, nodes, settle } = bound(1);
    bus.set('fx.dist.type', 1);
    await (dist as any).loading;
    nodes.postGain.gain.setTargetAtTime.mockClear();
    bus.set('fx.dist.drive', 0.8);
    expect(nodes.postGain.gain.setTargetAtTime).not.toHaveBeenCalled();
    await settle();
    expect(nodes.postGain.gain.setTargetAtTime.mock.lastCall?.[0]).toBeCloseTo(0.65, 9);
    expect(nodes.shaper.curve).toBe(dirtCurve('overdrive', 0.8));
  });

  it('a quiesced (bypassed) effect swaps once the voicing is in, without a dip', async () => {
    const { bus, dist, nodes, pool } = bound(0);
    nodes.postGain.gain.setTargetAtTime.mockClear();
    bus.set('fx.dist.type', 2);
    await (dist as any).loading;
    expect(pool()).not.toBeNull();
    expect(nodes.shaper.curve).toBe(dirtCurve('fuzz', 0.3));
    for (const call of nodes.postGain.gain.setTargetAtTime.mock.calls) expect(call[0]).not.toBe(0);
  });
});

describe('the other types load on first use (REQ-the-other-dirt-types-load-on-first-use)', () => {
  it('a failed load logs, stays DISTORTION untouched, and switching on retries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A fresh module graph, so the shared import cache starts empty, with the switch's import failing.
    vi.resetModules();
    vi.doMock('../../../src/audio/effects/dirt-switch', () => { throw new Error('offline'); });
    const fresh = await import('../../../src/audio/effects/dirt');
    const { dist, bus, nodes, pool, settle } = bound(1, fresh.Dirt);
    bus.set('fx.dist.type', 1);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(pool()).toBeNull();
    expect(series(nodes)).toEqual([nodes.preGain, nodes.shaper, nodes.tone]);
    expect(nodes.postGain.gain.setTargetAtTime.mock.lastCall?.[0]).toBeCloseTo(1 / (1 + 0.3 * 1.5), 9);
    vi.doUnmock('../../../src/audio/effects/dirt-switch');
    // Re-picking OVERDRIVE is an equal write the bus ignores; the switch-on is what retries.
    bus.set('fx.dist.on', 0);
    bus.set('fx.dist.on', 1);
    await settle();
    expect(pool()).not.toBeNull();
    expect((dist as any).sw.type).toBe('overdrive');
  });
});
