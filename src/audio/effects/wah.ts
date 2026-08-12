import { WrappedEffect, bindBypassMix } from './effect';
import { clamp01, midiToHz } from '../../utils/math';
import { RAMP_SMOOTH } from '../param-utils';
import type { ParamBus } from '../../state/params';

export class Wah extends WrappedEffect {
  private readonly bp: BiquadFilterNode;
  private readonly lfo: OscillatorNode;
  private readonly lfoDepth: GainNode;

  private centerNote = 75; // ~E5 ≈ 783 Hz
  private depth = 0.6;

  constructor(ctx: AudioContext) {
    super(ctx, 1);

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

  setRate(hz: number): void {
    this.lfo.frequency.setTargetAtTime(hz, this.ctx.currentTime, RAMP_SMOOTH);
  }
  setDepth(d: number): void {
    this.depth = clamp01(d);
    this.lfoDepth.gain.setTargetAtTime(this.depthHz(), this.ctx.currentTime, RAMP_SMOOTH);
  }
  setQ(q: number): void {
    this.bp.Q.setTargetAtTime(q, this.ctx.currentTime, RAMP_SMOOTH);
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
