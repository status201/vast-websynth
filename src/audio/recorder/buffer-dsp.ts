/**
 * Pure sample-editing helpers — NO AudioContext / DOM dependency, so they
 * are unit-testable under vitest+jsdom exactly like `encode.ts`. Every
 * function takes a `CapturedAudio` and returns a NEW one (immutability keeps
 * the modal's undo/reset trivial). Filter/octave effects are NOT here — they
 * need real DSP and live in `offline-render.ts`.
 */
import type { CapturedAudio } from './node';

/** Build a NEW Float32Array by mapping each sample of `src`. */
function mapChannel(src: Float32Array, fn: (v: number, i: number) => number): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = fn(src[i]!, i);
  return out;
}

/** Deep copy — mutating the result never touches the source. */
export function cloneCaptured(a: CapturedAudio): CapturedAudio {
  return { left: a.left.slice(), right: a.right.slice(), sampleRate: a.sampleRate };
}

/**
 * Keep samples `[startSample, endSample)`. Indices are clamped to the buffer;
 * an invalid (empty/reversed) range is a no-op (returns a clone) so callers
 * never get a zero-length buffer that would break playback/encoding.
 */
export function crop(a: CapturedAudio, startSample: number, endSample: number): CapturedAudio {
  const len = Math.min(a.left.length, a.right.length);
  const s = Math.max(0, Math.min(Math.floor(startSample), len));
  const e = Math.max(0, Math.min(Math.floor(endSample), len));
  if (e <= s) return cloneCaptured(a);
  return { left: a.left.slice(s, e), right: a.right.slice(s, e), sampleRate: a.sampleRate };
}

/** Play backwards. */
export function reverse(a: CapturedAudio): CapturedAudio {
  const rev = (src: Float32Array): Float32Array => {
    const n = src.length;
    return mapChannel(src, (_v, i) => src[n - 1 - i]!);
  };
  return { left: rev(a.left), right: rev(a.right), sampleRate: a.sampleRate };
}

/**
 * Scale so the loudest sample (across both channels) hits `targetPeak`.
 * Silent input is returned unchanged (no divide-by-zero / NaN).
 */
export function normalize(a: CapturedAudio, targetPeak = 0.99): CapturedAudio {
  let peak = 0;
  for (const v of a.left) { const av = v < 0 ? -v : v; if (av > peak) peak = av; }
  for (const v of a.right) { const av = v < 0 ? -v : v; if (av > peak) peak = av; }
  if (peak === 0 || !Number.isFinite(peak)) return cloneCaptured(a);
  return gain(a, targetPeak / peak);
}

/** Multiply every sample by `factor` (Boost uses ~2 ≈ +6 dB). Clamping is
 * deferred to the WAV/MP3 encoder, matching the rest of the pipeline. */
export function gain(a: CapturedAudio, factor: number): CapturedAudio {
  return {
    left: mapChannel(a.left, (v) => v * factor),
    right: mapChannel(a.right, (v) => v * factor),
    sampleRate: a.sampleRate,
  };
}

/** Peak level in dBFS across both channels. Silent input → `-Infinity`. */
export function peakDb(a: CapturedAudio): number {
  let peak = 0;
  for (const v of a.left) { const av = v < 0 ? -v : v; if (av > peak) peak = av; }
  for (const v of a.right) { const av = v < 0 ? -v : v; if (av > peak) peak = av; }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

function rampLen(ms: number, sampleRate: number, channelLen: number): number {
  return Math.max(0, Math.min(Math.round((ms / 1000) * sampleRate), channelLen));
}

/** Linear 0→1 ramp over the first `ms` (clamped to the buffer length). */
export function fadeIn(a: CapturedAudio, ms: number): CapturedAudio {
  const apply = (src: Float32Array): Float32Array => {
    const n = rampLen(ms, a.sampleRate, src.length);
    return mapChannel(src, (v, i) => (i < n ? v * (i / n) : v));
  };
  return { left: apply(a.left), right: apply(a.right), sampleRate: a.sampleRate };
}

/** Linear 1→0 ramp over the last `ms` (clamped to the buffer length). */
export function fadeOut(a: CapturedAudio, ms: number): CapturedAudio {
  const apply = (src: Float32Array): Float32Array => {
    const n = rampLen(ms, a.sampleRate, src.length);
    const last = src.length - 1;
    return mapChannel(src, (v, i) => {
      const fromEnd = last - i;
      return fromEnd < n ? v * (fromEnd / n) : v;
    });
  };
  return { left: apply(a.left), right: apply(a.right), sampleRate: a.sampleRate };
}

/**
 * Min/max envelope for the waveform display: `width` columns over a mono
 * mixdown, returned interleaved `[min0,max0,min1,max1,…]` (length width*2).
 */
export function computePeaks(a: CapturedAudio, width: number): Float32Array {
  const out = new Float32Array(Math.max(0, width) * 2);
  const len = Math.min(a.left.length, a.right.length);
  if (width <= 0 || len === 0) return out;
  for (let c = 0; c < width; c++) {
    const start = Math.floor((c / width) * len);
    const end = Math.max(start + 1, Math.floor(((c + 1) / width) * len));
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < end && i < len; i++) {
      const m = (a.left[i]! + a.right[i]!) * 0.5;
      if (m < min) min = m;
      if (m > max) max = m;
    }
    if (!Number.isFinite(min)) { min = 0; max = 0; }
    out[c * 2] = min;
    out[c * 2 + 1] = max;
  }
  return out;
}
