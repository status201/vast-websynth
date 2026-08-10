// Pure BPM ↔ note-division math. No DOM, no AudioContext, so it unit-tests
// directly under Vitest.
//
// Two consumers, which is why it lives in `utils/` rather than beside either of
// them: the UI's "sweet spots" info badges recommend a delay time (seconds) or
// an LFO/phaser/wah rate (Hz) that lines up with the current tempo
// (tempo-sync-help.md, advisory — those knobs stay free-valued), and the **audio
// layer** resolves `lfo.sync` to a real rate (lfo.md REQ-8). It started under
// `src/ui/onboarding/`, which the audio layer may not import from
// (architecture REQ-1, ADR-001) — the move is what let the LFO use it at all.

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
export { midiToHz as noteToHz } from './math';

/**
 * The `lfo.sync` value map (lfo.md REQ-9): index 0 is **free-running** — the
 * default, and an exact no-op — then one entry per division, in `DIVISIONS`
 * order. Append-only: an index here is a stored value in every preset, song and
 * share link, so reordering silently rewrites saved patches (the same rule
 * `LFO_DEST_LABELS` carries).
 */
export const SYNC_LABELS: string[] = ['free', ...DIVISIONS.map((d) => d.label)];

/**
 * The rate a synced LFO should run at, in Hz, or `null` when `syncIndex` is 0
 * (free) or out of range — in which case the caller keeps the knob's own rate.
 *
 * Guards a non-finite or non-positive BPM: `Clock.setBpm` already rejects those
 * (untrusted-input.md REQ-6), but this is reached from a param subscription that
 * a song payload can drive directly, and `1/0` would reach an `AudioParam`.
 */
export function syncedRateHz(syncIndex: number, bpm: number): number | null {
  const i = Math.round(syncIndex);
  if (i <= 0 || i > DIVISIONS.length) return null;
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  const seconds = DIVISIONS[i - 1]!.beats * (60 / bpm);
  return seconds > 0 ? 1 / seconds : null;
}
