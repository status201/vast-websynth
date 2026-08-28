/**
 * Pitch-preserving time-stretch (time-stretch.md).
 *
 * Pure — `CapturedAudio` in, `CapturedAudio` out, no `AudioContext` and no DOM —
 * so it unit-tests under vitest+jsdom exactly like `buffer-dsp.ts`. It is a
 * sibling of that module rather than more of it: every helper there fits on a
 * screen, and these two algorithms do not.
 *
 * ADR-010 was cited in sampler.md to decline time-stretch, on the grounds that it
 * needs a granular engine. That is true of a *realtime* stretch, which is what
 * that ADR budgets — per sample, per voice, per live instance. This runs once, on
 * a button press, with the calling surface disabled, so `cheap` ranks far lower
 * here; ADR-010 carries a dated note saying so. `stable` is not relaxed: every
 * entry point below is total, and the output length is bounded before it is
 * allocated (REQ-6/REQ-7).
 *
 * Two algorithms, because one does not cover the material:
 *
 *   rhythmic  WSOLA — splices the source at whichever offset best continues what
 *             has already been written. Keeps transients, which is what a break
 *             or a loop is made of. The default.
 *   tonal     Phase vocoder — resynthesises from magnitudes and integrated phase.
 *             Smoother on sustained tones, and smears drums into a wash.
 */
import type { CapturedAudio } from './node';
import { cloneCaptured } from './buffer-dsp';
import { fftInPlace } from './fft';
import {
  MIN_STRETCH_RATIO,
  MAX_STRETCH_RATIO,
  MAX_STRETCH_OUTPUT_FRAMES,
} from '../../state/limits';

export type StretchMode = 'rhythmic' | 'tonal';

/** Analysis grain, and the synthesis hop at the 4× overlap both algorithms use. */
const GRAIN = 2048;
const OVERLAP = 4;

/** How far WSOLA may slide a grain to find a better splice, in samples. */
const SEARCH = 512;
/** Samples compared per candidate offset. */
const CORR = 512;
/** Coarse pass stride; the fine pass then scans ±`COARSE` around the winner. */
const COARSE = 4;

/** Below this many frames there is no pitch to preserve — see {@link resampleLinear}. */
const MIN_ANALYSIS_FRAMES = 128;

/**
 * Periodic Hann, offset by half a sample so it is **never exactly zero**.
 *
 * That detail is load-bearing. Both algorithms divide the overlap-added result by
 * the accumulated window sum, and that division is what removes the window again:
 * where one grain covers a sample, `(x·w)/w` is `x`. A window that hits 0 at its
 * ends makes the sum 0 at the very first sample, and the usual fix — a fade — is
 * a real 21 ms fade-in on every stretched clip.
 */
function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
  return w;
}

/** The largest power of two ≤ `max` that a `len`-frame source can support. */
function grainFor(len: number, max = GRAIN): number {
  const fit = 1 << Math.floor(Math.log2(Math.max(2, len / 2)));
  return Math.max(64, Math.min(max, fit));
}

function monoMix(a: CapturedAudio, len: number): Float32Array {
  const m = new Float32Array(len);
  for (let i = 0; i < len; i++) m[i] = (a.left[i]! + a.right[i]!) * 0.5;
  return m;
}

/**
 * Plain linear resample to an exact length. Used only for clips too short to
 * analyse ({@link MIN_ANALYSIS_FRAMES}) — a few milliseconds of audio is a click,
 * it has no pitch to preserve, and returning the wrong *length* there would break
 * REQ-3 for every caller to work around.
 */
function resampleLinear(a: CapturedAudio, len: number, out: number): CapturedAudio {
  const map = (src: Float32Array): Float32Array => {
    const dst = new Float32Array(out);
    for (let i = 0; i < out; i++) {
      const pos = (i * (len - 1)) / Math.max(1, out - 1);
      const j = Math.floor(pos);
      const f = pos - j;
      const s0 = src[Math.min(j, len - 1)]!;
      const s1 = src[Math.min(j + 1, len - 1)]!;
      dst[i] = s0 + (s1 - s0) * f;
    }
    return dst;
  };
  return { left: map(a.left), right: map(a.right), sampleRate: a.sampleRate };
}

