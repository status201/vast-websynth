/**
 * The scratch reader (scratch.md) — a variable-rate resample driven by a drawn
 * curve, with a crossfader.
 *
 * Pure — `CapturedAudio` in, `CapturedAudio` out, no `AudioContext` and no DOM —
 * so it unit-tests under vitest+jsdom exactly like `time-stretch.ts`. It is a
 * sibling of `buffer-dsp.ts` rather than more of it: every helper there fits on a
 * screen, and an interpolator with an anti-alias inner loop does not.
 *
 * **Why this is hand-written.** Two shorter routes exist and both are closed:
 *
 *   - Automating `playbackRate` on an `OfflineAudioContext`. The graph accepts
 *     the automation, but no shipping browser plays an `AudioBufferSourceNode`
 *     backwards — the rate floors at zero. Reverse motion *is* the scratch, so
 *     this fails at the first requirement rather than at the edges.
 *   - Segmenting at the control points and calling `fitToFrames` per segment.
 *     That function is pitch-*preserving* by construction; a scratch's pitch has
 *     to ride its speed. Pitch-preserved, the result is a stutter edit.
 *
 * So this is the generalisation of the linear resampler `time-stretch.ts` keeps
 * privately for very short clips: the same read loop, fed a position map instead
 * of a linear ramp (ADR-003 — no dependency, and none is wanted).
 *
 * ADR-010 ranks *musical > stable > cheap*, and carries a dated note recording
 * that its scope is the audio thread. This runs once, on a button press, with the
 * calling surface disabled — so *cheap* ranks far lower here, which is what buys
 * the cubic and the anti-alias taps. *Stable* is not relaxed: a curve the user
 * drew reaches a length calculation and an allocation, and every entry point
 * below is total with the bound checked before anything is created (REQ-13).
 */
import type { CapturedAudio } from './node';
import { cloneCaptured, fadeIn, fadeOut } from './buffer-dsp';
import {
  scratchPlan, segmentAt, positionIn, rateIn, cutIn, type ScratchCurve,
} from './scratch-curve';
import { MAX_SCRATCH_RATE, MAX_STRETCH_OUTPUT_FRAMES } from '../../state/limits';

/**
 * Crossfader slew (REQ-10). A hard multiply on a moving waveform steps from a
 * live sample to zero, and that click is what a listener hears *instead of* the
 * rhythm the fader was cutting. Long enough to remove the edge, far shorter than
 * the ~15 ms a sixteenth-note fader click occupies, so the cut still reads sharp.
 */
const SCRATCH_GATE_MS = 1.5;

/**
 * Edge fade (REQ-11) — the same anti-click move `bank-render` makes, and for the
 * same reason: a scratch usually starts and ends mid-waveform. Applied through
 * `buffer-dsp`, which never changes the buffer length, so REQ-5's exact frame
 * count survives it.
 */
const SCRATCH_EDGE_MS = 3;

/**
 * One source sample at a fractional position, Catmull-Rom (REQ-7).
 *
 * Linear is what the short-clip resampler uses, and it is audibly dull here: a
 * 0.25x stroke stretches the source four times, which is exactly where linear
 * interpolation's triangular kernel starts sounding like a lowpass.
 *
 * **Off the record is silence, not a held sample** (REQ-9). Clamping the read to
 * the last valid index is the obvious guard and it is wrong: it holds a DC value
 * for as long as the needle is away, which thumps on the way out and again on the
 * way back. Only the *neighbours* are clamped, and only inside the record, so a
 * read at the very first or last sample still interpolates instead of stepping.
 */
function readAt(ch: Float32Array, len: number, pos: number): number {
  const i = Math.floor(pos);
  if (i < 0 || i >= len) return 0;
  const f = pos - i;
  const y1 = ch[i]!;
  const y0 = i > 0 ? ch[i - 1]! : y1;
  const y2 = i + 1 < len ? ch[i + 1]! : y1;
  const y3 = i + 2 < len ? ch[i + 2]! : y2;
  return y1 + 0.5 * f * ((y2 - y0)
    + f * ((2 * y0 - 5 * y1 + 4 * y2 - y3)
      + f * (3 * (y1 - y2) + y3 - y0)));
}

