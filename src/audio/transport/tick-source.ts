export type TickListener = (step: number, when: number) => void;

export interface TickSubscriber {
  readonly playing: boolean;
  readonly step: number;
  onTick(fn: TickListener): () => void;
  onStart(fn: () => void): () => void;
  onStop(fn: () => void): () => void;
  /** The playhead jumped: `step` changed without the grid advancing. Consumers
   *  that track position *relatively* must re-base here (transport-position.md
   *  REQ-4). Like `onStart`, subscribers read `step` themselves. */
  onSeek(fn: () => void): () => void;
  sixteenthDuration(): number;
  setBpm(bpm: number): void;
  start(): void;
  stop(): void;
}
