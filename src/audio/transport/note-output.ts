export interface SynthOutput {
  playNote(note: number, velocity: number, when?: number): void;
  releaseNote(note: number, when?: number): void;
}

export interface TransportContext {
  readonly ctx: AudioContext;
  readonly drumBus: GainNode;
  readonly samplerBus: GainNode;
}
