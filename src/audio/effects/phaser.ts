import { BypassWrapper, type Effect } from './effect';

const STAGES = 4;

export class Phaser implements Effect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  private readonly wrap: BypassWrapper;
  private readonly stages: BiquadFilterNode[];
  private readonly lfo: OscillatorNode;
  private readonly lfoDepth: GainNode;
  private readonly feedback: GainNode;
  private readonly fbDelay: DelayNode;
  private readonly inGain: GainNode;

  private depthOct = 1.5;

  constructor(private readonly ctx: AudioContext) {
    this.wrap = new BypassWrapper(ctx, 0.5);
    this.input = this.wrap.input;
    this.output = this.wrap.output;

    this.stages = [];
    for (let i = 0; i < STAGES; i++) {
      const f = ctx.createBiquadFilter();
      f.type = 'allpass';
      f.frequency.value = 600 * Math.pow(2, i * 0.3);
      f.Q.value = 1;
      this.stages.push(f);
    }

    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.5;

    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = this.depthHz();

    // LFO modulates each stage's frequency (additively around its center)
    for (const s of this.stages) {
      this.lfo.connect(this.lfoDepth).connect(s.frequency);
    }
    this.lfo.start();

    this.inGain = ctx.createGain();
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.4;
    // A DelayNode is required in the feedback cycle: Web Audio mutes any cycle
    // that lacks one. Short enough to read as resonance, not an echo.
    this.fbDelay = ctx.createDelay(0.05);
    this.fbDelay.delayTime.value = 0.003;

    this.wrap.processedIn.connect(this.inGain);
    let prev: AudioNode = this.inGain;
    for (const s of this.stages) {
      prev.connect(s);
      prev = s;
    }
    prev.connect(this.wrap.processedOut);
    // Feedback: last stage → delay → input
    prev.connect(this.feedback);
    this.feedback.connect(this.fbDelay);
    this.fbDelay.connect(this.inGain);
  }

  setBypass(b: boolean): void { this.wrap.setBypass(b); }
  setMix(m: number): void { this.wrap.setMix(m); }
  setRate(hz: number): void {
    this.lfo.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
  }
  setDepth(d: number): void {
    this.depthOct = Math.max(0, Math.min(1, d)) * 2;
    this.lfoDepth.gain.setTargetAtTime(this.depthHz(), this.ctx.currentTime, 0.02);
  }
  setFeedback(f: number): void {
    this.feedback.gain.setTargetAtTime(Math.max(0, Math.min(0.95, f)), this.ctx.currentTime, 0.02);
  }

  private depthHz(): number {
    // Sweep the center frequency by ~1500 Hz at full depth
    return this.depthOct * 750;
  }
}
