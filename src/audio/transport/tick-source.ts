export type TickListener = (step: number, when: number) => void;

export interface TickSubscriber {
  readonly playing: boolean;
  readonly step: number;
  onTick(fn: TickListener): () => void;
  onStart(fn: () => void): () => void;
  onStop(fn: () => void): () => void;
  sixteenthDuration(): number;
  setBpm(bpm: number): void;
}
