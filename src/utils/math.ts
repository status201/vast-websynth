// Small numeric helpers shared across the audio, state and UI layers. Pure and
// dependency-free — previously copy-pasted per module.

/** Clamp `v` into `[min, max]`. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Round `v` and clamp it into `[min, max]`; a non-finite `v` gives `fallback`
 * (default `min`). `clamp` lets NaN through (NaN fails both comparisons), and a
 * NaN index or length poisons every modulo and array read downstream.
 */
export function clampInt(v: number, min: number, max: number, fallback = min): number {
  if (!Number.isFinite(v)) return fallback;
  const r = Math.round(v);
  return r < min ? min : r > max ? max : r;
}

/** Clamp `v` into `[0, 1]` — the unit range most mix/depth/velocity params use. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** MIDI note number → frequency in Hz (A4 = note 69 = 440 Hz). */
export function midiToHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}
