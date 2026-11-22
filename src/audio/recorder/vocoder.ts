/**
 * A channel vocoder over `CapturedAudio` (vocoder.md). Pure: no AudioContext,
 * no DOM — the studio pays for it once, on a press, like the time-stretch.
 *
 * The voice (the modulator) and the carrier go through the same bank of
 * band-passes. Each voice band drives an envelope follower, each carrier band is
 * multiplied by its envelope, and the bands are summed
 * (REQ-a-channel-vocoder-on-log-spaced-bands). The voice is analysed in mono and
 * every gain lands identically on both carrier channels, so a stereo carrier
 * keeps its image (REQ-the-carrier-image-is-kept).
 *
 * Memory is O(frames): the bank is walked one band at a time into reused
 * scratch arrays, never as `bands × frames` at once.
 */
import type { CapturedAudio } from './node';
import { capturedFrames, cloneCaptured, peakOf } from './buffer-dsp';
import { MAX_VOCODER_FRAMES, VOCODER_BANDS, MAX_VOCODER_FORMANT } from '../../state/limits';

export interface VocoderSettings {
  /** One of `VOCODER_BANDS`. */
  bands: number;
  /** Whole bands; carrier band k takes voice band k − formant. */
  formant: number;
  /** Envelope release in ms. */
  smoothMs: number;
  /** 0..1 — how far the carrier is flattened before the voice shapes it. */
  clarity: number;
  /** 0..1 — the voice's own content above VOCODER_SIBILANCE_HZ, mixed in. */
  sibilance: number;
  /** 0..1 — the untouched carrier, mixed back. */
  dry: number;
}

export const DEFAULT_VOCODER: Readonly<VocoderSettings> = {
  bands: 16, formant: 0, smoothMs: 40, clarity: 0.5, sibilance: 0.3, dry: 0,
};

export const VOCODER_LOW_HZ = 100;
export const VOCODER_HIGH_HZ = 8000;
export const VOCODER_ATTACK_MS = 5;
export const VOCODER_SIBILANCE_HZ = 5000;
export const VOCODER_PEAK_CAP = 0.99;
export const MIN_SMOOTH_MS = 10;
export const MAX_SMOOTH_MS = 200;
/** Clarity's floor: 60 dB under the carrier's peak, so an empty band is not raised from its noise. */
const CLARITY_FLOOR = 1e-3;
/** Clarity's gain is a power per sample — the costliest step in the bank. The
 *  envelope it reads is smooth (≥ 5 ms), so the gain is computed every this many
 *  frames and interpolated between: measured 4× off the 32-band render. */
const FLAT_STEP = 16;

const clamp = (v: number, lo: number, hi: number): number =>
  (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** Settings made safe: clamped, and a band count off the list falls back to the default. */
function sane(s: VocoderSettings): VocoderSettings {
  return {
    bands: VOCODER_BANDS.includes(s.bands) ? s.bands : DEFAULT_VOCODER.bands,
    formant: Math.round(clamp(s.formant, -MAX_VOCODER_FORMANT, MAX_VOCODER_FORMANT)),
    smoothMs: Number.isFinite(s.smoothMs) ? clamp(s.smoothMs, MIN_SMOOTH_MS, MAX_SMOOTH_MS) : DEFAULT_VOCODER.smoothMs,
    clarity: clamp(s.clarity, 0, 1),
    sibilance: clamp(s.sibilance, 0, 1),
    dry: clamp(s.dry, 0, 1),
  };
}

/** The bank's centre frequencies, log-spaced, low to high. */
export function bandCentres(bands: number, sampleRate: number): number[] {
  const n = Math.max(1, Math.floor(bands));
  const lo = VOCODER_LOW_HZ;
  const hi = Math.max(lo * 1.5, Math.min(VOCODER_HIGH_HZ, 0.45 * sampleRate));
  if (n === 1) return [Math.sqrt(lo * hi)];
  return Array.from({ length: n }, (_, k) => lo * Math.pow(hi / lo, k / (n - 1)));
}

/** Q for a band-pass one band step wide (the ratio between neighbouring centres). */
function bandQ(bands: number, sampleRate: number): number {
  const c = bandCentres(bands, sampleRate);
  const ratio = c.length > 1 ? c[1]! / c[0]! : 2;
  return Math.sqrt(ratio) / (ratio - 1);
}

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** RBJ band-pass, constant 0 dB peak gain. */
function bandpass(fc: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 };
}

/** RBJ high-pass, Butterworth Q. */
function highpass(fc: number, sr: number): Biquad {
  const w = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0, a2: (1 - alpha) / a0,
  };
}

/** Two cascaded passes of one section, `src` → `dst` (may not alias). */
function run2(f: Biquad, src: Float32Array, dst: Float32Array): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // first section
  let u1 = 0, u2 = 0, v1 = 0, v2 = 0; // second section
  const { b0, b1, b2, a1, a2 } = f;
  for (let i = 0; i < src.length; i++) {
    const x = src[i]!;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    const v = b0 * y + b1 * u1 + b2 * u2 - a1 * v1 - a2 * v2;
    u2 = u1; u1 = y; v2 = v1; v1 = v;
    dst[i] = v;
  }
}

/** Rectify and follow: fast attack, release set by Smooth. In place over `buf`. */
function follow(buf: Float32Array, attack: number, release: number): void {
  let env = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    const x = v < 0 ? -v : v;
    env += (x > env ? attack : release) * (x - env);
    buf[i] = env;
  }
}

