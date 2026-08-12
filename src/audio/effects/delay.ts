import { WrappedEffect, bindBypassMix } from './effect';
import { RAMP_SMOOTH } from '../param-utils';
import type { ParamBus } from '../../state/params';

export class Delay extends WrappedEffect {
  private readonly delay: DelayNode;
  private readonly feedback: GainNode;
  private readonly damp: BiquadFilterNode;

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
    this.feedback.gain.setTargetAtTime(Math.max(0, Math.min(0.95, f)), this.ctx.currentTime, RAMP_SMOOTH);
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    bus.subscribe(`${prefix}.time`, (x) => this.setTime(x));
    bus.subscribe(`${prefix}.feedback`, (x) => this.setFeedback(x));
  }
}
