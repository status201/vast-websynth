import { BypassWrapper, bindBypassMix, type Effect } from './effect';
import { clamp01, midiToHz } from '../../utils/math';
import type { ParamBus } from '../../state/params';

export class Wah implements Effect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  private readonly wrap: BypassWrapper;
  private readonly bp: BiquadFilterNode;
  private readonly lfo: OscillatorNode;
  private readonly lfoDepth: GainNode;

  private centerNote = 75; // ~E5 ≈ 783 Hz
  private depth = 0.6;

  constructor(private readonly ctx: AudioContext) {
    this.wrap = new BypassWrapper(ctx, 1);
    this.input = this.wrap.input;
    this.output = this.wrap.output;

    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    this.bp.frequency.value = midiToHz(this.centerNote);
    this.bp.Q.value = 4;

    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 1.5;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = this.depthHz();

    this.lfo.connect(this.lfoDepth).connect(this.bp.frequency);
    this.lfo.start();

    this.wrap.processedIn.connect(this.bp).connect(this.wrap.processedOut);
  }

  setBypass(b: boolean): void { this.wrap.setBypass(b); }
  setRate(hz: number): void {
    this.lfo.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
  }
  setDepth(d: number): void {
    this.depth = clamp01(d);
    this.lfoDepth.gain.setTargetAtTime(this.depthHz(), this.ctx.currentTime, 0.02);
  }
  setQ(q: number): void {
    this.bp.Q.setTargetAtTime(q, this.ctx.currentTime, 0.02);
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this); // no setMix — the wah has no dry/wet
    bus.subscribe(`${prefix}.rate`, (x) => this.setRate(x));
    bus.subscribe(`${prefix}.depth`, (x) => this.setDepth(x));
    bus.subscribe(`${prefix}.q`, (x) => this.setQ(x));
  }

  private depthHz(): number {
    // Sweep over a roughly 2-octave window around the center
    return this.depth * 1500;
  }
}
