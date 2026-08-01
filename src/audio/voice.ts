import { Osc } from './oscillator';
import { Envelope } from './envelope';
import { LadderFilterNode } from './ladder-filter/node';
import { midiToHz } from '../utils/math';
import { rampTo, RAMP_FAST, RAMP_MEDIUM } from './param-utils';

export type VoiceState = 'idle' | 'playing' | 'releasing';

/** The note at which key tracking contributes nothing (key-tracking.md REQ-2). */
const KEY_CENTER = 60;
/** The worklet's own `cutoffNote` range — key tracking is clamped to it (REQ-5). */
const CUTOFF_MIN = 0;
const CUTOFF_MAX = 135;

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
  // Key tracking's two cached scalars (key-tracking.md). The effective cutoff
  // is derived from these plus `currentNote`, never stored.
  private baseCutoff = 90;
  private keytrack = 0;

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
    // Key tracking lands with the note, not as a ramp from the previous note's
    // cutoff — a glide there would whoop (key-tracking.md REQ-4). A no-op write
    // when keytrack is 0, since the value then equals what setFilterCutoff set.
    if (this.keytrack !== 0) {
      this.filter.cutoffNote.setValueAtTime(this.effectiveCutoff(), when);
    }
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
    // `when` may be up to the transport look-ahead in the future — count the
    // timer from the scheduled release, not from now, so the voice isn't
    // marked idle (stealable) while its tail is still sounding.
    const untilRelease = Math.max(0, when - this.ctx.currentTime);
    const delayMs = (untilRelease + this.ampEnv.releaseDuration() + 0.1) * 1000;
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
    // Through the envelope, never on its gain param directly — the envelope's
    // scheduled-automation model must see every write (envelopes.md REQ-4).
    this.ampEnv.cutFast(when);
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
    this.baseCutoff = note;
    rampTo(this.filter.cutoffNote, this.effectiveCutoff(), this.ctx, RAMP_FAST);
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

  /** 0 = LADDER, 1 = POLY (filter-models.md REQ-1). k-rate, so no ramp. */
  setFilterModel(m: number): void {
    this.filter.model.setValueAtTime(Math.round(m), this.ctx.currentTime);
  }

  setFilterShape(s: number): void {
    rampTo(this.filter.shape, s, this.ctx, RAMP_FAST);
  }

  setFilterKeytrack(amount: number): void {
    this.keytrack = amount;
    // A held note must follow the knob rather than wait for the next noteOn
    // (key-tracking.md REQ-6); ramped, because this one is a knob drag.
    rampTo(this.filter.cutoffNote, this.effectiveCutoff(), this.ctx, RAMP_FAST);
  }

  /**
   * Base cutoff plus key tracking, in semitones (key-tracking.md REQ-2/3/5).
   * The single place the three cached scalars combine, so `noteOn` and both
   * knob paths cannot drift apart. Clamped to the worklet's `cutoffNote` range
   * — the envelope and LFO still sum on top at the AudioParam.
   */
  private effectiveCutoff(): number {
    const note = this.currentNote < 0 ? KEY_CENTER : this.currentNote;
    const v = this.baseCutoff + this.keytrack * (note - KEY_CENTER);
    return Math.max(CUTOFF_MIN, Math.min(CUTOFF_MAX, v));
  }
}
