import { BypassWrapper, type Effect } from './effect';

export class Delay implements Effect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  private readonly wrap: BypassWrapper;
  private readonly delay: DelayNode;
  private readonly feedback: GainNode;
  private readonly damp: BiquadFilterNode;

  constructor(private readonly ctx: AudioContext) {
    this.wrap = new BypassWrapper(ctx, 0.3);
    this.input = this.wrap.input;
    this.output = this.wrap.output;

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

  setBypass(b: boolean): void { this.wrap.setBypass(b); }
  setMix(m: number): void { this.wrap.setMix(m); }
  setTime(s: number): void {
    this.delay.delayTime.setTargetAtTime(Math.max(0.001, Math.min(2, s)), this.ctx.currentTime, 0.02);
  }
  setFeedback(f: number): void {
    this.feedback.gain.setTargetAtTime(Math.max(0, Math.min(0.95, f)), this.ctx.currentTime, 0.02);
  }
}
