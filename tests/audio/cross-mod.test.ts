// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Voice } from '../../src/audio/voice';
import { RING_MAKEUP, RING_HP_HZ, RING_HP_Q_DB } from '../../src/audio/cross-mod';
import { DISCONNECT_DELAY_MS } from '../../src/audio/effects/effect';
import { midiToHz } from '../../src/utils/math';
import { makeMockAudioContext, installMockAudioWorkletNode, type MockAudioParam } from './mock-audio-context';

/**
 * specs/features/cross-modulation.md — the voice side: what is wired, when, and
 * at what depth. The mock graph has no sound, so these assert the wiring and the
 * ramps; whether FM and ring sound musical is a listening job (ADR-010).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Spy = ReturnType<typeof vi.fn>;
interface MockNode { connect: Spy; disconnect: Spy; gain: MockAudioParam; offset: MockAudioParam }

beforeEach(() => {
  vi.useFakeTimers();
  installMockAudioWorkletNode();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function build() {
  const ctx = makeMockAudioContext();
  const voice = await Voice.create(ctx as unknown as AudioContext);
  const x = (voice as any).xmod;
  const n = (name: string) => x[name] as MockNode;
  return {
    ctx, voice,
    fmHz: n('fmHz'), fmMod: n('fmMod'), fmAmt: n('fmAmt'), kGain: n('kGain'), hzSrc: n('hzSrc'),
    ringVCA: n('ringVCA'), ringHP: x.ringHP, ringLevel: n('ringLevel'),
    osc1Signal: voice.osc1.signal as unknown as MockNode,
    osc2Signal: voice.osc2.signal as unknown as MockNode,
    osc2Freq: voice.osc2.frequencyParam,
  };
}

const lastTarget = (p: MockAudioParam) => p.setTargetAtTime.mock.calls.at(-1)?.[0];

describe('cross-mod off is the native path (REQ-cross-mod-off-is-the-native-path)', () => {
  it('a fresh voice drives nothing into osc2\'s frequency and feeds the ring nothing', async () => {
    const { fmHz, osc2Freq, osc1Signal, osc2Signal, ringVCA, ringLevel, voice } = await build();
    expect(fmHz.connect).not.toHaveBeenCalledWith(osc2Freq);
    expect(osc1Signal.connect).not.toHaveBeenCalledWith(ringVCA.gain);
    expect(osc2Signal.connect).not.toHaveBeenCalledWith(ringVCA);
    expect(ringLevel.connect).not.toHaveBeenCalledWith(voice.mix);
  });

  it('the taps sit between each oscillator and its LEVEL (REQ-oscillator-signals-are-tapped-pre-level)', async () => {
    const { voice, osc1Signal } = await build();
    expect(osc1Signal.connect).toHaveBeenCalledWith(voice.osc1.out);
    expect((voice.osc1 as any).fade.connect).toHaveBeenCalledWith(voice.osc1.signal);
    expect((voice.osc1 as any).fade.connect).not.toHaveBeenCalledWith(voice.osc1.out);
  });
});

describe('FM engages only while in use (REQ-cross-mod-disconnects-when-unused)', () => {
  it('connects inputs and output at once, and cuts them only after the delay', async () => {
    const { voice, fmHz, fmAmt, hzSrc, kGain, osc1Signal, osc2Freq } = await build();
    // Off: neither input reaches the chain either (Gecko renders unreachable nodes).
    expect(osc1Signal.connect).not.toHaveBeenCalledWith(fmAmt);
    expect(hzSrc.connect).not.toHaveBeenCalledWith(kGain);
    voice.setFmInUse(true);
    expect(fmHz.connect).toHaveBeenCalledWith(osc2Freq);
    expect(osc1Signal.connect).toHaveBeenCalledWith(fmAmt);
    expect(hzSrc.connect).toHaveBeenCalledWith(kGain);
    voice.setFmInUse(false);
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS - 1);
    expect(fmHz.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fmHz.disconnect).toHaveBeenCalledWith(osc2Freq);
    expect(osc1Signal.disconnect).toHaveBeenCalledWith(fmAmt);
    expect(hzSrc.disconnect).toHaveBeenCalledWith(kGain);
  });

  it('a re-engage inside the window keeps the edge rather than racing the cut', async () => {
    const { voice, fmHz, osc2Freq } = await build();
    voice.setFmInUse(true);
    voice.setFmInUse(false);
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS / 2);
    voice.setFmInUse(true);
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS * 2);
    expect(fmHz.disconnect).not.toHaveBeenCalled();
    // Still exactly one connection — the edge was never cut, so never re-made.
    expect(fmHz.connect.mock.calls.filter((c) => c[0] === osc2Freq)).toHaveLength(1);
  });

  it('the knob sets the index on the junction the matrix sums into (REQ-fm-is-a-modulation-destination)', async () => {
    const { voice, fmMod } = await build();
    expect(voice.fmTarget).toBe(fmMod.offset);
    voice.setFm(3);
    expect(lastTarget(fmMod.offset)).toBe(3);
  });
});

describe('FM depth follows the modulator (REQ-fm-index-is-relative-to-the-modulator)', () => {
  it('k is 2^((cents1 - cents2)/1200), whichever oscillator moves', async () => {
    const { voice, kGain } = await build();
    voice.setOscOctave(1, 1);
    expect(lastTarget(kGain.gain)).toBeCloseTo(2, 9);
    voice.setOscOctave(2, 1);
    expect(lastTarget(kGain.gain)).toBeCloseTo(1, 9);
    voice.setOscTune(2, 100);
    expect(lastTarget(kGain.gain)).toBeCloseTo(Math.pow(2, -100 / 1200), 9);
    // The Osc itself still took the write.
    expect(voice.osc2.cents).toBe(1300);
  });

  it('each note sets the note-frequency source, through the glide line', async () => {
    const { voice, hzSrc } = await build();
    voice.noteOn(69, 0.8, 1);
    expect(hzSrc.offset.setValueAtTime).toHaveBeenLastCalledWith(midiToHz(69), 1);
    voice.setGlide(0.3);
    voice.noteOn(81, 0.8, 2);
    expect(lastTarget(hzSrc.offset)).toBeCloseTo(midiToHz(81), 6);
  });
});

describe('ring is its own level, DC-blocked (REQ-ring-is-its-own-level, REQ-ring-is-dc-free)', () => {
  it('osc1 drives the VCA gain, osc2 its input, through a highpass into the mix', async () => {
    const { voice, ringVCA, ringHP, ringLevel, osc1Signal, osc2Signal } = await build();
    voice.setRing(0.5);
    expect(osc1Signal.connect).toHaveBeenCalledWith(ringVCA.gain);
    expect(osc2Signal.connect).toHaveBeenCalledWith(ringVCA);
    expect(ringLevel.connect).toHaveBeenCalledWith(voice.mix);
    expect(ringVCA.gain.value).toBe(0);
    expect(ringVCA.connect).toHaveBeenCalledWith(ringHP);
    expect(ringHP.type).toBe('highpass');
    expect(ringHP.frequency.value).toBe(RING_HP_HZ);
    // Butterworth, written in dB because that is how Web Audio reads a high-pass Q.
    expect(ringHP.Q.value).toBeCloseTo(-3.0103, 4);
    expect(RING_HP_Q_DB).toBeCloseTo(-3.0103, 4);
    expect(lastTarget(ringLevel.gain)).toBeCloseTo(0.5 * RING_MAKEUP, 9);
  });

  it('back at 0 the inputs and the output are cut after the delay', async () => {
    const { voice, ringVCA, ringLevel, osc1Signal, osc2Signal } = await build();
    voice.setRing(0.5);
    voice.setRing(0);
    expect(lastTarget(ringLevel.gain)).toBe(0);
    expect(osc1Signal.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS);
    expect(osc1Signal.disconnect).toHaveBeenCalledWith(ringVCA.gain);
    expect(osc2Signal.disconnect).toHaveBeenCalledWith(ringVCA);
    expect(ringLevel.disconnect).toHaveBeenCalledWith(voice.mix);
  });

  it('a non-finite level is no ring', async () => {
    const { voice, ringLevel, osc1Signal } = await build();
    voice.setRing(Number.NaN);
    expect(lastTarget(ringLevel.gain)).toBe(0);
    expect(osc1Signal.connect).not.toHaveBeenCalledWith((voice as any).xmod.ringVCA.gain);
  });
});
