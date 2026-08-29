import { WrappedEffect, bindBypassMix } from './effect';
import { clamp01 } from '../../utils/math';
import { RAMP_SMOOTH } from '../param-utils';
import { bindTempoLocked } from '../tempo-bind';
import type { ParamBus } from '../../state/params';

const STAGES = 4;

export class Phaser extends WrappedEffect {
  private readonly stages: BiquadFilterNode[];
  private readonly lfo: OscillatorNode;
  private readonly lfoDepth: GainNode;
  private readonly feedback: GainNode;
  private readonly fbDelay: DelayNode;
  /** Last commanded feedback, held across a quiesce so it can be restored. */
  private fb = 0.4;
  private quiesced = false;
  private readonly inGain: GainNode;

  private depthOct = 1.5;

  constructor(ctx: AudioContext) {
    super(ctx, 0.5);

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

  setMix(m: number): void { this.wrap.setMix(m); }
  setRate(hz: number): void {
    this.lfo.frequency.setTargetAtTime(hz, this.ctx.currentTime, RAMP_SMOOTH);
  }
  setDepth(d: number): void {
    this.depthOct = clamp01(d) * 2;
    this.lfoDepth.gain.setTargetAtTime(this.depthHz(), this.ctx.currentTime, RAMP_SMOOTH);
  }
  setFeedback(f: number): void {
    // Recorded even while quiesced, so the restore lands on the current knob.
    this.fb = Math.max(0, Math.min(0.95, f));
    if (this.quiesced) return;
    this.feedback.gain.setTargetAtTime(this.fb, this.ctx.currentTime, RAMP_SMOOTH);
  }

  /**
   * The allpass chain is memoryless in practice; what holds audio is the 0.05 s
   * feedback loop, which with feedback zeroed is empty within one pass
   * (effects.md REQ-2c). 0.1 s is that with room to spare.
   */
  protected override drainSeconds(): number { return 0.1; }

  protected override quiesce(on: boolean): void {
    this.quiesced = on;
    this.feedback.gain.cancelScheduledValues(this.ctx.currentTime);
    this.feedback.gain.setValueAtTime(on ? 0 : this.fb, this.ctx.currentTime);
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    bindTempoLocked(bus, `${prefix}.rate`, `${prefix}.sync`, 'freq', (x) => this.setRate(x));
    bus.subscribe(`${prefix}.depth`, (x) => this.setDepth(x));
    bus.subscribe(`${prefix}.feedback`, (x) => this.setFeedback(x));
  }

  private depthHz(): number {
    // Sweep the center frequency by ~1500 Hz at full depth
    return this.depthOct * 750;
  }
}
