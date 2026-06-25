import { BypassWrapper, type Effect } from './effect';
import type { ParamBus } from '../../state/params';

/**
 * Algorithmic-feel reverb built on a ConvolverNode with a procedurally
 * generated impulse response. `size` selects from a small bank of pre-rendered
 * IRs to avoid expensive re-rendering on knob drags.
 */
export class Reverb implements Effect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  private readonly wrap: BypassWrapper;
  private readonly convolver: ConvolverNode;
  private readonly damp: BiquadFilterNode;
  private readonly irs: AudioBuffer[];

  constructor(private readonly ctx: AudioContext) {
    this.wrap = new BypassWrapper(ctx, 0.25);
    this.input = this.wrap.input;
    this.output = this.wrap.output;

    this.convolver = ctx.createConvolver();
    this.damp = ctx.createBiquadFilter();
    this.damp.type = 'lowpass';
    this.damp.frequency.value = 8000;
    this.damp.Q.value = 0.707;

    this.irs = [0.4, 0.8, 1.5, 2.5, 4.0].map((d) => generateIR(ctx, d, 2));
    this.convolver.buffer = this.irs[2]!;

    this.wrap.processedIn.connect(this.convolver).connect(this.damp).connect(this.wrap.processedOut);
  }

  setBypass(b: boolean): void { this.wrap.setBypass(b); }
  setMix(m: number): void { this.wrap.setMix(m); }
  setSize(v: number): void {
    const idx = Math.max(0, Math.min(this.irs.length - 1, Math.round(v * (this.irs.length - 1))));
    const buf = this.irs[idx];
    if (buf && this.convolver.buffer !== buf) this.convolver.buffer = buf;
  }
  setDamp(d: number): void {
    // 0 = bright (12 kHz), 1 = dark (1 kHz)
    const hz = 12000 - d * 11000;
    this.damp.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.05);
  }

  bind(bus: ParamBus, prefix: string): void {
    bus.subscribe(`${prefix}.on`, (x) => this.setBypass(x < 0.5));
    bus.subscribe(`${prefix}.size`, (x) => this.setSize(x));
    bus.subscribe(`${prefix}.damp`, (x) => this.setDamp(x));
    bus.subscribe(`${prefix}.mix`, (x) => this.setMix(x));
  }
}

function generateIR(ctx: AudioContext, durationSec: number, channels = 2): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * durationSec));
  const buf = ctx.createBuffer(channels, len, sr);
  // Early reflections + exponentially decaying noise tail
  for (let ch = 0; ch < channels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, 2.5);
      // Mild stereo de-correlation
      const phase = ch === 1 ? 1 : 0;
      data[i] = (Math.random() * 2 - 1) * env * (0.9 + 0.1 * Math.sin(i * 0.001 + phase));
    }
  }
  return buf;
}
