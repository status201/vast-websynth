// Pure BPM ↔ note-division math for the "sweet spots" info badges. No DOM, no
// AudioContext, so it unit-tests directly under Vitest. The badges recommend a
// delay time (seconds) or an LFO/phaser/wah rate (Hz) that lines up with the
// current tempo — it is advisory only, the knobs stay free-valued.

/** A musical note division expressed in quarter-note beats. */
export interface Division {
  /** Display label, e.g. "1/8", "1/8 D" (dotted), "1/4 T" (triplet). */
  label: string;
  /** Length in quarter-note beats (1 = a quarter note). */
  beats: number;
}

/** Whether a knob wants a delay TIME (seconds) or a RATE (Hz). */
export type TempoQuantity = 'time' | 'freq';

/** A note division resolved to concrete seconds + frequency at a given BPM. */
export interface SweetSpot {
  label: string;
  beats: number;
  /** Period in seconds — a delay time, or one LFO cycle. */
  seconds: number;
  /** Frequency in Hz (1 / seconds) — the matching LFO/phaser/wah rate. */
  hz: number;
}

// Straight divisions as quarter-note beat counts (whole … 1/32).
const STRAIGHT: Division[] = [
  { label: '1/1', beats: 4 },
  { label: '1/2', beats: 2 },
  { label: '1/4', beats: 1 },
  { label: '1/8', beats: 0.5 },
  { label: '1/16', beats: 0.25 },
  { label: '1/32', beats: 0.125 },
];

const DOTTED_MUL = 1.5; // dotted note = one-and-a-half times the straight length
const TRIPLET_MUL = 2 / 3; // triplet = two-thirds of the straight length

/** The full straight + dotted + triplet division table (definition order). */
export const DIVISIONS: Division[] = STRAIGHT.flatMap((d) => [
  { label: d.label, beats: d.beats },
  { label: `${d.label} D`, beats: d.beats * DOTTED_MUL },
  { label: `${d.label} T`, beats: d.beats * TRIPLET_MUL },
]);

/** Every division resolved to seconds + Hz at `bpm` (a quarter note = 60/bpm s). */
export function sweetSpots(bpm: number): SweetSpot[] {
  const beat = 60 / bpm;
  return DIVISIONS.map((d) => {
    const seconds = d.beats * beat;
    return { label: d.label, beats: d.beats, seconds, hz: 1 / seconds };
  });
}

/** Pick the quantity a `TempoQuantity` selects from a resolved spot. */
export function spotValue(s: SweetSpot, quantity: TempoQuantity): number {
  return quantity === 'time' ? s.seconds : s.hz;
}

/**
 * The sweet spots whose value (seconds for 'time', Hz for 'freq') falls inside
 * `[min, max]`, sorted ascending by that value.
 */
export function sweetSpotsInRange(
  bpm: number,
  min: number,
  max: number,
  quantity: TempoQuantity,
): SweetSpot[] {
  return sweetSpots(bpm)
    .filter((s) => {
      const v = spotValue(s, quantity);
      return v >= min && v <= max;
    })
    .sort((a, b) => spotValue(a, quantity) - spotValue(b, quantity));
}

/** MIDI note number → frequency in Hz (A4 = note 69 = 440 Hz). */
export { midiToHz as noteToHz } from '../../utils/math';