/** `max(env, floor)^−clarity` into `out`, computed every FLAT_STEP frames and interpolated. */
function flatten(env: Float32Array, floor: number, clarity: number, out: Float32Array): void {
  const n = env.length;
  const at = (i: number): number => Math.pow(Math.max(env[i]!, floor), -clarity);
  let g0 = at(0);
  for (let i = 0; i < n; i += FLAT_STEP) {
    const next = Math.min(n - 1, i + FLAT_STEP);
    const g1 = at(next);
    const span = Math.max(1, next - i);
    const end = Math.min(n, i + FLAT_STEP);
    for (let k = i; k < end; k++) out[k] = g0 + ((g1 - g0) * (k - i)) / span;
    g0 = g1;
  }
}

/** A copy of `src` resized to `n` frames, non-finite samples read as 0. */
function finiteCopy(src: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  const m = Math.min(n, src.length);
  for (let i = 0; i < m; i++) {
    const v = src[i]!;
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}


/**
 * Vocode `carrier` with `voice` (REQ-vocoding-is-pure). The result is exactly
 * the carrier's length (REQ-the-output-is-the-carriers-length) and peaks where
 * the carrier did (REQ-the-output-peak-matches-the-carrier). Never throws
 * (REQ-vocode-is-total).
 */
export function vocode(carrier: CapturedAudio, voice: CapturedAudio, settings: VocoderSettings): CapturedAudio {
  const n = capturedFrames(carrier);
  // Bounds first, before anything is allocated.
  if (n === 0 || n > MAX_VOCODER_FRAMES) return cloneCaptured(carrier);
  const s = sane(settings);
  const sr = carrier.sampleRate > 0 && Number.isFinite(carrier.sampleRate) ? carrier.sampleRate : 48000;

  const cL = finiteCopy(carrier.left, n);
  const cR = finiteCopy(carrier.right, n);
  // The voice in mono, padded or cut to the carrier's length.
  const vL = finiteCopy(voice.left, n);
  const vR = finiteCopy(voice.right, n);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = 0.5 * (vL[i]! + vR[i]!);
  const carrierPeak = peakOf(cL, cR);
  const voicePeak = peakOf(mono);

  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const centres = bandCentres(s.bands, sr);
  const q = bandQ(s.bands, sr);
  const coef = (ms: number): number => 1 - Math.exp(-1 / ((ms / 1000) * sr));
  const attack = coef(VOCODER_ATTACK_MS);
  const release = coef(s.smoothMs);

  if (voicePeak > 0) {
    const voiceEnv = new Float32Array(n);
    const carrierEnv = new Float32Array(n);
    const bandL = new Float32Array(n);
    const bandR = new Float32Array(n);

    // Clarity's floor: 60 dB under the carrier's peak, so a band the carrier
    // never fills is not raised from its noise.
    const floor = Math.max(1e-9, carrierPeak * CLARITY_FLOOR);
    const flat = new Float32Array(n);

    centres.forEach((fc, k) => {
      const j = k - s.formant;
      if (j < 0 || j >= centres.length) return; // its source is outside the bank
      run2(bandpass(centres[j]!, q, sr), mono, voiceEnv);
      follow(voiceEnv, attack, release);
      const f = bandpass(fc, q, sr);
      run2(f, cL, bandL);
      run2(f, cR, bandR);
      if (s.clarity > 0) {
        // Clarity reads the carrier's mid band, so both channels get the same
        // gain (REQ-the-carrier-image-is-kept) — and by linearity the mid's band
        // is the bands' mean, so it costs no fourth filter pass.
        for (let i = 0; i < n; i++) carrierEnv[i] = 0.5 * (bandL[i]! + bandR[i]!);
        follow(carrierEnv, attack, release);
        flatten(carrierEnv, floor, s.clarity, flat);
        for (let i = 0; i < n; i++) voiceEnv[i] = voiceEnv[i]! * flat[i]!;
      }
      for (let i = 0; i < n; i++) {
        const g = voiceEnv[i]!;
        outL[i] = outL[i]! + bandL[i]! * g;
        outR[i] = outR[i]! + bandR[i]! * g;
      }
    });

    // Wet normalised to 1, so Sibilance and Dry are amounts relative to it.
    const wetPeak = peakOf(outL, outR);
    const wetGain = wetPeak > 0 ? 1 / wetPeak : 0;
    let hs: Float32Array | null = null;
    if (s.sibilance > 0) {
      hs = new Float32Array(n);
      // Kept under Nyquist, or the section is unstable at a low sample rate (REQ-vocode-is-total).
      run2(highpass(Math.min(VOCODER_SIBILANCE_HZ, 0.45 * sr), sr), mono, hs);
    }
    const sibGain = s.sibilance / voicePeak;
    for (let i = 0; i < n; i++) {
      const sib = hs ? hs[i]! * sibGain : 0;
      outL[i] = outL[i]! * wetGain + sib;
      outR[i] = outR[i]! * wetGain + sib;
    }
  }

  if (s.dry > 0 && carrierPeak > 0) {
    const d = s.dry / carrierPeak;
    for (let i = 0; i < n; i++) {
      outL[i] = outL[i]! + cL[i]! * d;
      outR[i] = outR[i]! + cR[i]! * d;
    }
  }

  // Peak-match to the carrier, capped; a silent result stays silent.
  const outPeak = peakOf(outL, outR);
  const target = Math.min(VOCODER_PEAK_CAP, carrierPeak);
  const g = outPeak > 0 && target > 0 ? target / outPeak : 0;
  for (let i = 0; i < n; i++) {
    const l = outL[i]! * g;
    const r = outR[i]! * g;
    outL[i] = Number.isFinite(l) ? l : 0;
    outR[i] = Number.isFinite(r) ? r : 0;
  }
  return { left: outL, right: outR, sampleRate: carrier.sampleRate };
}
