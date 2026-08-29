import { WrappedEffect, bindBypassMix } from './effect';
import { RAMP_SMOOTH } from '../param-utils';
import { bindTempoLocked } from '../tempo-bind';
import type { ParamBus } from '../../state/params';

export class Delay extends WrappedEffect {
  private readonly delay: DelayNode;
  private readonly feedback: GainNode;
  private readonly damp: BiquadFilterNode;
  /** Last commanded feedback, held across a quiesce so it can be restored. */
  private fb = 0.4;
  private quiesced = false;

  constructor(ctx: AudioContext) {
    super(ctx, 0.3);

    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = 0.35;

    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.4;

    this.damp = ctx.createBiquadFilter();
    this.damp.type = 'lowpass';
    this.damp.frequency.value = 4500;
    this.damp.Q.value = 0.707;

    // input → delay → damp → feedback → delay (loop)
    //                 ↘ processedOut
    this.wrap.processedIn.connect(this.delay);
    this.delay.connect(this.damp);
    this.damp.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.damp.connect(this.wrap.processedOut);
  }

  setMix(m: number): void { this.wrap.setMix(m); }
  setTime(s: number): void {
    this.delay.delayTime.setTargetAtTime(Math.max(0.001, Math.min(2, s)), this.ctx.currentTime, RAMP_SMOOTH);
  }
  setFeedback(f: number): void {
    // Recorded even while quiesced, so `quiesce(false)` restores what the knob
    // says now rather than what it said when the effect was bypassed.
    this.fb = Math.max(0, Math.min(0.95, f));
    if (this.quiesced) return;
    this.feedback.gain.setTargetAtTime(this.fb, this.ctx.currentTime, RAMP_SMOOTH);
  }

  /**
   * The whole 2 s of `createDelay(2)`: fed silence for that long, every sample
   * in the ring buffer has been overwritten, whatever the read pointer is doing
   * (effects.md REQ-2c).
   */
  protected override drainSeconds(): number { return 2; }

  /**
   * Feedback is what stops a delay line ever emptying — at 0.95 the content
   * recirculates indefinitely and no finite drain would clear it. Set directly,
   * not ramped: the wet path is already at zero, so there is nothing to hear.
   */
  protected override quiesce(on: boolean): void {
    this.quiesced = on;
    this.feedback.gain.cancelScheduledValues(this.ctx.currentTime);
    this.feedback.gain.setValueAtTime(on ? 0 : this.fb, this.ctx.currentTime);
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    bindTempoLocked(bus, `${prefix}.time`, `${prefix}.sync`, 'time', (x) => this.setTime(x));
    bus.subscribe(`${prefix}.feedback`, (x) => this.setFeedback(x));
  }
}
