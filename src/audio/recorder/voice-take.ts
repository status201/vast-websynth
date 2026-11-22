/**
 * The arithmetic of the vocoder's voice take (vocoder.md), kept pure so it is
 * tested without a mic: the cue pass the singer hears, where in the raw capture
 * the carrier's pass was heard, and reading the voice from there with Offset.
 */
import type { CapturedAudio } from './node';
import { capturedFrames, crop } from './buffer-dsp';

/** How long the take runs past the end of the carrier's pass, beyond latency and Offset. */
export const VOICE_TAKE_MARGIN_S = 0.2;
/** Each latency term is clamped to this: past it, the device report is not a latency. */
const MAX_LATENCY_TERM_S = 0.5;

/**
 * The cue followed by the whole carrier (REQ-the-voice-take-follows-the-carrier). The
 * cue is the carrier's last `min(carrier, barFrames)` — so a one-bar loop plays
 * twice, and a long carrier never makes the singer wait through all of it.
 */
export function buildCuePass(carrier: CapturedAudio, barFrames: number): { audio: CapturedAudio; cueFrames: number } {
  const n = capturedFrames(carrier);
  const bar = Number.isFinite(barFrames) ? Math.max(1, Math.round(barFrames)) : n;
  const cueFrames = Math.min(n, bar);
  const cue = crop(carrier, n - cueFrames, n);
  const join = (a: Float32Array, b: Float32Array): Float32Array => {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };
  return {
    audio: {
      left: join(cue.left, carrier.left.subarray(0, n)),
      right: join(cue.right, carrier.right.subarray(0, n)),
      sampleRate: carrier.sampleRate,
    },
    cueFrames,
  };
}

const term = (v: number | undefined): number =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_LATENCY_TERM_S, Math.max(0, v)) : 0);

/**
 * The round trip from the carrier leaving the context to the voice arriving in
 * it (REQ-the-voice-take-is-cropped-frame-exact): the output latency (or, where
 * a browser does not report it, the base latency) plus the mic's input latency.
 */
export function autoLatency(r: { outputLatency?: number; baseLatency?: number; inputLatency?: number }): number {
  const out = typeof r.outputLatency === 'number' && Number.isFinite(r.outputLatency) && r.outputLatency > 0
    ? term(r.outputLatency)
    : term(r.baseLatency);
  return out + term(r.inputLatency);
}

/** Frame of the raw take where the carrier's pass was heard, Offset 0. */
export function takeStartFrame(o: { takeAt: number; latency: number; sampleRate: number; firstFrame: number }): number {
  return Math.round((o.takeAt + o.latency) * o.sampleRate) - o.firstFrame;
}

/**
 * Exactly `frames` of `raw` from `start`, silence where that runs past either
 * end (REQ-the-offset-slides-the-voice-without-re-recording).
 */
export function readVoice(raw: CapturedAudio, start: number, frames: number): CapturedAudio {
  const n = Math.max(0, Math.floor(frames));
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const len = capturedFrames(raw);
  const s = Math.round(Number.isFinite(start) ? start : 0);
  const from = Math.max(0, s);
  const to = Math.min(len, s + n);
  if (to > from) {
    left.set(raw.left.subarray(from, to), from - s);
    right.set(raw.right.subarray(from, to), from - s);
  }
  return { left, right, sampleRate: raw.sampleRate };
}
