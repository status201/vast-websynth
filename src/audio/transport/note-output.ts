import type { BendShape } from '../../state/patterns';

/**
 * What a note carries beyond its pitch and velocity.
 *
 * Optional at every layer on purpose: the arpeggiator and live keyboard/MIDI
 * play omit it and are centred, exactly as they were before the sequencer's
 * per-track pan existed (sequencer.md REQ-a-seq-track-carries-a-pan).
 */
export interface NoteOptions {
  /** Stereo position, -1..1. */
  pan?: number;
  /** Which track's pan knob the voice should keep following while it sounds. */
  panGroup?: number;
  /** A per-note pitch bend (step-settings.md REQ-a-bend-is-per-voice). Absent =
   *  no bend; only the sequencer sets it. */
  bend?: NoteBend;
  /**
   * The held note this one CONTINUES rather than strikes: its voices move to the
   * new pitch with no envelope retrigger, or — when they are gone — it is released
   * and this note strikes as usual (voicing.md REQ-a-legato-note-takes-over-the-held-voices).
   * Only the sequencer's legato tie sets it (sequencer.md REQ-a-tie-continues-the-note-without-retriggering).
   */
  legatoFrom?: number;
}

/**
 * One note's bend, resolved by `stepBend` (step-settings.md
 * REQ-bend-shapes-are-scoop-and-fall): `semis` away from the note, arriving
 * (`scoop`) or leaving (`fall`) over `dur` seconds from the attack.
 */
export interface NoteBend {
  semis: number;
  shape: BendShape;
  dur: number;
}

export interface SynthOutput {
  playNote(note: number, velocity: number, when?: number, opts?: NoteOptions): void;
  releaseNote(note: number, when?: number): void;
}
