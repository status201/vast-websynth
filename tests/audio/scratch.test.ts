import { describe, it, expect } from 'vitest';
import { renderScratch } from '../../src/audio/recorder/scratch';
import { scratchPreset, type ScratchCurve } from '../../src/audio/recorder/scratch-curve';
import { reverse } from '../../src/audio/recorder/buffer-dsp';
import { MAX_STRETCH_OUTPUT_FRAMES } from '../../src/state/limits';
import type { CapturedAudio } from '../../src/audio/recorder/node';

const SR = 48000;

type Row = [t: number, v: number, cut?: boolean, hold?: boolean];

function curve(rows: readonly Row[], steps = 16, cue = 0): ScratchCurve {
  return {
    steps,
    cue,
    points: rows.map(([t, v, cut = false, hold = false]) => ({ t, v, cut, hold })),
  };
}

function cap(left: Float32Array, right?: Float32Array, sampleRate = SR): CapturedAudio {
  return { left, right: right ?? left.slice(), sampleRate };
}

function sine(hz: number, frames: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/** Deterministic broadband noise — a scratch's real material is not a sine. */
function noise(frames: number, seed = 1): Float32Array {
  const out = new Float32Array(frames);
  let s = seed;
  for (let i = 0; i < frames; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return out;
}

/**
 * Fundamental by autocorrelation over the steady middle — the same estimator
 * `time-stretch.test.ts` justifies: zero-crossing counting rides on DC and on
 * ripple, while autocorrelation measures the period the signal repeats at, which
 * is what a claim about pitch is a claim about.
 */
function estimateHz(x: Float32Array, sampleRate = SR): number {
  const from = Math.floor(x.length * 0.25);
  const to = Math.floor(x.length * 0.75);
  const n = to - from;
  const minLag = Math.floor(sampleRate / 4000);
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

function rms(x: Float32Array, from = 0, to = x.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}

function monoRms(a: CapturedAudio): number {
  let sum = 0;
  const n = Math.min(a.left.length, a.right.length);
  for (let i = 0; i < n; i++) {
    const m = (a.left[i]! + a.right[i]!) * 0.5;
    sum += m * m;
  }
  return Math.sqrt(sum / Math.max(1, n));
}

/** Largest sample-to-sample step — a click is a step, whatever caused it. */
function maxStep(x: Float32Array, from = 0, to = x.length): number {
  let m = 0;
  for (let i = from + 1; i < to; i++) {
    const d = Math.abs(x[i]! - x[i - 1]!);
    if (d > m) m = d;
  }
  return m;
}

function allFinite(x: Float32Array): boolean {
  for (const v of x) if (!Number.isFinite(v)) return false;
  return true;
}

describe('renderScratch — length', () => {
  it('is exactly the frame count it was given', () => {
    const src = cap(noise(20_000));
    for (const out of [1, 999, 12_345, 60_000]) {
      const r = renderScratch(src, scratchPreset('Baby', 16), out);
      expect(r.left.length).toBe(out);
      expect(r.right.length).toBe(out);
    }
  });

  it('rounds a fractional target rather than truncating toward a short bar', () => {
    const r = renderScratch(cap(noise(5000)), curve([[0, 1]]), 4000.6);
    expect(r.left.length).toBe(4001);
  });

  it('keeps the source sample rate', () => {
    const r = renderScratch(cap(noise(4000), undefined, 44_100), curve([[0, 1]]), 2000);
    expect(r.sampleRate).toBe(44_100);
  });
});

describe('renderScratch — pitch rides speed', () => {
  it('a double-rate stroke is an octave up', () => {
    const src = cap(sine(440, SR));
    const r = renderScratch(src, curve([[0, 2]]), SR / 2);
    expect(estimateHz(r.left)).toBeGreaterThan(830);
    expect(estimateHz(r.left)).toBeLessThan(930);
  });

  it('a half-rate stroke is an octave down', () => {
    const src = cap(sine(440, SR / 2));
    const r = renderScratch(src, curve([[0, 0.5]]), SR / 2);
    expect(estimateHz(r.left)).toBeGreaterThan(205);
    expect(estimateHz(r.left)).toBeLessThan(235);
  });

  it('is not a time-stretch — the pitch moved, which is the whole point', () => {
    const src = cap(sine(440, SR));
    const r = renderScratch(src, curve([[0, 2]]), SR / 2);
    expect(Math.abs(estimateHz(r.left) - 440)).toBeGreaterThan(200);
  });
});

describe('renderScratch — the identity cases', () => {
  it('a flat unity curve reproduces the source', () => {
    const src = cap(noise(8000));
    const r = renderScratch(src, curve([[0, 1]]), 8000);
    // The edge fades touch the first and last few ms (REQ-11), so compare the body.
    for (let i = 500; i < 7500; i += 37) {
      expect(r.left[i]!).toBeCloseTo(src.left[i]!, 5);
    }
  });

  it('a flat negative curve cued at the end plays it backwards', () => {
    const len = 8000;
    const src = cap(noise(len));
    const rev = reverse(src);
    const r = renderScratch(src, curve([[0, -1]], 16, (len - 1) / len), len);
    for (let i = 500; i < len - 500; i += 37) {
      expect(r.left[i]!).toBeCloseTo(rev.left[i]!, 5);
    }
  });
});

describe('renderScratch — the crossfader', () => {
  const cut = curve([
    [0, 1, false, true], [1 / 3, 1, true, true], [2 / 3, 1, false, true],
  ]);

  it('silences a cut segment', () => {
    const src = cap(sine(200, 24_000));
    const r = renderScratch(src, cut, 24_000);
    expect(rms(r.left, 9000, 15_000)).toBeLessThan(1e-6);
    expect(rms(r.left, 1000, 7000)).toBeGreaterThan(0.5);
    expect(rms(r.left, 17_000, 23_000)).toBeGreaterThan(0.5);
  });

  it('does not click at either edge of the cut', () => {
    const src = cap(sine(200, 24_000));
    const r = renderScratch(src, cut, 24_000);
    // A hard multiply would step by up to the sample value itself (~1.0 here).
    // The slew keeps every step near what the waveform alone already does.
    const plain = renderScratch(src, curve([[0, 1]]), 24_000);
    expect(maxStep(r.left)).toBeLessThan(maxStep(plain.left) + 0.05);
    expect(maxStep(r.left)).toBeLessThan(0.1);
  });

  it('opens in silence when the scratch begins cut', () => {
    const src = cap(sine(200, 12_000));
    const r = renderScratch(src, curve([[0, 1, true, true], [0.5, 1, false, true]]), 12_000);
    expect(rms(r.left, 200, 5000)).toBeLessThan(1e-6);
  });
});

describe('renderScratch — off the record', () => {
  it('is silent while the needle is away, and comes back', () => {
    const len = 24_000;
    const src = cap(sine(300, len));
    // Cued halfway, pulled hard off the front, then pushed back home.
    const c = curve([[0, -2, false, true], [0.5, 2, false, true]], 16, 0.5);
    const r = renderScratch(src, c, len);
    expect(rms(r.left, 11_000, 13_000)).toBe(0);           // exactly silent, not held
    expect(rms(r.left, 500, 4000)).toBeGreaterThan(0.3);   // on the record on the way out
    expect(rms(r.left, 20_000, 23_000)).toBeGreaterThan(0.3); // and again on the way back
  });

  it('holds no DC while off the record', () => {
    const src = cap(sine(300, 8000));
    // A constant-1 source would expose a clamped read as a held 1.0.
    const flat = cap(new Float32Array(8000).fill(1));
    const c = curve([[0, -1]], 16, 0);
    expect(rms(renderScratch(flat, c, 8000).left, 2000, 7000)).toBe(0);
    expect(allFinite(renderScratch(src, c, 8000).left)).toBe(true);
  });
});

describe('renderScratch — the stereo image', () => {
  it('keeps the mono level of correlated channels', () => {
    const a = noise(16_000, 7);
    const b = noise(16_000, 99);
    const l = new Float32Array(16_000);
    const r = new Float32Array(16_000);
    for (let i = 0; i < 16_000; i++) {
      l[i] = a[i]! * 0.8 + b[i]! * 0.2;
      r[i] = a[i]! * 0.8 - b[i]! * 0.2;
    }
    const src = cap(l, r);
    const out = renderScratch(src, curve([[0, 1]]), 16_000);
    const ratio = monoRms(out) / monoRms(src);
    // Anything that decorrelated the channels would show up here and nowhere
    // else — each channel on its own would still measure its usual level.
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it('reads each channel through the same map and nothing else', () => {
    const x = noise(6000, 3);
    const y = noise(6000, 4);
    const c = scratchPreset('Flare', 16);
    const withY = renderScratch(cap(x, y), c, 6000);
    const withX = renderScratch(cap(x, x.slice()), c, 6000);
    // The left channel must not depend on what the right one contained.
    for (let i = 0; i < 6000; i += 17) {
      expect(withY.left[i]!).toBe(withX.left[i]!);
    }
  });
});

describe('renderScratch — totality', () => {
  const src = cap(noise(4000));
  const same = (r: CapturedAudio): void => {
    expect(r.left.length).toBe(src.left.length);
    expect(Array.from(r.left.slice(0, 32))).toEqual(Array.from(src.left.slice(0, 32)));
  };

  it('refuses a non-finite length', () => {
    same(renderScratch(src, curve([[0, 1]]), NaN));
    same(renderScratch(src, curve([[0, 1]]), Infinity));
  });

  it('refuses a zero or negative length', () => {
    same(renderScratch(src, curve([[0, 1]]), 0));
    same(renderScratch(src, curve([[0, 1]]), -1000));
  });

  it('refuses a length past the frame bound before allocating it', () => {
    same(renderScratch(src, curve([[0, 1]]), MAX_STRETCH_OUTPUT_FRAMES + 1));
  });

  it('refuses an empty curve', () => {
    same(renderScratch(src, curve([]), 2000));
  });

  it('refuses an empty buffer', () => {
    const empty = cap(new Float32Array(0));
    const r = renderScratch(empty, curve([[0, 1]]), 2000);
    expect(r.left.length).toBe(0);
  });

  it('survives hostile curve values without throwing or emitting NaN', () => {
    const hostile: ScratchCurve = {
      steps: NaN,
      cue: Infinity,
      points: [
        { t: NaN, v: 1, cut: false, hold: false },
        { t: 0.5, v: 1e9, cut: false, hold: false },
        { t: -3, v: -1e9, cut: true, hold: true },
      ],
    };
    const r = renderScratch(src, hostile, 3000);
    expect(r.left.length).toBe(3000);
    expect(allFinite(r.left)).toBe(true);
    expect(allFinite(r.right)).toBe(true);
  });

  it('every preset renders finite audio at a hostile length', () => {
    for (const name of ['Baby', 'Transformer', 'Chirp', 'Tear', 'Flare', 'Scribble', 'Stab'] as const) {
      const r = renderScratch(cap(noise(3000)), scratchPreset(name, 16), 5000);
      expect(r.left.length).toBe(5000);
      expect(allFinite(r.left)).toBe(true);
      expect(Math.max(...Array.from(r.left).map(Math.abs))).toBeLessThanOrEqual(2);
    }
  });
});

describe('renderScratch — anti-aliasing', () => {
  it('a fast stroke over bright material is quieter up top, not buzzier', () => {
    // Near-Nyquist content read at 4x has nowhere to go but back down the
    // spectrum. The box average is what stops that landing as a buzz.
    const len = 24_000;
    const bright = new Float32Array(len);
    for (let i = 0; i < len; i++) bright[i] = i % 2 === 0 ? 0.9 : -0.9;
    const r = renderScratch(cap(bright), curve([[0, 4]]), 6000);
    // Averaged over its span, an alternating source cancels rather than folding
    // down into an audible tone.
    expect(rms(r.left, 1000, 5000)).toBeLessThan(0.5);
    expect(allFinite(r.left)).toBe(true);
  });
});
