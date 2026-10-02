import type { BendShape } from '../../state/patterns';

/**
 * What a note carries beyond its pitch and velocity.
 *
 * Optional at every layer on purpose: the arpeggiator and live keyboard/MIDI
 * play omit it and are centred, exactly as they were before the sequencer's
 * per-track pan existed (sequencer.md REQ-a-seq-track-carries-a-pan).
 */
export interface NoteOpts {
  /** Stereo position, -1..1. */
  pan?: number;
  /** Which track's pan knob the voice should keep following while it sounds. */
  panGroup?: number;
  /** A per-note pitch bend (step-settings.md REQ-a-bend-is-per-voice). Absent =
   *  no bend; only the sequencer sets it. */
  bend?: NoteBend;
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
  playNote(note: number, velocity: number, when?: number, opts?: NoteOpts): void;
  releaseNote(note: number, when?: number): void;
}
