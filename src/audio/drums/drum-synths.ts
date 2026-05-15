/**
 * Synthesised drum voices. Each exposes `output: AudioNode` (wire once)
 * and `trigger(when, velocity)` for sample-accurate firing.
 *
 * Cheap one-shot graphs — we create + start + stop short-lived OscillatorNodes
 * inside `trigger` because their lifetimes are bounded by the envelope.
 */
export interface DrumSynth {
  readonly output: AudioNode;
  trigger(when: number, velocity: number): void;
  setTune(semitones: number): void;
  setDecay(seconds: number): void;
}

export class Kick implements DrumSynth {
  readonly output: GainNode;
  private tune = 0;
  private decay = 0.4;

  constructor(private readonly ctx: AudioContext) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.9;
  }

  setTune(semi: number): void { this.tune = semi; }
  setDecay(s: number): void { this.decay = Math.max(0.05, s); }

  trigger(when: number, velocity: number): void {
    const t = Math.max(when, this.ctx.currentTime);
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    const baseHz = 55 * Math.pow(2, this.tune / 12);
    osc.frequency.setValueAtTime(baseHz * 6, t);
    osc.frequency.exponentialRampToValueAtTime(baseHz, t + 0.05);
    osc.type = 'sine';

    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(velocity, t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.001, t + this.decay);

    osc.connect(env).connect(this.output);
    osc.start(t);
    osc.stop(t + this.decay + 0.05);
  }
}

export class Snare implements DrumSynth {
  readonly output: GainNode;
  private decay = 0.18;

  constructor(private readonly ctx: AudioContext, private readonly noiseBuf: AudioBuffer) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.8;
  }

  setTune(_semi: number): void { /* not exposed */ }
  setDecay(s: number): void { this.decay = Math.max(0.05, s); }

  trigger(when: number, velocity: number): void {
    const t = Math.max(when, this.ctx.currentTime);

    // Noise component (body of the snare)
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value = 1500;
    const noiseEnv = this.ctx.createGain();
    noiseEnv.gain.setValueAtTime(0, t);
    noiseEnv.gain.linearRampToValueAtTime(velocity * 0.9, t + 0.002);
    noiseEnv.gain.exponentialRampToValueAtTime(0.001, t + this.decay);
    noise.connect(noiseFilter).connect(noiseEnv).connect(this.output);
    noise.start(t);
    noise.stop(t + this.decay + 0.05);

    // Body tone (~180 Hz, fast decay)
    const tone = this.ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(220, t);
    tone.frequency.exponentialRampToValueAtTime(120, t + 0.05);
    const toneEnv = this.ctx.createGain();
    toneEnv.gain.setValueAtTime(0, t);
    toneEnv.gain.linearRampToValueAtTime(velocity * 0.5, t + 0.001);
    toneEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    tone.connect(toneEnv).connect(this.output);
    tone.start(t);
    tone.stop(t + 0.1);
  }
}

export class HiHat implements DrumSynth {
  readonly output: GainNode;
  private decay: number;

  constructor(private readonly ctx: AudioContext, private readonly noiseBuf: AudioBuffer, open: boolean) {
    this.decay = open ? 0.35 : 0.05;
    this.output = ctx.createGain();
    this.output.gain.value = 0.5;
  }

  setTune(_semi: number): void { /* not exposed */ }
  setDecay(s: number): void { this.decay = Math.max(0.02, s); }

  trigger(when: number, velocity: number): void {
    const t = Math.max(when, this.ctx.currentTime);
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    noise.playbackRate.value = 1.5 + Math.random() * 0.3;

    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;

    const peak = this.ctx.createBiquadFilter();
    peak.type = 'bandpass';
    peak.frequency.value = 10000;
    peak.Q.value = 1.2;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(velocity * 0.6, t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.001, t + this.decay);

    noise.connect(hp).connect(peak).connect(env).connect(this.output);
    noise.start(t);
    noise.stop(t + this.decay + 0.05);
  }
}

export class Tom implements DrumSynth {
  readonly output: GainNode;
  private baseHz: number;
  private decay = 0.3;
  private tune = 0;

  constructor(private readonly ctx: AudioContext, baseHz: number) {
    this.baseHz = baseHz;
    this.output = ctx.createGain();
    this.output.gain.value = 0.7;
  }

  setTune(semi: number): void { this.tune = semi; }
  setDecay(s: number): void { this.decay = Math.max(0.05, s); }

  trigger(when: number, velocity: number): void {
    const t = Math.max(when, this.ctx.currentTime);
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    const f = this.baseHz * Math.pow(2, this.tune / 12);
    osc.frequency.setValueAtTime(f * 2.5, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.05);

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(velocity * 0.9, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.001, t + this.decay);

    osc.connect(env).connect(this.output);
    osc.start(t);
    osc.stop(t + this.decay + 0.05);
  }
}

export class Clap implements DrumSynth {
  readonly output: GainNode;
  private decay = 0.25;

  constructor(private readonly ctx: AudioContext, private readonly noiseBuf: AudioBuffer) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.7;
  }

  setTune(_semi: number): void { /* not exposed */ }
  setDecay(s: number): void { this.decay = Math.max(0.05, s); }

  trigger(when: number, velocity: number): void {
    const t = Math.max(when, this.ctx.currentTime);
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 1.3;

    const env = this.ctx.createGain();
    // Three quick bursts + a longer tail — classic clap-machine sound
    env.gain.setValueAtTime(0, t);
    const bursts = [0, 0.012, 0.028];
    for (const b of bursts) {
      env.gain.setValueAtTime(velocity * 0.6, t + b);
      env.gain.exponentialRampToValueAtTime(0.001, t + b + 0.01);
    }
    env.gain.setValueAtTime(velocity * 0.4, t + 0.045);
    env.gain.exponentialRampToValueAtTime(0.001, t + this.decay);

    noise.connect(bp).connect(env).connect(this.output);
    noise.start(t);
    noise.stop(t + this.decay + 0.05);
  }
}

export function makeNoiseBuffer(ctx: AudioContext, durationSec = 2): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * durationSec));
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}
