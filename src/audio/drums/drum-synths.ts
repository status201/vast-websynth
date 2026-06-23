/**
 * Synthesised drum voices. Each exposes `output: AudioNode` (wire once)
 * and `trigger(when, velocity, chokeAt?)` for sample-accurate firing.
 *
 * Cheap one-shot graphs — we create + start + stop short-lived OscillatorNodes
 * inside `trigger` because their lifetimes are bounded by the envelope.
 */
export interface DrumSynth {
  readonly output: AudioNode;
  /** `chokeAt` (step gate < 1) cuts the hit early with a fast fade. */
  trigger(when: number, velocity: number, chokeAt?: number): void;
  setTune(semitones: number): void;
  setDecay(seconds: number): void;
}

const CHOKE_FADE = 0.005;

/**
 * Destination for one one-shot hit: the synth's `output`, or — when the hit
 * is choked — a per-hit gain that ramps to 0 at `chokeAt`. Cutting in a
 * *downstream* gain never disturbs the envelope ramps already scheduled
 * inside the hit (and needs only setValueAtTime/linearRamp, which every
 * browser and the test mock provide).
 */
function chokeRoute(
  ctx: AudioContext,
  output: AudioNode,
  chokeAt: number | undefined,
): { dest: AudioNode; stopAt(natural: number): number } {
  if (chokeAt === undefined) return { dest: output, stopAt: (n) => n };
  const g = ctx.createGain();
  g.gain.setValueAtTime(1, chokeAt);
  g.gain.linearRampToValueAtTime(0, chokeAt + CHOKE_FADE);
  g.connect(output);
  return { dest: g, stopAt: (n) => Math.min(n, chokeAt + 0.03) };
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

  trigger(when: number, velocity: number, chokeAt?: number): void {
    const t = Math.max(when, this.ctx.currentTime);
    const r = chokeRoute(this.ctx, this.output, chokeAt);
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    const baseHz = 55 * Math.pow(2, this.tune / 12);
    osc.frequency.setValueAtTime(baseHz * 6, t);
    osc.frequency.exponentialRampToValueAtTime(baseHz, t + 0.05);
    osc.type = 'sine';

    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(velocity, t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.001, t + this.decay);

    osc.connect(env).connect(r.dest);
    osc.start(t);
    osc.stop(r.stopAt(t + this.decay + 0.05));
  }
}

export class Snare implements DrumSynth {
  readonly output: GainNode;
  private decay = 0.18;
  private tune = 0;

  constructor(private readonly ctx: AudioContext, private readonly noiseBuf: AudioBuffer) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.8;
  }

  setTune(semi: number): void { this.tune = semi; }
  setDecay(s: number): void { this.decay = Math.max(0.05, s); }

  trigger(when: number, velocity: number, chokeAt?: number): void {
    const t = Math.max(when, this.ctx.currentTime);
    const r = chokeRoute(this.ctx, this.output, chokeAt);
    const f = Math.pow(2, this.tune / 12);

    // Noise component (body of the snare)
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value = 1500 * f;
    const noiseEnv = this.ctx.createGain();
    noiseEnv.gain.setValueAtTime(0, t);
    noiseEnv.gain.linearRampToValueAtTime(velocity * 0.9, t + 0.002);
    noiseEnv.gain.exponentialRampToValueAtTime(0.001, t + this.decay);
    noise.connect(noiseFilter).connect(noiseEnv).connect(r.dest);
    noise.start(t);
    noise.stop(r.stopAt(t + this.decay + 0.05));

    // Body tone (~180 Hz, fast decay)
    const tone = this.ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(220 * f, t);
    tone.frequency.exponentialRampToValueAtTime(120 * f, t + 0.05);
    const toneEnv = this.ctx.createGain();
    toneEnv.gain.setValueAtTime(0, t);
    toneEnv.gain.linearRampToValueAtTime(velocity * 0.5, t + 0.001);
    toneEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    tone.connect(toneEnv).connect(r.dest);
    tone.start(t);
    tone.stop(r.stopAt(t + 0.1));
  }
}

export class HiHat implements DrumSynth {
  readonly output: GainNode;
  private decay: number;
  private tune = 0;

  constructor(private readonly ctx: AudioContext, private readonly noiseBuf: AudioBuffer, open: boolean) {
    this.decay = open ? 0.35 : 0.05;
    this.output = ctx.createGain();
    this.output.gain.value = 0.5;
  }

  setTune(semi: number): void { this.tune = semi; }
  setDecay(s: number): void { this.decay = Math.max(0.02, s); }

  trigger(when: number, velocity: number, chokeAt?: number): void {
    const t = Math.max(when, this.ctx.currentTime);
    const r = chokeRoute(this.ctx, this.output, chokeAt);
    const f = Math.pow(2, this.tune / 12);
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    noise.playbackRate.value = 1.5 + Math.random() * 0.3;

    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000 * f;

    const peak = this.ctx.createBiquadFilter();
    peak.type = 'bandpass';
    peak.frequency.value = 10000 * f;
    peak.Q.value = 1.2;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(velocity * 0.6, t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.001, t + this.decay);

    noise.connect(hp).connect(peak).connect(env).connect(r.dest);
    noise.start(t);
    noise.stop(r.stopAt(t + this.decay + 0.05));
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

  trigger(when: number, velocity: number, chokeAt?: number): void {
    const t = Math.max(when, this.ctx.currentTime);
    const r = chokeRoute(this.ctx, this.output, chokeAt);
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    const f = this.baseHz * Math.pow(2, this.tune / 12);
    osc.frequency.setValueAtTime(f * 2.5, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.05);

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(velocity * 0.9, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.001, t + this.decay);

    osc.connect(env).connect(r.dest);
    osc.start(t);
    osc.stop(r.stopAt(t + this.decay + 0.05));
  }
}

export class Clap implements DrumSynth {
  readonly output: GainNode;
  private decay = 0.25;
  private tune = 0;

  constructor(private readonly ctx: AudioContext, private readonly noiseBuf: AudioBuffer) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.7;
  }

  setTune(semi: number): void { this.tune = semi; }
  setDecay(s: number): void { this.decay = Math.max(0.05, s); }

  trigger(when: number, velocity: number, chokeAt?: number): void {
    const t = Math.max(when, this.ctx.currentTime);
    const r = chokeRoute(this.ctx, this.output, chokeAt);
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100 * Math.pow(2, this.tune / 12);
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

    noise.connect(bp).connect(env).connect(r.dest);
    noise.start(t);
    noise.stop(r.stopAt(t + this.decay + 0.05));
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
