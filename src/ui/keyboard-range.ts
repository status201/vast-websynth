/**
 * How many octaves the on-screen keyboard draws, and which — keyboard-range.md.
 * Pure (no DOM), so the rule is tested apart from the component that draws it.
 */

/** The widest a white key may get before another octave is added — the 2560px
 *  look (keyboard-range.md REQ-the-range-follows-the-width). */
export const MAX_WHITE_PX = 120;

/** C1–B6. A seventh octave would sound past MIDI 127 at OCT +2
 *  (keyboard-range.md REQ-the-range-never-exceeds-midi). */
export const MAX_OCTAVES = 6;

/** C D E F G A B — the one place the keyboard's geometry counts them. */
export const WHITES_PER_OCTAVE = 7;

export interface KeyboardRange {
  startOctave: number;  // octave of the first white key (3 → C3)
  octaves: number;
}

/** Octave count → bottom octave, growing down first, then alternating
 *  (keyboard-range.md REQ-the-range-grows-down-first). Index = octaves. */
const START_OCTAVE: readonly number[] = [4, 4, 4, 3, 2, 2, 1];

export function keyboardRange(widthPx: number, phone: boolean): KeyboardRange {
  const base = phone ? 2 : 3;
  const wanted = Math.ceil(Math.max(0, widthPx) / (WHITES_PER_OCTAVE * MAX_WHITE_PX));
  const octaves = Math.min(MAX_OCTAVES, Math.max(base, wanted));
  return { startOctave: START_OCTAVE[octaves]!, octaves };
}

/** One white key's column — the key plus its margins — when `octaves` share
 *  `widthPx`, in whole px. What CSS bounds the key height by
 *  (keyboard-range.md REQ-key-height-follows-key-width). */
export function whiteKeyPx(widthPx: number, octaves: number): number {
  return Math.round(Math.max(0, widthPx) / (octaves * WHITES_PER_OCTAVE));
}
