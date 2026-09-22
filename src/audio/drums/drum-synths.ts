/**
 * Synthesised drum voices. Each exposes `output: AudioNode` (wire once)
 * and `trigger(when, velocity, chokeAt?)` for sample-accurate firing.
 *
 * Cheap one-shot graphs — we create + start + stop short-lived OscillatorNodes
 * inside `trigger` because their lifetimes are bounded by the envelope. The
 * per-hit nodes are torn down via `disposeAfter` once the hit's source(s) end,
 * so a long song does not accumulate stopped-but-connected nodes (the
 * persistent `output` gain, built once in the constructor, is never touched).
 */
export interface DrumSynth {
  /**
   * `GainNode`, not `AudioNode`: every implementation already builds one, and a
   * model swap has to *ramp* it down before disconnecting rather than severing a
   * ringing tail (drum-machine.md REQ-swapping-a-model-never-severs-a-voice).
   */
  readonly output: GainNode;
  /** `chokeAt` (step gate < 1) cuts the hit early with a fast fade. */
  trigger(when: number, velocity: number, chokeAt?: number): void;
  setTune(semitones: number): void;
  setDecay(seconds: number): void;
}

const CHOKE_FADE = 0.005;

/**
 * How long an envelope takes to reach TRUE zero before its source stops
 * (drum-machine.md REQ-a-voice-envelope-reaches-true-zero).
 *
 * `exponentialRampToValueAtTime` cannot reach 0, so every voice lands on a 0.001
 * floor. Stopping the source there truncates the waveform mid-cycle, and a step
 * discontinuity is a click. At -60 dBFS that would not matter, but the per-track
 * drive (REQ-tone-drive-and-pan-are-a-channel) is `tanh(k*x)/tanh(k)` with `k = drive * 50`, whose small-signal
 * slope is ~`k`: at `drive` 0.28 it lifts the residue ~32x (+30 dB), to about
 * -30 dBFS. On the Kick — a 55 Hz sine, where that step is the only broadband
 * content in the signal — it is plainly audible. The noise voices mask their own,
 * which is why the bug lived in all ten of these and was heard in one.
 */
const TAIL_FADE = 0.005;

/**
 * Destination for one one-shot hit: the synth's `output`, or — when the hit
 * is choked — a per-hit gain that ramps to 0 at `chokeAt`. Cutting in a
 * *downstream* gain never disturbs the envelope ramps already scheduled
 * inside the hit (and needs only setValueAtTime/linearRamp, which every
 * browser and the test mock provide). `choke` is returned (when present) so
 * the caller adds it to the per-hit nodes that `disposeAfter` tears down — the
 * shared `output` is the only node that survives the hit.
 */
function chokeRoute(
  ctx: AudioContext,
  output: AudioNode,
  chokeAt: number | undefined,
  start: number,
): { dest: AudioNode; stopAt(natural: number): number; choke?: GainNode } {
  // A stop may never precede its own start (REQ-a-clamped-hit-carries-its-choke): with a choke already past,
  // `min` alone returned a time before `start` and the source never sounded.
  if (chokeAt === undefined) return { dest: output, stopAt: (n) => Math.max(start, n) };
  const g = ctx.createGain();
  g.gain.setValueAtTime(1, chokeAt);
  g.gain.linearRampToValueAtTime(0, chokeAt + CHOKE_FADE);
  g.connect(output);
  return { dest: g, stopAt: (n) => Math.max(start, Math.min(n, chokeAt + 0.03)), choke: g };
}

/**
 * One hit's start time and destination (drum-machine.md REQ-a-clamped-hit-carries-its-choke).
 *
 * `when` may be in the past: the clock's guaranteed lead is finite and an early
 * micro nudge eats into it (step-settings.md REQ-an-early-offset-is-capped-in-seconds), while the first tick after
 * `start()` and every dropout re-origin carry less lead than `MAX_EARLY_S`. The
 * start is clamped forward — and the choke shifts by **the same delta**, so the
 * gate keeps its LENGTH. Clamping only the start left `chokeAt` behind the hit,
 * cutting it mid-attack or, once the whole fade was past, resolving the gain to 0
 * and dropping the hit silently.
 */
