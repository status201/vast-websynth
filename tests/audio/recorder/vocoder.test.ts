import { describe, it, expect } from 'vitest';
import {
  vocode, bandCentres, DEFAULT_VOCODER, VOCODER_PEAK_CAP, type VocoderSettings,
} from '../../../src/audio/recorder/vocoder';
import { fftInPlace } from '../../../src/audio/recorder/fft';
import type { CapturedAudio } from '../../../src/audio/recorder/node';
import { MAX_VOCODER_FRAMES } from '../../../src/state/limits';

/**
 * vocoder.md — the pure channel vocoder. Every check folds the samples to one
 * number (a peak, an energy ratio, a correlation) and asserts that once: a
 * per-sample expect loop starves under the full suite.
 */

const SR = 48000;

/** A seeded PRNG, so the noise — and so every result — is repeatable. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function noise(n: number, seed: number, amp = 0.5): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (r() * 2 - 1) * amp;
  return out;
}

function sine(n: number, hz: number, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

const stereo = (l: Float32Array, r: Float32Array = l.slice()): CapturedAudio => ({ left: l, right: r, sampleRate: SR });
const plain: VocoderSettings = { ...DEFAULT_VOCODER, clarity: 0, sibilance: 0, dry: 0 };

function peak(...chs: Float32Array[]): number {
  let p = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]!));
  return p;
}
function allFinite(...chs: Float32Array[]): boolean {
  for (const ch of chs) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i]!)) return false;
  return true;
}
function correlation(a: Float32Array, b: Float32Array): number {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i]! * b[i]!; aa += a[i]! * a[i]!; bb += b[i]! * b[i]!; }
  return ab / Math.sqrt(aa * bb || 1);
}

describe('vocode (vocoder.md)', () => {
  it('returns exactly the carrier length, whatever the voice length (REQ-the-output-is-the-carriers-length)', () => {
    const carrier = stereo(noise(9600, 1));
    const short = vocode(carrier, stereo(noise(4800, 2)), DEFAULT_VOCODER);
    const long = vocode(carrier, stereo(noise(20000, 3)), DEFAULT_VOCODER);
    expect([short.left.length, short.right.length, long.left.length, long.right.length]).toEqual([9600, 9600, 9600, 9600]);
  });

  it('gives silence for a silent voice (REQ-vocode-is-total)', () => {
    const out = vocode(stereo(noise(9600, 4)), stereo(new Float32Array(9600)), DEFAULT_VOCODER);
    expect(peak(out.left, out.right)).toBe(0);
  });

  it('puts a noise carrier’s energy in the band a voice tone sits in (REQ-a-channel-vocoder-on-log-spaced-bands)', () => {
    const n = 16384;
    const centres = bandCentres(16, SR);
    const fc = centres[8]!;
    const out = vocode(stereo(noise(n, 5)), stereo(sine(n, fc)), plain);
    // The spectrum of the output: the share of energy within a band step of fc.
    const re = Float32Array.from(out.left);
    const im = new Float32Array(n);
    fftInPlace(re, im);
    const lo = centres[7]!;
    const hi = centres[9]!;
    let inside = 0;
    let total = 0;
    for (let k = 1; k < n / 2; k++) {
      const e = re[k]! * re[k]! + im[k]! * im[k]!;
      const hz = (k * SR) / n;
      total += e;
      if (hz >= lo && hz <= hi) inside += e;
    }
    expect(inside / total).toBeGreaterThan(0.6);
  });

  it('keeps identical channels identical (REQ-the-carrier-image-is-kept)', () => {
    const out = vocode(stereo(noise(9600, 6)), stereo(noise(9600, 7)), DEFAULT_VOCODER);
    let diff = 0;
    for (let i = 0; i < out.left.length; i++) diff = Math.max(diff, Math.abs(out.left[i]! - out.right[i]!));
    expect(diff).toBe(0);
  });

  it('keeps a decorrelated carrier decorrelated, so its mono down-mix does not collapse (REQ-the-carrier-image-is-kept)', () => {
    const n = 24000;
    // Sibilance off: it is the voice itself, centred, and would correlate the pair by design.
    const out = vocode(stereo(noise(n, 8), noise(n, 9)), stereo(noise(n, 10)), { ...DEFAULT_VOCODER, sibilance: 0 });
    expect(Math.abs(correlation(out.left, out.right))).toBeLessThan(0.3);
  });

  it('never throws or leaks a non-finite sample on bad input (REQ-vocode-is-total)', () => {
    const c = noise(9600, 11);
    const v = noise(9600, 12);
    c[10] = Number.NaN; c[20] = Infinity; v[30] = -Infinity; v[40] = Number.NaN;
    const wild = { bands: 7, formant: 99, smoothMs: Number.NaN, clarity: 5, sibilance: -1, dry: Infinity };
    const out = vocode(stereo(c), stereo(v), wild);
    expect(allFinite(out.left, out.right)).toBe(true);
    expect(peak(out.left, out.right)).toBeLessThanOrEqual(VOCODER_PEAK_CAP + 1e-6);
  });

  it('stays finite at a low sample rate, where Sibilance\u2019s corner would pass Nyquist (REQ-vocode-is-total)', () => {
    const lo = (a: Float32Array): CapturedAudio => ({ left: a, right: a.slice(), sampleRate: 8000 });
    const out = vocode(lo(noise(8000, 21)), lo(noise(8000, 22)), { ...DEFAULT_VOCODER, sibilance: 1 });
    expect(allFinite(out.left, out.right)).toBe(true);
    expect(peak(out.left, out.right)).toBeLessThanOrEqual(VOCODER_PEAK_CAP + 1e-6);
    expect(peak(out.left, out.right)).toBeGreaterThan(0);
  });

  it('hands back a clone for an empty carrier or one past the frame cap (REQ-vocode-is-total)', () => {
    const empty = stereo(new Float32Array(0));
    const e = vocode(empty, stereo(noise(100, 13)), DEFAULT_VOCODER);
    expect(e.left.length).toBe(0);
    expect(e).not.toBe(empty);

    const huge = stereo(new Float32Array(MAX_VOCODER_FRAMES + 1), new Float32Array(MAX_VOCODER_FRAMES + 1));
    huge.left[5] = 0.25;
    const h = vocode(huge, stereo(noise(100, 14)), DEFAULT_VOCODER);
    expect(h.left).not.toBe(huge.left);
    expect([h.left.length, h.left[5]]).toEqual([MAX_VOCODER_FRAMES + 1, 0.25]);
  });

  it('peaks where the carrier did, and renders deterministically (REQ-the-output-peak-matches-the-carrier, REQ-vocoding-is-pure)', () => {
    const carrier = stereo(noise(9600, 15, 0.5));
    const cPeak = peak(carrier.left, carrier.right);
    const a = vocode(carrier, stereo(noise(9600, 16)), DEFAULT_VOCODER);
    const b = vocode(carrier, stereo(noise(9600, 16)), DEFAULT_VOCODER);
    expect(peak(a.left, a.right)).toBeCloseTo(cPeak, 5);
    let same = true;
    for (let i = 0; i < a.left.length; i++) if (a.left[i] !== b.left[i] || a.right[i] !== b.right[i]) { same = false; break; }
    expect(same).toBe(true);
  });

  it('spaces the bands log-evenly and keeps them under Nyquist', () => {
    const c = bandCentres(16, 22050);
    expect(c.length).toBe(16);
    expect(c[0]).toBeCloseTo(100);
    expect(c[15]!).toBeLessThanOrEqual(0.45 * 22050 + 1e-9);
    expect(c[2]! / c[1]!).toBeCloseTo(c[1]! / c[0]!, 9);
  });
});
