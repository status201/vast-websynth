import { BypassWrapper, bindBypassMix, type Effect } from './effect';
import type { ParamBus } from '../../state/params';

function tanhCurve(amount: number, samples = 2048): Float32Array<ArrayBuffer> {
  const k = 1 + amount * 50;
  const curve = new Float32Array(new ArrayBuffer(samples * Float32Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

export class Distortion implements Effect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  private readonly wrap: BypassWrapper;
  private readonly shaper: WaveShaperNode;
  private readonly preGain: GainNode;
  private readonly tone: BiquadFilterNode;
  private readonly postGain: GainNode;

  constructor(private readonly ctx: AudioContext, opts?: { oversample?: boolean }) {
    this.wrap = new BypassWrapper(ctx, 1);
    this.input = this.wrap.input;
    this.output = this.wrap.output;

    this.preGain = ctx.createGain();
    this.preGain.gain.value = 1;

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = tanhCurve(0.3);
    // Weak perf tiers skip the 4× up/down-sampling (performance-mode.md REQ-11).
    this.shaper.oversample = opts?.oversample === false ? 'none' : '4x';

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 3000;
    this.tone.Q.value = 0.7;

    this.postGain = ctx.createGain();
    this.postGain.gain.value = 0.7;

    this.wrap.processedIn
      .connect(this.preGain)
      .connect(this.shaper)
      .connect(this.tone)
      .connect(this.postGain)
      .connect(this.wrap.processedOut);
  }

  setBypass(b: boolean): void { this.wrap.setBypass(b); }
  setMix(m: number): void { this.wrap.setMix(m); }
  setDrive(amount: number): void {
    this.preGain.gain.setTargetAtTime(1 + amount * 8, this.ctx.currentTime, 0.02);
    this.shaper.curve = tanhCurve(amount);
    this.postGain.gain.setTargetAtTime(1 / (1 + amount * 1.5), this.ctx.currentTime, 0.02);
  }
  setTone(hz: number): void {
    this.tone.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    bus.subscribe(`${prefix}.drive`, (x) => this.setDrive(x));
    bus.subscribe(`${prefix}.tone`, (x) => this.setTone(x));
  }
}
