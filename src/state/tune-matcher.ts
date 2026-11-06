/**
 * Recognises a melody played on the instrument by its intervals
 * (rickroll-easter-egg.md REQ-the-hook-is-matched-by-intervals). Pure: no DOM,
 * no clock. The caller passes each note-on's time in.
 */

/**
 * "Never gonna give you up": A♭ B♭ D♭ B♭ F F E♭, as the six steps between its
 * seven notes. Intervals, so any key and any octave match.
 */
export const HOOK_INTERVALS: readonly number[] = [2, 3, -3, 7, 0, -2];

/** The longest pause allowed between two notes of the phrase (REQ-the-hook-allows-a-slow-player). */
export const HOOK_MAX_GAP_MS = 1500;

export interface TuneMatcher {
  /** Feed one note-on. True on the note that completes the phrase. */
  feed(note: number, timeMs: number): boolean;
  /** Forget everything fed so far. */
  reset(): void;
}

export function createTuneMatcher(intervals: readonly number[], maxGapMs: number): TuneMatcher {
  const length = intervals.length + 1;
  let notes: number[] = [];
  let lastTime = -Infinity;

  const matches = (): boolean => {
    if (notes.length < length) return false;
    for (let i = 0; i < intervals.length; i++) {
      if (notes[i + 1]! - notes[i]! !== intervals[i]) return false;
    }
    return true;
  };

  return {
    feed(note, timeMs) {
      // A pause breaks the phrase: the note after it starts a new one.
      if (timeMs - lastTime > maxGapMs) notes = [];
      lastTime = timeMs;
      notes.push(note);
      if (notes.length > length) notes.shift();
      if (!matches()) return false;
      // A match consumes its notes (REQ-a-match-consumes-the-phrase).
      notes = [];
      return true;
    },
    reset() {
      notes = [];
      lastTime = -Infinity;
    },
  };
}
