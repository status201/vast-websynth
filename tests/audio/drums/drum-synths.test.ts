import { describe, it, expect } from 'vitest';
import { Kick, Snare, HiHat, Clap, makeNoiseBuffer } from '../../../src/audio/drums/drum-synths';
import { makeMockAudioContext } from '../mock-audio-context';

/**
 * Choke plumbing: a choked hit routes through one extra per-hit gain that
 * ramps to 0 at `chokeAt`, and its sources stop shortly after the cut. The
 * envelope shapes themselves are not asserted (the choke gain sits
 * downstream and silences whatever they schedule).
 */
function setup() {
  const mock = makeMockAudioContext();
  const ctx = mock as unknown as AudioContext;
  return { mock, ctx, noise: makeNoiseBuffer(ctx, 0.1) };
}

describe('drum synth choke', () => {
  it('an unchoked Kick creates only its envelope gain and stops at natural decay', () => {
    const { mock, ctx } = setup();
    const kick = new Kick(ctx); // default decay 0.4
    mock.createGain.mockClear();

    kick.trigger(0.5, 0.9);
    expect(mock.createGain).toHaveBeenCalledTimes(1); // env only — no choke gain
    const osc = mock.createOscillator.mock.results[0]!.value;
    expect(osc.stop).toHaveBeenCalledWith(0.5 + 0.4 + 0.05);
  });

  it('a choked Kick ramps the choke gain to 0 at chokeAt and stops early', () => {
    const { mock, ctx } = setup();
    const kick = new Kick(ctx);
    mock.createGain.mockClear();

    const cut = 0.6;
    kick.trigger(0.5, 0.9, cut);
    expect(mock.createGain).toHaveBeenCalledTimes(2); // choke gain + env
    const choke = mock.createGain.mock.results[0]!.value;
    expect(choke.gain.setValueAtTime).toHaveBeenCalledWith(1, cut);
    expect(choke.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, cut + 0.005);
    const osc = mock.createOscillator.mock.results[0]!.value;
    expect(osc.stop).toHaveBeenCalledWith(cut + 0.03);
  });

  it('a choked Snare routes both the noise and tone chains into the choke gain', () => {
    const { mock, ctx, noise } = setup();
    const snare = new Snare(ctx, noise); // default decay 0.18
    mock.createGain.mockClear();

    const cut = 0.52;
    snare.trigger(0.5, 0.8, cut);
    const choke = mock.createGain.mock.results[0]!.value;
    const noiseEnv = mock.createGain.mock.results[1]!.value;
    const toneEnv = mock.createGain.mock.results[2]!.value;
    expect(noiseEnv.connect).toHaveBeenCalledWith(choke);
    expect(toneEnv.connect).toHaveBeenCalledWith(choke);
    // Both sources stop at the cut (it lands before either natural end).
    const src = mock.createBufferSource.mock.results[0]!.value;
    const tone = mock.createOscillator.mock.results[0]!.value;
    expect(src.stop).toHaveBeenCalledWith(cut + 0.03);
    expect(tone.stop).toHaveBeenCalledWith(cut + 0.03);
  });

  it('a choke past the natural end never extends a Clap', () => {
    const { mock, ctx, noise } = setup();
    const clap = new Clap(ctx, noise); // default decay 0.25
    mock.createGain.mockClear();

    clap.trigger(0, 0.8, 5); // cut far beyond the tail
    const src = mock.createBufferSource.mock.results[0]!.value;
    expect(src.stop).toHaveBeenCalledWith(0 + 0.25 + 0.05); // natural end wins
  });
});

/**
 * Tune is now real on every voice (REQ-6): a semitone offset scales the noise
 * filters + oscillators by 2^(tune/12). +12 doubles, -12 halves.
 */
describe('drum synth tune', () => {
  it('Snare tune shifts the noise highpass and body-tone frequencies', () => {
    const { mock, ctx, noise } = setup();
    const snare = new Snare(ctx, noise);
    snare.setTune(12); // +1 octave → ×2
    snare.trigger(0, 0.8);
    const hp = mock.createBiquadFilter.mock.results[0]!.value;
    expect(hp.frequency.value).toBeCloseTo(3000); // 1500 × 2
    const tone = mock.createOscillator.mock.results[0]!.value;
    expect(tone.frequency.setValueAtTime).toHaveBeenCalledWith(440, 0); // 220 × 2
    expect(tone.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(240, 0.05); // 120 × 2
  });

  it('HiHat tune shifts the highpass and bandpass frequencies', () => {
    const { mock, ctx, noise } = setup();
    const hat = new HiHat(ctx, noise, false);
    hat.setTune(12);
    hat.trigger(0, 0.7);
    const hp = mock.createBiquadFilter.mock.results[0]!.value;
    const bp = mock.createBiquadFilter.mock.results[1]!.value;
    expect(hp.frequency.value).toBeCloseTo(14000); // 7000 × 2
    expect(bp.frequency.value).toBeCloseTo(20000); // 10000 × 2
  });

  it('Clap tune shifts the bandpass frequency', () => {
    const { mock, ctx, noise } = setup();
    const clap = new Clap(ctx, noise);
    clap.setTune(-12); // −1 octave → ×0.5
    clap.trigger(0, 0.8);
    const bp = mock.createBiquadFilter.mock.results[0]!.value;
    expect(bp.frequency.value).toBeCloseTo(550); // 1100 × 0.5
  });
});
