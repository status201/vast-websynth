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
}

export interface SynthOutput {
  playNote(note: number, velocity: number, when?: number, opts?: NoteOpts): void;
  releaseNote(note: number, when?: number): void;
}
