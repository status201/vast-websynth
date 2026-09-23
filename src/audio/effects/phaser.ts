import { WrappedEffect, bindBypassMix } from './effect';
import { clamp01 } from '../../utils/math';
import { RAMP_SMOOTH } from '../param-utils';
import { bindTempoLocked } from '../tempo-bind';
import type { ParamBus } from '../../state/params';

const STAGES = 4;

/**
 * The swing the v1 linear-Hz mapping gave at full depth. Kept only so
 * `stageCents` can reproduce that mapping's top exactly — see
 * effects.md REQ-the-phaser-sweeps-in-cents.
 */
const SWEEP_TOP_HZ = 1500;

/**
 * One stage's LFO swing, in **cents** (effects.md REQ-the-phaser-sweeps-in-cents,
 * ADR-005). The v1 mapping added `depth * 1500` linear Hz to every stage, which
 * drove any stage centred under the swing to the 0 Hz floor for part of each
 * cycle — an allpass there is a pass-through, so the stage dropped out of the
 * phaser. This is the cents equivalent of that old *upward* excursion, so the
 * top of every stage's sweep is exactly where it was and only the bottom moves.
 * Per stage, because the stages have different centres.
 */
export function stageCents(depth: number, centreHz: number): number {
  return 1200 * Math.log2(1 + depth * SWEEP_TOP_HZ / centreHz);
}

export class Phaser extends WrappedEffect {
  private readonly stages: BiquadFilterNode[];
  private readonly lfo: OscillatorNode;
  /** One swing per stage, in cents on its `detune` (REQ-the-phaser-sweeps-in-cents). */
  private readonly lfoDepths: GainNode[] = [];
  private readonly feedback: GainNode;
  private readonly fbDelay: DelayNode;
  /** Last commanded feedback, held across a quiesce so it can be restored. */
  private fb = 0.4;
  private quiesced = false;
  private readonly inGain: GainNode;

  private depth = 0.75;

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

    // The LFO sweeps each stage's detune, in cents, around a centre `frequency`
    // written once above and never again (REQ-the-phaser-sweeps-in-cents):
    // `frequency * 2^(detune/1200)` cannot reach 0 Hz however deep the sweep.
    for (const s of this.stages) {
      const g = ctx.createGain();
      g.gain.value = stageCents(this.depth, s.frequency.value);
      this.lfo.connect(g).connect(s.detune);
      this.lfoDepths.push(g);
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
    this.depth = clamp01(d);
    for (let i = 0; i < STAGES; i++) {
      const cents = stageCents(this.depth, this.stages[i]!.frequency.value);
      this.lfoDepths[i]!.gain.setTargetAtTime(cents, this.ctx.currentTime, RAMP_SMOOTH);
    }
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
   * (effects.md REQ-a-bypassed-effect-drains-before-disconnect). 0.1 s is that with room to spare.
   */
  protected override drainSeconds(): number { return 0.1; }

  protected override quiesce(on: boolean): void {
    this.quiesced = on;
    this.quiesceParam(this.feedback.gain, on, this.fb);
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    bindTempoLocked(bus, `${prefix}.rate`, `${prefix}.sync`, 'freq', (x) => this.setRate(x));
    bus.subscribe(`${prefix}.depth`, (x) => this.setDepth(x));
    bus.subscribe(`${prefix}.feedback`, (x) => this.setFeedback(x));
  }
}
