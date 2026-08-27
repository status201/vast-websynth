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

/* ---------------------------------------------------------------- chopping */
/*
 * sample-chop.md REQ-3/REQ-4. All three are pure and take/return plain sample
 * indices, so the modal's drawing, its slice count and its crops are all derived
 * from the same numbers and cannot drift apart.
 *
 * A "boundary list" is what falls BETWEEN slices — n slices have n-1 boundaries.
 * The outer edges are the selection's own, and repeating them here is what makes
 * an off-by-one possible.
 */

/** How close two boundaries may sit, as a fraction of the region. */
const MIN_SLICE_FRACTION = 0.005;

/** How far {@link detectOnsets} may walk back from a rise peak to the attack's
 *  foot, in analysis frames (~5 ms each). */
const ONSET_BACKOFF_FRAMES = 3;

/** Interior boundaries dividing `[from, to)` into `n` equal slices. */
export function sliceEqual(a: CapturedAudio, n: number, from = 0, to = -1): number[] {
  const len = Math.min(a.left.length, a.right.length);
  const s = Math.max(0, Math.min(Math.floor(from), len));
  const e = to < 0 ? len : Math.max(s, Math.min(Math.floor(to), len));
  const count = Math.max(1, Math.floor(n));
  if (count < 2 || e - s < count) return [];
  const out: number[] = [];
  for (let i = 1; i < count; i++) out.push(s + Math.round(((e - s) * i) / count));
  return out;
}

/** Boundaries → the consecutive `[start, end)` pairs they describe. */
export function sliceRanges(from: number, to: number, bounds: readonly number[]): [number, number][] {
  const edges = [from, ...bounds.filter((b) => b > from && b < to), to];
  const out: [number, number][] = [];
  for (let i = 0; i < edges.length - 1; i++) out.push([edges[i]!, edges[i + 1]!]);
  return out;
}

export interface OnsetOptions {
  from?: number;
  to?: number;
  /** Cap on the number of onsets returned, strongest first (then re-sorted). */
  maxSlices?: number;
  /** Refractory period: how long after a hit another may be reported. */
  minGapMs?: number;
  /** Rising-energy threshold, relative to the loudest rise found (0..1). */
  threshold?: number;
}

/**
 * Interior boundaries at transients (REQ-4).
 *
 * Short-time RMS over a mono mixdown, then peaks in the *rising* edge of that
 * envelope. Energy alone finds the loudest moment of a hit, which is behind its
 * attack; the rise finds where the attack began, which is where a slice has to
 * start or the chop clips the transient off its own slice.
 *
 * `minGapMs` is a refractory period, and it is the whole difference between a
 * detector and a noise generator: without it a snare's decaying body re-triggers
 * for as long as it rings. 60 ms is under a 32nd at any usable tempo, so it never
 * merges two real hits.
 *
 * Deliberately simple — no FFT, no spectral flux (ADR-010: cheap, and the user
 * can drag every boundary anyway, REQ-3).
 */
export function detectOnsets(a: CapturedAudio, opts: OnsetOptions = {}): number[] {
  const len = Math.min(a.left.length, a.right.length);
  const from = Math.max(0, Math.min(Math.floor(opts.from ?? 0), len));
  const to = Math.max(from, Math.min(Math.floor(opts.to ?? len), len));
  const maxSlices = Math.max(1, Math.floor(opts.maxSlices ?? 8));
  const minGap = Math.round(((opts.minGapMs ?? 60) / 1000) * a.sampleRate);
  const threshold = Math.max(0, Math.min(1, opts.threshold ?? 0.18));
  const span = to - from;
  if (span < 2 || maxSlices < 2) return [];

  // ~5 ms frames: short enough to place an attack, long enough that one noisy
  // sample cannot be an onset on its own.
  const hop = Math.max(1, Math.round(a.sampleRate * 0.005));
  const frames = Math.floor(span / hop);
  if (frames < 3) return [];

  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const s = from + f * hop;
    let sum = 0;
    for (let i = s; i < s + hop && i < to; i++) {
      const m = (a.left[i]! + a.right[i]!) * 0.5;
      sum += m * m;
    }
    rms[f] = Math.sqrt(sum / hop);
  }

  // Rising edge only: negative differences are a decay, never an onset.
  const rise = new Float32Array(frames);
  let loudest = 0;
  for (let f = 1; f < frames; f++) {
    const d = rms[f]! - rms[f - 1]!;
    rise[f] = d > 0 ? d : 0;
    if (rise[f]! > loudest) loudest = rise[f]!;
  }
  if (loudest <= 0) return [];

  const floor = loudest * threshold;
  const peaks: { at: number; strength: number }[] = [];
  let lastAt = -Infinity;
  for (let f = 1; f < frames - 1; f++) {
    const v = rise[f]!;
    if (v < floor || v < rise[f - 1]! || v < rise[f + 1]!) continue;
    // The rise PEAKS one frame into the attack, not at its foot: the frame holding
    // the hit's first samples is only partly loud, so the next frame shows the
    // bigger jump. Cutting there costs the slice the front of its own transient —
    // the one defect a chop cannot be forgiven, and one that no assertion on
    // "within a few ms" would catch because it is signed. So walk back to where
    // the rise began. Capped, or a slow pad swell would drag the cut into the
    // previous slice; a few ms of lead-in silence is always the safer error.
    let foot = f;
    while (foot > 1 && rise[foot - 1]! > 0 && f - foot < ONSET_BACKOFF_FRAMES) foot--;
    const at = from + (foot - 1) * hop;
    if (at - lastAt < minGap) continue;
    lastAt = at;
    peaks.push({ at: Math.max(from, at), strength: v });
  }

  // The FIRST onset is the selection's own start, not a boundary between slices.
  const interior = peaks.filter((p) => p.at > from + minGap);
  // Keep the strongest when there are more hits than slots, then restore time
  // order — dropping the LAST few would just truncate the break.
  interior.sort((x, y) => y.strength - x.strength);
  const kept = interior.slice(0, maxSlices - 1).map((p) => p.at);
  kept.sort((x, y) => x - y);

  const minSlice = Math.max(1, Math.round(span * MIN_SLICE_FRACTION));
  return kept.filter((b, i) => (i === 0 ? b - from : b - kept[i - 1]!) >= minSlice
    && to - b >= minSlice);
}