function voiceStart(
  ctx: AudioContext,
  output: AudioNode,
  when: number,
  chokeAt: number | undefined,
): { t: number; r: ReturnType<typeof chokeRoute> } {
  const t = Math.max(when, ctx.currentTime);
  const shifted = chokeAt === undefined ? undefined : chokeAt + (t - when);
  return { t, r: chokeRoute(ctx, output, shifted, t) };
}

/**
 * Ramp an envelope to TRUE zero and return when its source may stop (REQ-a-voice-envelope-reaches-true-zero).
 * Call it per envelope, not per voice: the Snare's noise and tone, the Conga's
 * skin and overtone and the Bongo's head and click each have their own tail.
 */
function endAt(g: AudioParam, at: number): number {
  g.linearRampToValueAtTime(0, at + TAIL_FADE);
  return at + TAIL_FADE;
}

/**
 * Disconnect every per-hit node once the hit's source(s) finish. Sources stop
 * at staggered times (e.g. the snare's noise vs. body tone), so we wait for the
 * **last** `onended` before tearing down the shared nodes. Without this, every
 * drum hit leaks its stopped-but-still-connected nodes into the live graph —
 * unbounded growth that crackles/distorts after a song runs for a while.
 */
function disposeAfter(sources: AudioScheduledSourceNode[], nodes: AudioNode[]): void {
  let remaining = sources.length;
  const done = (): void => {
    if (--remaining === 0) for (const n of nodes) n.disconnect();
  };
  for (const s of sources) s.onended = done;
}

/**
 * The one-shot amplitude envelope every voice shares: silent at `t`, up to
 * `peak` over `attack`, then an exponential fall to the -60 dB floor at
 * `t + decay`. Ten voices wrote these three lines out, differing only in the
 * peak and the attack — and the order matters (the floor ramp must follow the
 * attack), so it is worth having in one place rather than ten.
 *
 * It does NOT end the envelope: {@link endAt} takes it to true zero, and is
 * called per envelope rather than per voice because a voice may have two.
 */
function decayEnv(g: AudioParam, t: number, peak: number, attack: number, decay: number): void {
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(peak, t + attack);
  g.exponentialRampToValueAtTime(0.001, t + decay);
}

/**
 * Tear one hit down. The choke gain, when the hit has one, is a per-hit node
 * like any other and must be disconnected with them — which is the line every
 * voice repeated, and the one a new voice would be most likely to forget.
 */
function finishHit(
  r: ReturnType<typeof voiceStart>['r'],
  sources: AudioScheduledSourceNode[],
  nodes: AudioNode[],
): void {
  if (r.choke) nodes.push(r.choke);
  disposeAfter(sources, nodes);
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
    const { t, r } = voiceStart(this.ctx, this.output, when, chokeAt);
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    const baseHz = 55 * Math.pow(2, this.tune / 12);
    osc.frequency.setValueAtTime(baseHz * 6, t);
    osc.frequency.exponentialRampToValueAtTime(baseHz, t + 0.05);
    osc.type = 'sine';

    decayEnv(env.gain, t, velocity, 0.001, this.decay);

    osc.connect(env).connect(r.dest);
    osc.start(t);
    osc.stop(r.stopAt(endAt(env.gain, t + this.decay)));

    finishHit(r, [osc], [osc, env]);
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
    const { t, r } = voiceStart(this.ctx, this.output, when, chokeAt);
    const f = Math.pow(2, this.tune / 12);

    // Noise component (body of the snare)
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value = 1500 * f;
    const noiseEnv = this.ctx.createGain();
    decayEnv(noiseEnv.gain, t, velocity * 0.9, 0.002, this.decay);
    noise.connect(noiseFilter).connect(noiseEnv).connect(r.dest);
    noise.start(t);
    noise.stop(r.stopAt(endAt(noiseEnv.gain, t + this.decay)));

    // Body tone (~180 Hz, fast decay)
    const tone = this.ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(220 * f, t);
    tone.frequency.exponentialRampToValueAtTime(120 * f, t + 0.05);
    const toneEnv = this.ctx.createGain();
    decayEnv(toneEnv.gain, t, velocity * 0.5, 0.001, 0.08);
    tone.connect(toneEnv).connect(r.dest);
    tone.start(t);
    tone.stop(r.stopAt(endAt(toneEnv.gain, t + 0.08)));

    finishHit(r, [noise, tone], [noise, noiseFilter, noiseEnv, tone, toneEnv]);
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
    const { t, r } = voiceStart(this.ctx, this.output, when, chokeAt);
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
    decayEnv(env.gain, t, velocity * 0.6, 0.001, this.decay);

    noise.connect(hp).connect(peak).connect(env).connect(r.dest);
    noise.start(t);
    noise.stop(r.stopAt(endAt(env.gain, t + this.decay)));

    finishHit(r, [noise], [noise, hp, peak, env]);
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
    const { t, r } = voiceStart(this.ctx, this.output, when, chokeAt);
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    const f = this.baseHz * Math.pow(2, this.tune / 12);
    osc.frequency.setValueAtTime(f * 2.5, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.05);

    const env = this.ctx.createGain();
    decayEnv(env.gain, t, velocity * 0.9, 0.002, this.decay);

    osc.connect(env).connect(r.dest);
    osc.start(t);
    osc.stop(r.stopAt(endAt(env.gain, t + this.decay)));

    finishHit(r, [osc], [osc, env]);
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
    const { t, r } = voiceStart(this.ctx, this.output, when, chokeAt);
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
    noise.stop(r.stopAt(endAt(env.gain, t + this.decay)));

    finishHit(r, [noise], [noise, bp, env]);
  }
}

