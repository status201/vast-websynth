// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Chorus, chorusSwing,
  CHORUS_CENTRE_S, CHORUS_SWING_S, CHORUS_MIN_DELAY_S,
} from '../../../src/audio/effects/chorus';
import { CHORUS_MODES, CHORUS_MODE_LABELS, chorusModePreset } from '../../../src/state/chorus';
import { createSynthChain, createSamplerChain, createDrumChain } from '../../../src/audio/effects/fx-chain';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import { makeMockAudioContext, type MockAudioParam } from '../mock-audio-context';

// An effect boots bypassed, so its constructor arms a real disconnect timer
// whose callback calls `window.setTimeout`; fake timers keep it inside the test.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

type Node = Record<string, unknown> & { connect: ReturnType<typeof vi.fn> };

function build() {
  const ctx = makeMockAudioContext(48000);
  const chorus = new Chorus(ctx as unknown as AudioContext);
  const results = (fn: ReturnType<typeof vi.fn>) => fn.mock.results.map((r) => r.value as Node);
  const [tapL, tapR] = results(ctx.createDelay) as Array<Node & { delayTime: MockAudioParam }>;
  const [lfo] = results(ctx.createOscillator) as Array<Node & { frequency: MockAudioParam; type: string }>;
  const [tone] = results(ctx.createBiquadFilter) as Array<Node & { type: string }>;
  // BypassWrapper builds six gains first; then the two swing gains.
  const [swingL, swingR] = results(ctx.createGain).slice(6) as Array<Node & { gain: MockAudioParam }>;
  const [merger] = results(ctx.createChannelMerger);
  return { ctx, chorus, tapL: tapL!, tapR: tapR!, lfo: lfo!, tone: tone!, swingL: swingL!, swingR: swingR!, merger: merger! };
}

/** The last value a gain was told to reach (setTargetAtTime), or its initial value. */
const target = (p: MockAudioParam): number =>
  (p.setTargetAtTime.mock.calls.at(-1)?.[0] as number | undefined) ?? p.value;

function bound(prefix = 'fx.chorus') {
  const b = build();
  const bus = new ParamBus();
  registerDefaults(bus);
  b.chorus.bind(bus, prefix);
  return { ...b, bus };
}

describe('Chorus graph (chorus.md REQ-the-chorus-is-two-antiphase-taps)', () => {
  it('reads one mono line with two taps, swept in antiphase by one triangle LFO', () => {
    const { tapL, tapR, lfo, tone, swingL, swingR, merger } = build();
    expect(lfo.type).toBe('triangle');
    expect(tone.type).toBe('lowpass');
    // The down-mix happens ahead of the taps, so they always run mono.
    expect(tone.channelCount).toBe(1);
    expect(tone.channelCountMode).toBe('explicit');
    expect(tapL.delayTime.value).toBe(CHORUS_CENTRE_S);
    expect(tapR.delayTime.value).toBe(CHORUS_CENTRE_S);
    expect(swingL.connect).toHaveBeenCalledWith(tapL.delayTime);
    expect(swingR.connect).toHaveBeenCalledWith(tapR.delayTime);
    expect(swingL.gain.value).toBeCloseTo(-swingR.gain.value, 12);
    expect(swingL.gain.value).toBeGreaterThan(0);
    // Left tap to the merger's channel 0, right to channel 1.
    expect(tapL.connect).toHaveBeenCalledWith(merger, 0, 0);
    expect(tapR.connect).toHaveBeenCalledWith(merger, 0, 1);
  });

  it('keeps the swing antiphase as depth moves', () => {
    const { chorus, swingL, swingR } = build();
    chorus.setDepth(0.8);
    expect(target(swingL.gain)).toBeCloseTo(chorusSwing(0.8), 12);
    expect(target(swingR.gain)).toBeCloseTo(-chorusSwing(0.8), 12);
  });
});

describe('the delay never reaches zero (chorus.md REQ-the-chorus-delay-never-reaches-zero)', () => {
  it('holds the shortest delay at or above the floor across the whole depth range', () => {
    for (let d = 0; d <= 1.0001; d += 0.01) {
      expect(CHORUS_CENTRE_S - chorusSwing(d)).toBeGreaterThanOrEqual(CHORUS_MIN_DELAY_S - 1e-12);
    }
    // Out-of-range input is clamped too, not extrapolated.
    expect(chorusSwing(5)).toBe(chorusSwing(1));
    expect(chorusSwing(-1)).toBe(0);
  });

  it('scales linearly with depth below the floor', () => {
    expect(chorusSwing(0.5)).toBeCloseTo(0.5 * CHORUS_SWING_S, 12);
  });
});

