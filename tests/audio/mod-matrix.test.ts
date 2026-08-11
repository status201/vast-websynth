import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModMatrix } from '../../src/audio/mod-matrix';
import { MOD_SRC, MOD_DST, MOD_ROWS, blockedDests, isPerVoiceSource } from '../../src/state/mod-routing';
import { makeMockAudioContext, makeParam } from './mock-audio-context';

/**
 * specs/features/mod-matrix.md — the routing engine.
 *
 * The matrix is deliberately a *graph* concern (ADR-017), so these assert wiring and
 * gain, not sample values: what a route sounds like is Web Audio's own summation, and
 * whether it is musical is a listening job.
 */

/** A voice stub carrying only what `voiceTargets` / `voiceSource` reach for. */
function makeVoice() {
  const node = () => ({ connect: vi.fn((t: unknown) => t), disconnect: vi.fn() });
  return {
    filter: {
      cutoffNote: makeParam(90), resonance: makeParam(0),
      shape: makeParam(0), drive: makeParam(1),
    },
    osc1: { detuneParam: makeParam(0) },
    osc2: { detuneParam: makeParam(0) },
    sub: { detuneParam: makeParam(0) },
    tremolo: { gain: makeParam(1) },
    filEnv: { out: node() },
    ampEnv: { out: node() },
    velocitySource: node(),
    keySource: node(),
  };
}

function build(voiceCount = 2) {
  const ctx = makeMockAudioContext();
  const src = () => ({ connect: vi.fn((t: unknown) => t), disconnect: vi.fn() });
  const sources = { lfo1: src(), lfo2: src(), modWheel: src(), random: src() };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const m = new ModMatrix(ctx as any, sources as any);
  const pan = makeParam(0);
  m.setPanTarget(pan as any);
  const voices = Array.from({ length: voiceCount }, makeVoice);
  for (const v of voices) m.connectVoice(v as any);
  return { m, ctx, sources, voices, pan };
}

/** Route a row and run out the re-patch mute timer. */
function route(m: ModMatrix, row: number, src: number, dst: number, amt: number): void {
  m.setSource(row, src);
  m.setDest(row, dst);
  m.setAmount(row, amt);
  vi.advanceTimersByTime(100);
}

/** The last gain value the matrix ramped a chain to, via setTargetAtTime. */
function lastRamp(param: { setTargetAtTime: ReturnType<typeof vi.fn> }): number | undefined {
  const calls = param.setTargetAtTime.mock.calls;
  return calls.length ? (calls[calls.length - 1]![0] as number) : undefined;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ModMatrix defaults (REQ-3)', () => {
  it('wires nothing at all while every row is off', () => {
    const { sources, voices } = build();
    // Not one connection: the no-op default has to be a true no-op, or every
    // preset that predates the matrix would change.
    expect(sources.lfo1.connect).not.toHaveBeenCalled();
    expect(voices[0]!.filEnv.out.connect).not.toHaveBeenCalled();
  });

  it('exposes exactly six free rows, LFO 1/2 being rows 0-1 (REQ-2)', () => {
    expect(MOD_ROWS).toBe(6);
  });
});