export class Conga implements DrumSynth {
  readonly output: GainNode;
  private decay = 0.22;
  private tune = 0;

  constructor(private readonly ctx: AudioContext) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.75;
  }

  setTune(semi: number): void { this.tune = semi; }
  setDecay(s: number): void { this.decay = Math.max(0.05, s); }

  trigger(when: number, velocity: number, chokeAt?: number): void {
    const { t, r } = voiceStart(this.ctx, this.output, when, chokeAt);
    const f = 190 * Math.pow(2, this.tune / 12);

    // Skin tone: near-sine with a brief attack blip — rounder than a tom
    // (shorter, shallower sweep) so it reads as hand drum, not fill drum.
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f * 1.35, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.02);
    const env = this.ctx.createGain();
    decayEnv(env.gain, t, velocity * 0.9, 0.003, this.decay);

    // A faint octave overtone gives the open-tone "song" of a conga.
    const ovt = this.ctx.createOscillator();
    ovt.type = 'triangle';
    ovt.frequency.setValueAtTime(f * 2, t);
    const ovtEnv = this.ctx.createGain();
    decayEnv(ovtEnv.gain, t, velocity * 0.15, 0.003, Math.min(this.decay, 0.09));

    osc.connect(env).connect(r.dest);
    ovt.connect(ovtEnv).connect(r.dest);
    osc.start(t);
    ovt.start(t);
    osc.stop(r.stopAt(endAt(env.gain, t + this.decay)));
    ovt.stop(r.stopAt(endAt(ovtEnv.gain, t + Math.min(this.decay, 0.09))));

    finishHit(r, [osc, ovt], [osc, env, ovt, ovtEnv]);
  }
}

export class Bongo implements DrumSynth {
  readonly output: GainNode;
  private decay = 0.09;
  private tune = 0;

  constructor(private readonly ctx: AudioContext, private readonly noiseBuf: AudioBuffer) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.7;
  }

  setTune(semi: number): void { this.tune = semi; }
  setDecay(s: number): void { this.decay = Math.max(0.03, s); }

  trigger(when: number, velocity: number, chokeAt?: number): void {
    const { t, r } = voiceStart(this.ctx, this.output, when, chokeAt);
    const f = 400 * Math.pow(2, this.tune / 12);

    // Small tight head: higher and shorter than the conga.
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f * 1.25, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.012);
    const env = this.ctx.createGain();
    decayEnv(env.gain, t, velocity * 0.85, 0.002, this.decay);

    // Woody fingertip click: a short burst of band-passed noise at the head pitch.
    const click = this.ctx.createBufferSource();
    click.buffer = this.noiseBuf;
    click.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * 4;
    bp.Q.value = 2.5;
    const clickEnv = this.ctx.createGain();
    clickEnv.gain.setValueAtTime(velocity * 0.35, t);
    clickEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.015);

    osc.connect(env).connect(r.dest);
    click.connect(bp).connect(clickEnv).connect(r.dest);
    osc.start(t);
    click.start(t);
    osc.stop(r.stopAt(endAt(env.gain, t + this.decay)));
    click.stop(r.stopAt(endAt(clickEnv.gain, t + 0.015)));

    finishHit(r, [osc, click], [osc, env, click, bp, clickEnv]);
  }
}