/**
 * Normalised cross-correlation of `cand` (source, at `pos`) against `ref` (what
 * has already been written, at `refPos`), over `n` samples.
 *
 * Normalising by the candidate's own energy is what stops the search simply
 * finding the loudest moment nearby instead of the best-matching one.
 */
function ncc(ref: Float32Array, refPos: number, cand: Float32Array, pos: number, n: number): number {
  let dot = 0;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const c = cand[pos + i]!;
    dot += ref[refPos + i]! * c;
    energy += c * c;
  }
  return energy > 1e-12 ? dot / Math.sqrt(energy) : 0;
}

/**
 * WSOLA (REQ-2, REQ-5).
 *
 * The similarity search runs **once, on a mono mixdown**, and the winning offset
 * is applied to both channels. Searching each channel independently would splice
 * them at different instants and collapse the stereo image — a defect no length
 * or pitch assertion catches, which is exactly why it is written down.
 *
 * The search is coarse-then-fine: a full ±512 scan at every candidate would be
 * ~200M multiply-adds on a four-second clip, and striding by 4 before refining
 * costs a quarter of that for the same answer.
 */
function wsola(a: CapturedAudio, len: number, out: number): CapturedAudio {
  const grain = grainFor(len);
  const hop = grain / OVERLAP;
  const win = hann(grain);
  const mono = monoMix(a, len);
  const corr = Math.min(CORR, grain - hop);
  const ratio = out / len;

  const accL = new Float32Array(out + grain);
  const accR = new Float32Array(out + grain);
  const sum = new Float32Array(out + grain);
  // The mono accumulation the search correlates against. Kept separately so the
  // reference is the same signal the candidates are drawn from.
  const accM = new Float32Array(out + grain);

  const maxRead = Math.max(0, len - grain);
  let prevEnd = 0;

  for (let k = 0; ; k++) {
    const sPos = k * hop;
    if (sPos >= out) break;

    const ideal = Math.min(maxRead, Math.round(sPos / ratio));
    let aPos = ideal;

    if (k > 0 && maxRead > 0) {
      // Correlate the source's candidate window against the tail already written.
      const lo = Math.max(0, ideal - SEARCH);
      const hi = Math.min(maxRead, ideal + SEARCH);
      let best = -Infinity;
      let bestAt = ideal;
      for (let p = lo; p <= hi; p += COARSE) {
        const s = ncc(accM, sPos, mono, p, corr);
        if (s > best) { best = s; bestAt = p; }
      }
      const flo = Math.max(lo, bestAt - COARSE);
      const fhi = Math.min(hi, bestAt + COARSE);
      for (let p = flo; p <= fhi; p++) {
        const s = ncc(accM, sPos, mono, p, corr);
        if (s > best) { best = s; bestAt = p; }
      }
      aPos = bestAt;
    }

    for (let i = 0; i < grain; i++) {
      const w = win[i]!;
      const src = aPos + i;
      const at = sPos + i;
      accL[at] = accL[at]! + a.left[src]! * w;
      accR[at] = accR[at]! + a.right[src]! * w;
      accM[at] = accM[at]! + mono[src]! * w;
      sum[at] = sum[at]! + w;
    }
    prevEnd = sPos + grain;
  }

  const left = new Float32Array(out);
  const right = new Float32Array(out);
  const covered = Math.min(out, prevEnd);
  for (let i = 0; i < covered; i++) {
    const s = sum[i]!;
    if (s > 1e-9) { left[i] = accL[i]! / s; right[i] = accR[i]! / s; }
  }
  return { left, right, sampleRate: a.sampleRate };
}