describe('ModMatrix routing (REQ-1)', () => {
  it('connects a global source to every voice of a per-voice destination', () => {
    const { m, sources, voices } = build();
    route(m, 0, MOD_SRC.lfo1, MOD_DST.cutoff, 1);
    // One gain per voice, so all 8 voices sweep — the fan-out idiom the LFO uses.
    expect(sources.lfo1.connect).toHaveBeenCalledTimes(voices.length);
  });

  it('drives all three oscillators from one pitch route', () => {
    const { m, voices } = build(1);
    route(m, 0, MOD_SRC.lfo1, MOD_DST.pitch, 1);
    const v = voices[0]!;
    // "pitch" means the voice's pitch, not one oscillator's.
    for (const o of [v.osc1, v.osc2, v.sub]) expect(o.detuneParam).toBeTruthy();
  });

  it('reaches resonance — an a-rate param nothing could address before (REQ-6)', () => {
    const { m, voices } = build(1);
    route(m, 0, MOD_SRC.lfo1, MOD_DST.resonance, 1);
    expect(voices[0]!.filter.resonance).toBeTruthy();
  });

  it('scales depth into the destination own unit (REQ-8)', () => {
    const { m, ctx } = build(1);
    const gains = ctx.createGain.mock.results.map((r) => r.value);
    route(m, 0, MOD_SRC.lfo1, MOD_DST.cutoff, 0.5);
    // 0.5 x 48 semitones. ADR-005: cutoff modulators emit semitones, never Hz.
    const ramped = gains.map((g) => lastRamp(g.gain)).filter((v) => v === 24);
    expect(ramped.length).toBeGreaterThan(0);
  });

  it('is bipolar, so a negative amount inverts the route (REQ-9)', () => {
    const { m, ctx } = build(1);
    const gains = ctx.createGain.mock.results.map((r) => r.value);
    route(m, 0, MOD_SRC.lfo1, MOD_DST.cutoff, -0.5);
    expect(gains.map((g) => lastRamp(g.gain))).toContain(-24);
  });

  it('mutes before it rewires, and only rewires after the ramp (REQ-1)', () => {
    const { m, sources } = build(1);
    route(m, 0, MOD_SRC.lfo1, MOD_DST.cutoff, 1);
    sources.lfo2.connect.mockClear();

    m.setSource(0, MOD_SRC.lfo2);
    // Nothing is touched yet — the gain is still ramping down.
    expect(sources.lfo2.connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(sources.lfo2.connect).toHaveBeenCalled();
  });

  it('settles on the last of two changes inside the mute window (REQ-1, edge)', () => {
    const { m, sources } = build(1);
    route(m, 0, MOD_SRC.lfo1, MOD_DST.cutoff, 1);
    sources.lfo2.connect.mockClear();
    sources.random.connect.mockClear();

    m.setSource(0, MOD_SRC.lfo2);
    vi.advanceTimersByTime(10);       // still inside the ramp
    m.setSource(0, MOD_SRC.random);
    vi.advanceTimersByTime(100);

    // The superseded change must not have wired itself in as well.
    expect(sources.lfo2.connect).not.toHaveBeenCalled();
    expect(sources.random.connect).toHaveBeenCalled();
  });

  it('takes a route down again when its source returns to off', () => {
    const { m, ctx } = build(1);
    route(m, 0, MOD_SRC.lfo1, MOD_DST.cutoff, 1);
    const gains = ctx.createGain.mock.results.map((r) => r.value);
    route(m, 0, MOD_SRC.off, MOD_DST.cutoff, 1);
    expect(gains.every((g) => (lastRamp(g.gain) ?? 0) === 0)).toBe(true);
  });
});

describe('ModMatrix per-voice sources (REQ-7)', () => {
  it('takes a per-voice source from each voice, not from a shared node', () => {
    const { m, voices } = build(2);
    route(m, 0, MOD_SRC.filEnv, MOD_DST.cutoff, 1);
    // Each voice's own envelope drives its own filter — that is what makes the
    // sweep polyphonic rather than one envelope smeared across the pool.
    for (const v of voices) expect(v.filEnv.out.connect).toHaveBeenCalledTimes(1);
  });

  it('refuses a per-voice source into a bus-wide destination', () => {
    const { m, voices, sources } = build(2);
    route(m, 0, MOD_SRC.ampEnv, MOD_DST.pan, 1);
    // Eight envelopes into one panner is mush. The UI greys it; this is the audio
    // layer refusing even if it slips past.
    for (const v of voices) expect(v.ampEnv.out.connect).not.toHaveBeenCalled();
    expect(sources.lfo1.connect).not.toHaveBeenCalled();
  });

  it('holds that route at zero gain, so it cannot leak', () => {
    const { m, ctx } = build(1);
    route(m, 0, MOD_SRC.velocity, MOD_DST.pan, 1);
    const gains = ctx.createGain.mock.results.map((r) => r.value);
    expect(gains.every((g) => (lastRamp(g.gain) ?? 0) === 0)).toBe(true);
  });

  it('still allows a GLOBAL source into the bus-wide destination', () => {
    const { m, sources } = build(2);
    route(m, 0, MOD_SRC.lfo1, MOD_DST.pan, 1);
    // One chain for the whole synth, not one per voice.
    expect(sources.lfo1.connect).toHaveBeenCalledTimes(1);
  });
});

describe('the routing rule is pure and shared (REQ-7)', () => {
  it('names exactly the per-voice sources', () => {
    for (const s of [MOD_SRC.filEnv, MOD_SRC.ampEnv, MOD_SRC.velocity, MOD_SRC.key]) {
      expect(isPerVoiceSource(s), String(s)).toBe(true);
    }
    for (const s of [MOD_SRC.off, MOD_SRC.lfo1, MOD_SRC.lfo2, MOD_SRC.modWheel, MOD_SRC.random]) {
      expect(isPerVoiceSource(s), String(s)).toBe(false);
    }
  });

  it('blocks pan for a per-voice source and nothing for a global one', () => {
    expect(blockedDests(MOD_SRC.filEnv)).toEqual([MOD_DST.pan]);
    expect(blockedDests(MOD_SRC.lfo1)).toEqual([]);
    expect(blockedDests(MOD_SRC.off)).toEqual([]);
  });
});