export class Cowbell implements DrumSynth {
  readonly output: GainNode;
  private decay = 0.25;
  private tune = 0;

  constructor(private readonly ctx: AudioContext) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.55;
  }

  setTune(semi: number): void { this.tune = semi; }
  setDecay(s: number): void { this.decay = Math.max(0.05, s); }

  trigger(when: number, velocity: number, chokeAt?: number): void {
    const { t, r } = voiceStart(this.ctx, this.output, when, chokeAt);
    const f = Math.pow(2, this.tune / 12);

    // 808 recipe: two detuned squares through a bandpass — clangy, not tonal.
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700 * f;
    bp.Q.value = 1.1;
    const env = this.ctx.createGain();
    decayEnv(env.gain, t, velocity * 0.8, 0.001, this.decay);

    // One envelope downstream of both oscillators, so its ramp is scheduled once
    // and every source stops at the same end-of-ramp time.
    const stopAt = r.stopAt(endAt(env.gain, t + this.decay));
    const oscs: OscillatorNode[] = [];
    for (const hz of [560, 845]) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = hz * f;
      o.connect(bp);
      o.start(t);
      o.stop(stopAt);
      oscs.push(o);
    }
    bp.connect(env).connect(r.dest);

    const nodes: AudioNode[] = [...oscs, bp, env];
    if (r.choke) nodes.push(r.choke);
    disposeAfter(oscs, nodes);
  }
}

export class Clave implements DrumSynth {
  readonly output: GainNode;
  private decay = 0.06;
  private tune = 0;

  constructor(private readonly ctx: AudioContext) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.6;
  }

  setTune(semi: number): void { this.tune = semi; }
  setDecay(s: number): void { this.decay = Math.max(0.02, s); }

  trigger(when: number, velocity: number, chokeAt?: number): void {
    const { t, r } = voiceStart(this.ctx, this.output, when, chokeAt);
    const f = 1200 * Math.pow(2, this.tune / 12);

    // A bare high ping with the faintest pitch dip — rosewood on rosewood.
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f * 1.08, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.006);
    const env = this.ctx.createGain();
    decayEnv(env.gain, t, velocity * 0.9, 0.001, this.decay);

    osc.connect(env).connect(r.dest);
    osc.start(t);
    osc.stop(r.stopAt(endAt(env.gain, t + this.decay)));

    finishHit(r, [osc], [osc, env]);
  }
}

export class Shaker implements DrumSynth {
  readonly output: GainNode;
  private decay = 0.09;
  private tune = 0;

  constructor(private readonly ctx: AudioContext, private readonly noiseBuf: AudioBuffer) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.5;
  }

  setTune(semi: number): void { this.tune = semi; }
  setDecay(s: number): void { this.decay = Math.max(0.03, s); }

  trigger(when: number, velocity: number, chokeAt?: number): void {
    const { t, r } = voiceStart(this.ctx, this.output, when, chokeAt);
    const f = Math.pow(2, this.tune / 12);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 6500 * f;
    bp.Q.value = 1.6;

    // The soft ~10 ms swell is what separates a shaker from a closed hat —
    // grains build up rather than snap.
    const env = this.ctx.createGain();
    decayEnv(env.gain, t, velocity * 0.55, 0.012, Math.max(this.decay, 0.03));

    noise.connect(bp).connect(env).connect(r.dest);
    noise.start(t);
    noise.stop(r.stopAt(endAt(env.gain, t + Math.max(this.decay, 0.03))));

    finishHit(r, [noise], [noise, bp, env]);
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
