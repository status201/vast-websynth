export interface SynthOutput {
  playNote(note: number, velocity: number, when?: number): void;
  releaseNote(note: number, when?: number): void;
}
