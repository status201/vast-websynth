// Small numeric helpers shared across the audio, state and UI layers. Pure and
// dependency-free — previously copy-pasted per module.

/** Clamp `v` into `[min, max]`. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Clamp `v` into `[0, 1]` — the unit range most mix/depth/velocity params use. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** MIDI note number → frequency in Hz (A4 = note 69 = 440 Hz). */
export function midiToHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}