/**
 * Phase vocoder (REQ-2), with identity phase locking.
 *
 * Per bin: measure how far the phase actually advanced over the analysis hop,
 * subtract the advance that bin would have made on its own, wrap the remainder
 * into ±π to get the true frequency deviation, then re-integrate that at the
 * synthesis hop. Magnitudes are carried across untouched — the pitch is entirely
 * in the phase advance, which is why rescaling it moves time and not pitch.
 *
 * **Integrating every bin independently is the textbook version, and it measurably
 * loses level.** A real sinusoid occupies a peak bin and its window's skirts, and
 * those bins only sum back to a sinusoid while they hold their original phase
 * relationships. Advance them separately and they drift apart, so consecutive
 * synthesis frames partly cancel instead of reinforcing: on a rendered drum bar
 * this cost ~5 dB of RMS, which is a level drop long before it is an effect.
 *
 * So only spectral **peaks** integrate. Every other bin is pinned to the peak that
 * owns it, keeping the phase difference it arrived with (Laroche & Dolson identity
 * locking). It is one extra pass over the bins, and ADR-010 puts *musical* first.
 *
 * **The phase is derived once, from the mid (L+R), and applied to both channels as
 * the same rotation** — REQ-5, the rule WSOLA follows for the same reason. Running
 * the integration per channel is the obvious shape and it silently decorrelates
 * them: each channel drifts to its own phase, the stereo image smears, and the two
 * cancel when anything sums them. It costs nothing per channel and it is invisible
 * in a per-channel level check — it showed up as **-5.7 dB of mono RMS** on a
 * rendered bar while each channel on its own measured -0.2 dB.
 */
function vocoder(a: CapturedAudio, len: number, out: number): CapturedAudio {
  const n = grainFor(len);
  const synHop = n / OVERLAP;
  const anaHop = synHop * (len / out);
  const win = hann(n);
  const bins = n / 2 + 1;

  const lRe = new Float32Array(n);
  const lIm = new Float32Array(n);
  const rRe = new Float32Array(n);
  const rIm = new Float32Array(n);
  const mag = new Float64Array(bins);
  const ph = new Float64Array(bins);
  const integrated = new Float64Array(bins);
  const owner = new Int32Array(bins);
  const lastPhase = new Float64Array(bins);
  const runPhase = new Float64Array(bins);
  const peaks: number[] = [];

  const accL = new Float32Array(out + n);
  const accR = new Float32Array(out + n);
  const sum = new Float32Array(out + n);
  const maxRead = Math.max(0, len - n);
  let first = true;
  let end = 0;

  for (let k = 0; ; k++) {
    const sPos = k * synHop;
    if (sPos >= out) break;
    const aPos = Math.min(maxRead, Math.round(k * anaHop));

    for (let i = 0; i < n; i++) {
      const w = win[i]!;
      lRe[i] = a.left[aPos + i]! * w; lIm[i] = 0;
      rRe[i] = a.right[aPos + i]! * w; rIm[i] = 0;
    }
    fftInPlace(lRe, lIm);
    fftInPlace(rRe, rIm);

    // The mid spectrum drives the phase for both channels.
    for (let b = 0; b < bins; b++) {
      const mr = lRe[b]! + rRe[b]!;
      const mi = lIm[b]! + rIm[b]!;
      mag[b] = Math.hypot(mr, mi);
      const phase = Math.atan2(mi, mr);
      ph[b] = phase;
      const expected = (2 * Math.PI * b * anaHop) / n;

      let dev = phase - lastPhase[b]! - expected;
      // Wrap into ±π: the measured phase is only known modulo 2π, so the
      // deviation has to be brought back to the smallest rotation that explains it.
      dev -= 2 * Math.PI * Math.round(dev / (2 * Math.PI));
      lastPhase[b] = phase;

      integrated[b] = first
        ? phase
        : runPhase[b]! + ((expected + dev) * synHop) / anaHop;
    }

    // Peaks own their skirts. `>=` on one side so a flat pair still elects one.
    peaks.length = 0;
    for (let b = 0; b < bins; b++) {
      const lo = b > 0 ? mag[b - 1]! : -1;
      const hi = b < bins - 1 ? mag[b + 1]! : -1;
      if (mag[b]! > lo && mag[b]! >= hi) peaks.push(b);
    }
    if (peaks.length === 0) {
      for (let b = 0; b < bins; b++) owner[b] = b;
    } else {
      let p = 0;
      for (let b = 0; b < bins; b++) {
        while (p + 1 < peaks.length
          && Math.abs(peaks[p + 1]! - b) <= Math.abs(peaks[p]! - b)) p++;
        owner[b] = peaks[p]!;
      }
    }

    for (let b = 0; b < bins; b++) {
      const o = owner[b]!;
      const p = o === b ? integrated[b]! : integrated[o]! + (ph[b]! - ph[o]!);
      runPhase[b] = p;
      // One rotation, both channels: their magnitudes and — crucially — the phase
      // difference BETWEEN them survive untouched. That difference is the image.
      const rot = p - ph[b]!;
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const lr = lRe[b]!; const li = lIm[b]!;
      const rr = rRe[b]!; const ri = rIm[b]!;
      lRe[b] = lr * c - li * s; lIm[b] = lr * s + li * c;
      rRe[b] = rr * c - ri * s; rIm[b] = rr * s + ri * c;
      // Keep each spectrum conjugate-symmetric or the inverse transform is complex.
      if (b > 0 && b < n / 2) {
        lRe[n - b] = lRe[b]!; lIm[n - b] = -lIm[b]!;
        rRe[n - b] = rRe[b]!; rIm[n - b] = -rIm[b]!;
      }
    }
    lIm[0] = 0; lIm[n / 2] = 0;
    rIm[0] = 0; rIm[n / 2] = 0;
    first = false;

    fftInPlace(lRe, lIm, true);
    fftInPlace(rRe, rIm, true);
    for (let i = 0; i < n; i++) {
      const w = win[i]!;
      const at = sPos + i;
      accL[at] = accL[at]! + lRe[i]! * w;
      accR[at] = accR[at]! + rRe[i]! * w;
      sum[at] = sum[at]! + w * w;
    }
    end = sPos + n;
  }

  const left = new Float32Array(out);
  const right = new Float32Array(out);
  const covered = Math.min(out, end);
  for (let i = 0; i < covered; i++) {
    const s = sum[i]!;
    if (s > 1e-9) { left[i] = accL[i]! / s; right[i] = accR[i]! / s; }
  }
  return { left, right, sampleRate: a.sampleRate };
}