describe('MODE overrides RATE and DEPTH (chorus.md REQ-the-chorus-mode-overrides-rate-and-depth)', () => {
  it('is one table: FREE first with no preset, every other mode with one', () => {
    expect(CHORUS_MODE_LABELS).toEqual(CHORUS_MODES.map((m) => m.label));
    expect(CHORUS_MODE_LABELS[0]).toBe('FREE');
    expect(chorusModePreset(0)).toBeNull();
    for (let i = 1; i < CHORUS_MODES.length; i++) expect(chorusModePreset(i)).not.toBeNull();
    // An index from a newer build falls back to the knobs rather than throwing.
    expect(chorusModePreset(99)).toBeNull();
  });

  it('is what the mode param is registered over', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    expect(bus.def('fx.chorus.mode')?.labels).toEqual(CHORUS_MODE_LABELS);
  });

  it('applies the mode, leaves the knobs stored, and gives them back at FREE', () => {
    const { bus, lfo, swingL } = bound();
    bus.set('fx.chorus.rate', 3);
    bus.set('fx.chorus.depth', 0.9);
    expect(target(lfo.frequency)).toBe(3);

    bus.set('fx.chorus.mode', CHORUS_MODE_LABELS.indexOf('I'));
    const I = chorusModePreset(1)!;
    expect(target(lfo.frequency)).toBe(I.rate);
    expect(target(swingL.gain)).toBeCloseTo(chorusSwing(I.depth), 12);
    expect(bus.get('fx.chorus.rate')).toBe(3);
    expect(bus.get('fx.chorus.depth')).toBe(0.9);

    bus.set('fx.chorus.mode', 0);
    expect(target(lfo.frequency)).toBe(3);
    expect(target(swingL.gain)).toBeCloseTo(chorusSwing(0.9), 12);
  });

  it('ignores a knob turned while a mode is set (edge)', () => {
    const { bus, lfo, swingL } = bound();
    bus.set('fx.chorus.mode', CHORUS_MODE_LABELS.indexOf('II'));
    const II = chorusModePreset(2)!;
    bus.set('fx.chorus.rate', 7);
    bus.set('fx.chorus.depth', 0.1);
    expect(target(lfo.frequency)).toBe(II.rate);
    expect(target(swingL.gain)).toBeCloseTo(chorusSwing(II.depth), 12);
  });

  it('drives only setTargetAtTime — no cancels to anchor', () => {
    const { bus, lfo, swingL, swingR } = bound();
    bus.set('fx.chorus.mode', 3);
    bus.set('fx.chorus.mode', 0);
    for (const p of [lfo.frequency, swingL.gain, swingR.gain]) {
      expect(p.cancelScheduledValues).not.toHaveBeenCalled();
    }
  });
});

describe('chorus drain and bypass (chorus.md REQ-the-chorus-drains-briefly)', () => {
  it('declares a short drain', () => {
    const { chorus } = build();
    const c = chorus as unknown as { drainSeconds(): number };
    expect(c.drainSeconds()).toBe(0.05);
  });

  // Regression (ADR-012): the LFO was started once and ran through every bypass.
  it('stops its LFO while quiesced and starts a fresh one at the current rate on release', () => {
    const { chorus, ctx, lfo, swingL, swingR } = build();
    const c = chorus as unknown as { quiesce(on: boolean): void };
    chorus.setRate(2);
    c.quiesce(true);
    expect((lfo as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
    chorus.setRate(3); // turned while bypassed: kept for the next LFO
    c.quiesce(false);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    const next = ctx.createOscillator.mock.results[1]!.value as Node & { frequency: MockAudioParam; start: ReturnType<typeof vi.fn> };
    expect(next.frequency.value).toBe(3);
    expect(next.start).toHaveBeenCalled();
    expect(next.connect).toHaveBeenCalledWith(swingL);
    expect(next.connect).toHaveBeenCalledWith(swingR);
    c.quiesce(false); // a release with an LFO running starts no second one
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  });

  it('boots bypassed at the no-op default (chorus.md REQ-the-chorus-params-default-to-a-no-op)', () => {
    const { chorus, bus } = bound();
    const setBypass = vi.spyOn(chorus, 'setBypass');
    bus.set('fx.chorus.on', 1);
    bus.set('fx.chorus.on', 0);
    expect(setBypass).toHaveBeenLastCalledWith(true);
    expect(bus.get('fx.chorus.on')).toBe(0);
  });
});

describe('chain position (chorus.md REQ-the-chorus-sits-after-the-phaser)', () => {
  it('wires phaser -> flanger -> chorus -> delay on the synth and sampler buses', () => {
    for (const make of [createSynthChain, createSamplerChain]) {
      const ctx = makeMockAudioContext(48000);
      const chain = make(ctx as unknown as AudioContext);
      const fx = chain.fx as Record<string, { input: AudioNode; output: Node }>;
      chain.wire(ctx.createGain() as unknown as AudioNode, ctx.createGain() as unknown as AudioNode);
      expect(fx.phaser!.output.connect).toHaveBeenCalledWith(fx.flanger!.input);
      expect(fx.flanger!.output.connect).toHaveBeenCalledWith(fx.chorus!.input);
      expect(fx.chorus!.output.connect).toHaveBeenCalledWith(fx.delay!.input);
    }
  });

  it('gives the drum bus no chorus', () => {
    const ctx = makeMockAudioContext(48000);
    const chain = createDrumChain(ctx as unknown as AudioContext);
    expect('chorus' in chain.fx).toBe(false);
  });
});
