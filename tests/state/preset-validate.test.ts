import { describe, it, expect } from 'vitest';
import {
  validatePresetPayload, defaultPatchParams, expandPresetParams,
} from '../../src/state/preset-validate';
import { Presets } from '../../src/state/preset';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { isPatchParam } from '../../src/state/preset-session';

/**
 * preset-authoring.md — the two validation layers. Structural (no bus) is what
 * the app's file import may demand; semantic (with a bus) is the authoring
 * contract an agent iterates against.
 */

function bus() {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

const PRESET = (params: Record<string, number>) => ({
  format: 'websynth-preset', version: 1, name: 'Lead', params,
});

describe('structural layer (no bus)', () => {
  it('collapses a preset to a one-entry map and keeps a bank keyed by name', () => {
    const p = validatePresetPayload(PRESET({ 'filter.cutoff': 80 }));
    expect(p).toMatchObject({ ok: true, kind: 'preset', name: 'Lead' });

    const b = validatePresetPayload({
      format: 'websynth-preset-bank', version: 1, name: 'set',
      presets: { one: { 'filter.cutoff': 60 }, two: {} },
    });
    expect(b.ok && Object.keys(b.presets)).toEqual(['one', 'two']);
  });

  it('names the offending key when a value is not a number', () => {
    const res = validatePresetPayload({
      format: 'websynth-preset-bank', version: 1, name: 'set',
      presets: { one: { 'filter.cutoff': 'loud' } },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toContain('presets["one"]."filter.cutoff"');
  });

  // Forward compatibility: a file from a newer build may name params this one
  // has never heard of, and restore() ignores them — so the app must not refuse.
  it('accepts unknown parameter ids when no bus is given', () => {
    expect(validatePresetPayload(PRESET({ 'osc9.warp': 1 })).ok).toBe(true);
  });

  it('accepts out-of-range values when no bus is given', () => {
    expect(validatePresetPayload(PRESET({ 'filter.cutoff': 9999 })).ok).toBe(true);
  });
});

describe('semantic layer (with a bus)', () => {
  it('rejects a parameter this synth does not have', () => {
    const res = validatePresetPayload(PRESET({ 'osc1.shape': 1 }), bus());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toContain('is not a parameter of this synth');
  });

  it('rejects a value outside the registered range, quoting the range', () => {
    const res = validatePresetPayload(PRESET({ 'filter.resonance': 99 }), bus());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const def = bus().def('filter.resonance')!;
    expect(res.errors[0]).toContain(`${def.min}..${def.max}`);
  });

  // preset-authoring.md REQ-8 — the same findings, two severities. The MCP
  // tools want an author's file refused; the app's importer wants it to load,
  // because the bus clamps a range and ignores an unknown id.
  it('demotes the registry findings to warnings when the caller asks (REQ-8)', () => {
    const payload = PRESET({ 'osc1.shape': 1, 'filter.resonance': 99 });
    const res = validatePresetPayload(payload, bus(), { semantics: 'warning' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const warned = (res.warnings ?? []).join(' | ');
    expect(warned).toContain('is not a parameter of this synth');
    expect(warned).toContain('must be');
  });

  it('keeps them as errors by default, so the authoring contract is unmoved', () => {
    const payload = PRESET({ 'osc1.shape': 1, 'filter.resonance': 99 });
    for (const res of [
      validatePresetPayload(payload, bus()),
      validatePresetPayload(payload, bus(), {}),
      validatePresetPayload(payload, bus(), { semantics: 'error' }),
    ]) {
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.errors.join(' | ')).toContain('is not a parameter of this synth');
    }
  });

  it('a structural failure still fails under semantics warning', () => {
    // Severity moves the registry findings only — a non-numeric value is shape,
    // and shape alone decides `ok`.
    const bad = { 'filter.cutoff': 'x' } as unknown as Record<string, number>;
    const res = validatePresetPayload(PRESET(bad), bus(), { semantics: 'warning' });
    expect(res.ok).toBe(false);
  });

  it('accepts every pre-v2 lfo.dest index unchanged (lfo.md REQ-3)', () => {
    // The destination list is append-only: growing it to add `pan` must not
    // invalidate — or re-point — any index a saved patch already holds.
    const labels = bus().def('lfo.dest')!.labels!;
    expect(labels.slice(0, 5)).toEqual(['off', 'cutoff', 'pitch', 'amp', 'pulse']);
    for (let i = 0; i <= 4; i++) {
      expect(validatePresetPayload(PRESET({ 'lfo.dest': i }), bus()).ok).toBe(true);
    }
  });

  // Appending a destination must widen the accepted range by exactly one and
  // leave every older index meaning what it always meant (lfo.md REQ-3).
  it('accepts the pan and shape destinations and still rejects past them', () => {
    expect(validatePresetPayload(PRESET({ 'lfo.dest': 5 }), bus()).ok).toBe(true); // pan
    expect(validatePresetPayload(PRESET({ 'lfo.dest': 6 }), bus()).ok).toBe(true); // shape
    expect(validatePresetPayload(PRESET({ 'lfo.dest': 7 }), bus()).ok).toBe(false);
  });

  // Exclusivity is a UI affordance, not a data invariant (lfo.md REQ-12): a
  // hand-authored or MCP-authored file may put both LFOs anywhere, including
  // on the same destination, and must still load.
  it('range-checks lfo2.dest exactly like lfo.dest, and independently', () => {
    expect(validatePresetPayload(PRESET({ 'lfo2.dest': 6 }), bus()).ok).toBe(true);
    expect(validatePresetPayload(PRESET({ 'lfo2.dest': 7 }), bus()).ok).toBe(false);
    expect(validatePresetPayload(PRESET({ 'lfo.dest': 1, 'lfo2.dest': 1 }), bus()).ok).toBe(true);
  });

  it('rejects a fractional index on a choice parameter', () => {
    const res = validatePresetPayload(PRESET({ 'osc1.wave': 1.5 }), bus());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toContain('choice parameter');
    expect(res.errors[0]).toContain('0=sine');
  });

  it('warns (but does not fail) on a song-level id inside a sound', () => {
    const res = validatePresetPayload(PRESET({ 'transport.bpm': 140 }), bus());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings?.[0]).toContain('transport.bpm');
    expect(res.warnings?.[0]).toContain('not part of a sound');
  });

  it('a clean sound carries no warnings at all', () => {
    const res = validatePresetPayload(PRESET({ 'filter.cutoff': 80 }), bus());
    expect(res.ok && res.warnings).toBeUndefined();
  });

  // The strongest pin available: the shipped sounds must satisfy the contract
  // agents are asked to satisfy.
  it('every factory preset validates cleanly', () => {
    const b = bus();
    for (const [name, snap] of Object.entries(Presets.factory())) {
      const res = validatePresetPayload(PRESET(snap), b);
      expect(res.ok, `${name}: ${res.ok ? '' : res.errors.join('; ')}`).toBe(true);
      if (res.ok) expect(res.warnings, `${name} warnings`).toBeUndefined();
    }
  });
});

describe('expansion (REQ-4)', () => {
  it('defaults cover every patch param and nothing else', () => {
    const b = bus();
    const defaults = defaultPatchParams(b);
    for (const id of Object.keys(defaults)) expect(isPatchParam(id)).toBe(true);
    // …and every patch param the bus knows is present.
    for (const id of b.ids()) {
      if (isPatchParam(id)) expect(defaults[id]).toBe(b.def(id)!.default);
    }
  });

  it('authored values win over the defaults they fill in around', () => {
    const b = bus();
    const full = expandPresetParams(b, { 'filter.cutoff': 42 });
    expect(full['filter.cutoff']).toBe(42);
    expect(full['osc1.wave']).toBe(b.def('osc1.wave')!.default);
    // A sound never carries the song's tempo, even expanded.
    expect(full['transport.bpm']).toBeUndefined();
  });

  it('keeps an explicitly authored song-level id (the warning is the answer)', () => {
    const full = expandPresetParams(bus(), { 'transport.bpm': 128 });
    expect(full['transport.bpm']).toBe(128);
  });
});
