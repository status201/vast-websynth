/**
 * Iterative in-place radix-2 complex FFT — the one piece of spectral machinery
 * the app owns (time-stretch.md REQ-1).
 *
 * Everything else spectral here is the platform's: `AnalyserNode` does the scope's
 * FFT on the audio thread, and it is useless for offline work because it only ever
 * reports magnitudes of *live* audio. The phase vocoder needs phase, and it needs
 * it on a stored buffer, so this exists. ADR-003 rules out an npm FFT; it is 60
 * lines, so that costs nothing.
 *
 * Pure, dependency-free and exported rather than kept private to `time-stretch.ts`
 * — an FFT that is wrong is wrong in ways an OLA test cannot localise, so it is
 * worth being able to assert `inverse(forward(x)) === x` on its own.
 */

/** Cached bit-reversal permutations and twiddles, keyed by transform length. */
const tables = new Map<number, { rev: Uint32Array; cos: Float64Array; sin: Float64Array }>();

function tablesFor(n: number): { rev: Uint32Array; cos: Float64Array; sin: Float64Array } {
  const hit = tables.get(n);
  if (hit) return hit;

  // Bit-reversal permutation. Built by the standard incremental trick rather than
  // by reversing each index: one add-with-carry per entry, no inner loop.
  const rev = new Uint32Array(n);
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }

  // Twiddles for a forward transform; the inverse conjugates them at use.
  // Float64 deliberately: the buffers are Float32, but accumulating a 2048-point
  // butterfly through 11 stages on float32 twiddles is where an audible noise
  // floor creeps in.
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }

  const made = { rev, cos, sin };
  tables.set(n, made);
  return made;
}

/** True when `n` is a positive power of two — the only lengths this transforms. */
export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/**
 * Transform `re`/`im` in place. `inverse` also applies the `1/n` scaling, so
 * `fftInPlace(re, im); fftInPlace(re, im, true)` round-trips to the input.
 *
 * Both arrays must be the same power-of-two length; a mismatch is a no-op rather
 * than a throw, because every caller here is reached from a user-supplied buffer
 * and this module keeps the "nothing throws" contract time-stretch.md REQ-6 makes.
 */
export function fftInPlace(re: Float32Array, im: Float32Array, inverse = false): void {
  const n = re.length;
  if (n !== im.length || !isPowerOfTwo(n) || n < 2) return;
  const { rev, cos, sin } = tablesFor(n);

  for (let i = 1; i < n; i++) {
    const r = rev[i]!;
    if (i < r) {
      const tr = re[i]!; re[i] = re[r]!; re[r] = tr;
      const ti = im[i]!; im[i] = im[r]!; im[r] = ti;
    }
  }

  const sign = inverse ? -1 : 1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const t = k * step;
        const wr = cos[t]!;
        const wi = sign * sin[t]!;
        const a = i + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }

  if (inverse) {
    const s = 1 / n;
    for (let i = 0; i < n; i++) { re[i] = re[i]! * s; im[i] = im[i]! * s; }
  }
}
