import { createControlSmoother } from './lfo';

/**
 * The mod matrix's `random` source: one value held per clock tick
 * (mod-matrix.md REQ-an-unselected-source-costs-nothing), reaching the matrix
 * through the LFO's control smoother (REQ-random-steps-are-smoothed).
 *
 * The value is a `ConstantSourceNode` written with `setValueAtTime`, so each
 * roll is a step. Raw, that step landed at full bandwidth on whatever the route
 * drives — into amp, a click every 16th. Smoothed, it is a ~3 ms slew: still a
 * sample-&-hold to the ear, with no overshoot past the value rolled.
 */
export class SampleHold {
  /** What the matrix reads: the held value, smoothed. */
  readonly out: AudioNode;
  private readonly src: ConstantSourceNode;

  constructor(ctx: BaseAudioContext) {
    this.src = ctx.createConstantSource();
    this.src.offset.value = 0;
    const smooth = createControlSmoother(ctx);
    this.src.connect(smooth);
    this.src.start();
    this.out = smooth;
  }

  /** Hold `value` from `when` on — the tick's own time, so it lands with the beat. */
  roll(value: number, when: number): void {
    this.src.offset.setValueAtTime(value, when);
  }
}