/**
 * Retime `a` to exactly `targetFrames` (REQ-3) — the primary entry.
 *
 * Takes the target directly rather than a ratio, because a ratio rounds: a clip
 * one or two frames off the bar is the whole failure this feature exists to
 * prevent.
 *
 * Total by contract (REQ-6): a non-finite or non-positive target, an empty
 * buffer, a target past `MAX_STRETCH_OUTPUT_FRAMES`, or a ratio outside
 * `MIN_STRETCH_RATIO..MAX_STRETCH_RATIO` all return a clone. The bound is checked
 * **before** anything is allocated — a ratio alone does not bound an allocation
 * when the input is already long (ADR-015).
 */
export function fitToFrames(
  a: CapturedAudio,
  targetFrames: number,
  mode: StretchMode = 'rhythmic',
): CapturedAudio {
  const len = Math.min(a.left.length, a.right.length);
  if (len === 0) return cloneCaptured(a);

  // Non-finite first: the app-wide `max(min, min(max, v))` idiom returns NaN for
  // NaN (untrusted-input.md REQ-6), so clamping would let it straight through.
  if (!Number.isFinite(targetFrames)) return cloneCaptured(a);
  const out = Math.round(targetFrames);
  if (out <= 0 || out > MAX_STRETCH_OUTPUT_FRAMES) return cloneCaptured(a);

  const ratio = out / len;
  if (ratio < MIN_STRETCH_RATIO || ratio > MAX_STRETCH_RATIO) return cloneCaptured(a);

  // REQ-4 — a ratio of 1 runs no analysis at all. A claim about the code path,
  // not about the value, and pinned by a test.
  if (out === len) return cloneCaptured(a);

  if (len < MIN_ANALYSIS_FRAMES) return resampleLinear(a, len, out);
  return mode === 'tonal' ? vocoder(a, len, out) : wsola(a, len, out);
}

/**
 * Retime by a factor — `ratio` is output ÷ input, so 2 is twice as long and half
 * the tempo. Thin wrapper over {@link fitToFrames}, which owns every guard.
 */
export function timeStretch(
  a: CapturedAudio,
  ratio: number,
  mode: StretchMode = 'rhythmic',
): CapturedAudio {
  if (!Number.isFinite(ratio) || ratio <= 0) return cloneCaptured(a);
  const len = Math.min(a.left.length, a.right.length);
  if (len === 0) return cloneCaptured(a);
  if (ratio === 1) return cloneCaptured(a);
  return fitToFrames(a, Math.round(len * ratio), mode);
}
