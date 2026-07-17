import { describe, it, expect } from 'vitest';
import { Kick, Snare, HiHat, Clap, Conga, Bongo, Cowbell, Clave, Shaker, makeNoiseBuffer, type DrumSynth } from '../../../src/audio/drums/drum-synths';
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

/**
 * Node lifecycle (regression): a one-shot hit must disconnect every per-hit
 * node once its source(s) finish, or a running song accumulates stopped-but-
 * connected nodes until the audio thread crackles. The persistent per-synth
 * `output` gain (built once in the constructor) must survive the hit.
 */
describe('drum synth node cleanup', () => {
  it('an unchoked Kick disconnects its per-hit nodes on onended, but not output', () => {
    const { mock, ctx } = setup();
    const kick = new Kick(ctx);
    const output = mock.createGain.mock.results[0]!.value; // persistent output gain
    mock.createGain.mockClear();
    mock.createOscillator.mockClear();

    kick.trigger(0.5, 0.9);
    const osc = mock.createOscillator.mock.results[0]!.value;
    const env = mock.createGain.mock.results[0]!.value;
    // Still connected until the source actually ends.
    expect(osc.disconnect).not.toHaveBeenCalled();
    expect(env.disconnect).not.toHaveBeenCalled();

    osc.onended();
    expect(osc.disconnect).toHaveBeenCalled();
    expect(env.disconnect).toHaveBeenCalled();
    expect(output.disconnect).not.toHaveBeenCalled();
  });

  it('a choked Kick also disconnects the per-hit choke gain', () => {
    const { mock, ctx } = setup();
    const kick = new Kick(ctx);
    const output = mock.createGain.mock.results[0]!.value;
    mock.createGain.mockClear();
    mock.createOscillator.mockClear();

    kick.trigger(0.5, 0.9, 0.6);
    const choke = mock.createGain.mock.results[0]!.value; // choke gain created first
    const env = mock.createGain.mock.results[1]!.value;
    const osc = mock.createOscillator.mock.results[0]!.value;

    osc.onended();
    expect(choke.disconnect).toHaveBeenCalled();
    expect(env.disconnect).toHaveBeenCalled();
    expect(osc.disconnect).toHaveBeenCalled();
    expect(output.disconnect).not.toHaveBeenCalled();
  });

  it('a Snare tears down only after BOTH its sources end', () => {
    const { mock, ctx, noise } = setup();
    const snare = new Snare(ctx, noise);
    const output = mock.createGain.mock.results[0]!.value;
    mock.createGain.mockClear();
    mock.createOscillator.mockClear();
    mock.createBufferSource.mockClear();

    snare.trigger(0, 0.8);
    const src = mock.createBufferSource.mock.results[0]!.value; // noise body
    const tone = mock.createOscillator.mock.results[0]!.value; // body tone
    const noiseEnv = mock.createGain.mock.results[0]!.value;
    const toneEnv = mock.createGain.mock.results[1]!.value;

    src.onended();
    // One source done — the shared nodes must stay wired until the last ends.
    expect(noiseEnv.disconnect).not.toHaveBeenCalled();
    expect(toneEnv.disconnect).not.toHaveBeenCalled();

    tone.onended();
    expect(src.disconnect).toHaveBeenCalled();
    expect(tone.disconnect).toHaveBeenCalled();
    expect(noiseEnv.disconnect).toHaveBeenCalled();
    expect(toneEnv.disconnect).toHaveBeenCalled();
    expect(output.disconnect).not.toHaveBeenCalled();
  });
});

/**
 * Percussion voices (drum-machine.md REQ-11): each honours the full DrumSynth
 * contract — unchoked + choked triggers build/tear down their one-shot graphs
 * like the classic voices do.
 */
describe('percussion voices', () => {
  const build = (name: string): { mock: ReturnType<typeof makeMockAudioContext>; synth: DrumSynth } => {
    const { mock, ctx, noise } = setup();
    const synth: DrumSynth =
      name === 'Conga' ? new Conga(ctx) :
      name === 'Bongo' ? new Bongo(ctx, noise) :
      name === 'Cowbell' ? new Cowbell(ctx) :
      name === 'Clave' ? new Clave(ctx) :
      new Shaker(ctx, noise);
    mock.createGain.mockClear();
    mock.createOscillator.mockClear();
    mock.createBufferSource.mockClear();
    return { mock, synth };
  };

  for (const name of ['Conga', 'Bongo', 'Cowbell', 'Clave', 'Shaker']) {
    it(`${name} triggers unchoked and cleans up on ended`, () => {
      const { mock, synth } = build(name);
      synth.setTune(3);
      synth.setDecay(0.2);
      synth.trigger(0.5, 0.9);
      const sources = [
        ...mock.createOscillator.mock.results.map((r) => r.value),
        ...mock.createBufferSource.mock.results.map((r) => r.value),
      ];
      expect(sources.length).toBeGreaterThan(0);
      for (const s of sources) {
        expect(s.start).toHaveBeenCalled();
        expect(s.stop).toHaveBeenCalled();
        s.onended();
      }
      // Every per-hit node is disconnected after the last source ends.
      for (const r of mock.createGain.mock.results) {
        expect(r.value.disconnect).toHaveBeenCalled();
      }
    });

    it(`${name} choked routes through a choke gain that cuts at chokeAt`, () => {
      const { mock, synth } = build(name);
      const cut = 0.56;
      synth.trigger(0.5, 0.9, cut);
      const choke = mock.createGain.mock.results[0]!.value;
      expect(choke.gain.setValueAtTime).toHaveBeenCalledWith(1, cut);
      expect(choke.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, cut + 0.005);
    });
  }

  it('Shaker swells in over ~12 ms instead of snapping like a hat', () => {
    const { mock, synth } = build('Shaker');
    synth.trigger(1, 1);
    const env = mock.createGain.mock.results[0]!.value;
    expect(env.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.55, 1 + 0.012);
  });

  it('Cowbell tune shifts both square oscillators and the bandpass', () => {
    const { mock, synth } = build('Cowbell');
    synth.setTune(12); // +1 octave → 2x
    synth.trigger(0, 1);
    const o1 = mock.createOscillator.mock.results[0]!.value;
    const o2 = mock.createOscillator.mock.results[1]!.value;
    expect(o1.frequency.value).toBeCloseTo(1120);
    expect(o2.frequency.value).toBeCloseTo(1690);
    const bp = mock.createBiquadFilter.mock.results[0]!.value;
    expect(bp.frequency.value).toBeCloseTo(1400);
  });
});
