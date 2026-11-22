import type { CapturedAudio } from '../../src/audio/recorder/node';

/** The rate the offline-DSP suites render at. */
export const SR = 48000;

/** A take from a left channel (and a right, else a copy of the left). */
export function cap(left: Float32Array, right?: Float32Array, sampleRate = SR): CapturedAudio {
  return { left, right: right ?? left.slice(), sampleRate };
}

/** A steady sine of `hz`, `frames` long. */
export function sine(hz: number, frames: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/**
 * Fundamental frequency by autocorrelation, over the buffer's steady middle,
 * searched between 50 Hz and `maxHz`.
 *
 * Zero-crossing counting is cheaper but rides on DC and on the amplitude ripple an
 * overlap-add leaves behind; autocorrelation measures the period the signal
 * actually repeats at, which is the thing a claim about pitch is a claim about.
 */
export function estimateHz(x: Float32Array, { sampleRate = SR, maxHz = 2000 } = {}): number {
  const from = Math.floor(x.length * 0.25);
  const to = Math.floor(x.length * 0.75);
  const n = to - from;
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.floor(sampleRate / 50);
  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
    let dot = 0;
    let energy = 0;
    for (let i = 0; i + lag < n; i++) {
      dot += x[from + i]! * x[from + i + lag]!;
      energy += x[from + i + lag]! * x[from + i + lag]!;
    }
    const score = energy > 1e-12 ? dot / Math.sqrt(energy) : 0;
    if (score > best) { best = score; bestLag = lag; }
  }
  return sampleRate / bestLag;
}

/** Every sample finite. */
export function allFinite(x: Float32Array): boolean {
  for (const v of x) if (!Number.isFinite(v)) return false;
  return true;
}
