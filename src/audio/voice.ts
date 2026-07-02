import { Osc } from './oscillator';
import { Envelope } from './envelope';
import { LadderFilterNode } from './ladder-filter/node';
import { rampTo, RAMP_FAST, RAMP_MEDIUM } from './param-utils';

export type VoiceState = 'idle' | 'playing' | 'releasing';

export class Voice {
  readonly out: GainNode;
  readonly osc1: Osc;
  readonly osc2: Osc;
  readonly sub: Osc;
  readonly noiseGain: GainNode;
  readonly mix: GainNode;
  readonly filter: LadderFilterNode;
  readonly tremolo: GainNode;
  readonly ampVCA: GainNode;
  readonly ampEnv: Envelope;
  readonly filEnv: Envelope;
  readonly filEnvScale: GainNode;

  currentNote = -1;
  state: VoiceState = 'idle';
  noteOnAt = 0;
  noteOffAt = 0;

  private readonly ctx: AudioContext;
  private glideTime = 0;
  private releaseTimer: number | null = null;

  static async create(ctx: AudioContext): Promise<Voice> {
    const filter = await LadderFilterNode.create(ctx);
    return new Voice(ctx, filter);
  }

  private constructor(ctx: AudioContext, filter: LadderFilterNode) {
    this.ctx = ctx;
    this.osc1 = new Osc(ctx);
    this.osc2 = new Osc(ctx);
    this.sub = new Osc(ctx);
    this.sub.setWave(0);     // sine by default
    this.sub.setOctave(-1);
    this.sub.setLevel(0);    // silent until the SUB level is raised

    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;

    this.mix = ctx.createGain();
    this.mix.gain.value = 0.5;

    this.filter = filter;

    this.tremolo = ctx.createGain();
    this.tremolo.gain.value = 1;

    this.ampVCA = ctx.createGain();
    this.ampVCA.gain.value = 0;

    this.ampEnv = new Envelope(ctx);
    this.filEnv = new Envelope(ctx);

    this.filEnvScale = ctx.createGain();
    this.filEnvScale.gain.value = 24;

    this.out = ctx.createGain();
    this.out.gain.value = 1 / 4;

    // Signal path
    this.osc1.out.connect(this.mix);
    this.osc2.out.connect(this.mix);
    this.sub.out.connect(this.mix);
    this.noiseGain.connect(this.mix);
    this.mix.connect(this.filter.input);
    this.filter.output.connect(this.tremolo);
    this.tremolo.connect(this.ampVCA);
    this.ampVCA.connect(this.out);

    // Modulation
    this.ampEnv.out.connect(this.ampVCA.gain);
    this.filEnv.out.connect(this.filEnvScale);
    this.filEnvScale.connect(this.filter.cutoffNote);

    // Pool voices boot idle — no note yet, so the filter can sleep (REQ-10).
    this.filter.setActive(false);
  }

  noteOn(
    note: number,
    velocity: number,
    when: number,
    opts?: { detuneCents?: number; glide?: boolean },
  ): void {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    // Unconditionally every call: a lost deactivate may cost CPU, never a note.
    this.filter.setActive(true);
    this.currentNote = note;
    this.state = 'playing';
    this.noteOnAt = when;
    const detune = opts?.detuneCents ?? 0;
    const hz = midiToHz(note) * Math.pow(2, detune / 1200);
    const doGlide = opts?.glide ?? this.glideTime > 0;
    const g = doGlide ? this.glideTime : 0;
    this.osc1.setFrequency(hz, when, g);
    this.osc2.setFrequency(hz, when, g);
    this.sub.setFrequency(hz, when, g);
    this.ampEnv.trigger(when, Math.max(0.01, velocity));
    this.filEnv.trigger(when, 1);
  }

  setSubWave(idx: number): void { this.sub.setWave(idx); }
  setSubOctave(o: number): void { this.sub.setOctave(o); }
  setSubLevel(v: number): void { this.sub.setLevel(v); }

  noteOff(when: number): void {
    if (this.state === 'idle') return;
    this.state = 'releasing';
    this.noteOffAt = when;
    this.ampEnv.release_(when);
    this.filEnv.release_(when);
    const delayMs = (this.ampEnv.releaseDuration() + 0.1) * 1000;
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = null;
      if (this.state === 'releasing') {
        this.state = 'idle';
        this.currentNote = -1;
        this.filter.setActive(false);
      }
    }, delayMs);
  }

  /** Force-silence the voice quickly (voice stealing). */
  kill(when: number): void {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    const t = Math.max(when, this.ctx.currentTime);
    const g = this.ampEnv.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(0, t, 0.003);
    this.state = 'idle';
    this.currentNote = -1;
    // Deactivate only after the 3 ms kill fade has passed, and only if no
    // noteOn re-claimed the voice meanwhile (it posts its own true) (REQ-10).
    window.setTimeout(() => {
      if (this.state === 'idle') this.filter.setActive(false);
    }, 30);
  }

  setGlide(seconds: number): void {
    this.glideTime = Math.max(0, seconds);
  }

  setNoiseLevel(v: number): void {
    rampTo(this.noiseGain.gain, v, this.ctx, RAMP_MEDIUM);
  }

  setFilterCutoff(note: number): void {
    rampTo(this.filter.cutoffNote, note, this.ctx, RAMP_FAST);
  }

  setFilterResonance(r: number): void {
    rampTo(this.filter.resonance, r, this.ctx, RAMP_FAST);
  }

  setFilterDrive(d: number): void {
    this.filter.drive.setValueAtTime(d, this.ctx.currentTime);
  }

  setFilterEnvAmount(semi: number): void {
    rampTo(this.filEnvScale.gain, semi, this.ctx, RAMP_MEDIUM);
  }
}

function midiToHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}