/**
 * The same read, band-limited when the needle is moving faster than the record
 * (REQ-8).
 *
 * At rate `w` one output frame covers `w` source samples, and taking a single
 * point out of that span folds everything above `fs/w` back down as aliasing —
 * on a break that is a metallic buzz sitting on top of the push. Averaging the
 * span is a box filter whose first null is at `fs/w`, which is the cutoff the
 * rate actually calls for. `MAX_SCRATCH_RATE` bounds the loop at four taps.
 */
function readBandLimited(ch: Float32Array, len: number, pos: number, rate: number): number {
  const w = rate < 0 ? -rate : rate;
  if (w <= 1) return readAt(ch, len, pos);
  const taps = Math.min(MAX_SCRATCH_RATE, Math.ceil(w));
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    sum += readAt(ch, len, pos + ((k + 0.5) / taps - 0.5) * w);
  }
  return sum / taps;
}

/**
 * Print `curve` onto `a`, producing exactly `outFrames` frames (REQ-5).
 *
 * The target is taken as a frame count rather than a ratio because that is what
 * makes the result land on the bar: the caller computes
 * `round(steps × sixteenthDuration × sampleRate)` once, and a scratch that is a
 * frame short of the bar is the failure this feature exists to prevent.
 *
 * Total by contract (REQ-13): a non-finite or non-positive target, a target past
 * `MAX_STRETCH_OUTPUT_FRAMES`, an empty buffer or a curve with no usable points
 * all return a clone. The bound is checked **before** anything is allocated — the
 * curve alone does not bound the output when the length is supplied separately
 * (ADR-015).
 */
export function renderScratch(
  a: CapturedAudio,
  curve: ScratchCurve,
  outFrames: number,
): CapturedAudio {
  const len = Math.min(a.left.length, a.right.length);
  if (len === 0) return cloneCaptured(a);

  // Non-finite first: the app-wide `max(min, min(max, v))` idiom returns NaN for
  // NaN (untrusted-input.md REQ-6), so clamping would let it through to a length.
  if (!Number.isFinite(outFrames)) return cloneCaptured(a);
  const out = Math.round(outFrames);
  if (out <= 0 || out > MAX_STRETCH_OUTPUT_FRAMES) return cloneCaptured(a);

  const plan = scratchPlan(curve);
  if (plan.n === 0) return cloneCaptured(a);

  const left = new Float32Array(out);
  const right = new Float32Array(out);
  const cueFrames = plan.cue * len;

  // Per-frame gain step. The gate opens and closes at this rate and no faster.
  const slew = Math.max(1, Math.round((SCRATCH_GATE_MS / 1000) * a.sampleRate));
  const step = 1 / slew;
  // Start already open or already closed rather than sliding in from the wrong
  // value: a scratch that opens with a cut should begin in silence, not with a
  // 1.5 ms burst of the sample.
  let gain = cutIn(plan, 0) ? 0 : 1;

  let seg = 0;
  for (let i = 0; i < out; i++) {
    const t = i / out;
    seg = segmentAt(plan, t, seg);

    // Both channels read the SAME position (REQ-12). The rule time-stretch.md
    // REQ-5 records — decide from the mid, apply to both — is reached trivially
    // here because the map comes from the curve alone. Running this loop per
    // channel is the obvious refactor, it decorrelates them, and it is invisible
    // in a per-channel level check: it shows up only in the mono sum.
    const pos = cueFrames + positionIn(plan, seg, t) * out;
    const rate = rateIn(plan, seg, t);

    const target = cutIn(plan, seg) ? 0 : 1;
    const d = target - gain;
    gain += d > step ? step : d < -step ? -step : d;

    left[i] = readBandLimited(a.left, len, pos, rate) * gain;
    right[i] = readBandLimited(a.right, len, pos, rate) * gain;
  }

  const raw: CapturedAudio = { left, right, sampleRate: a.sampleRate };
  return fadeOut(fadeIn(raw, SCRATCH_EDGE_MS), SCRATCH_EDGE_MS);
}
