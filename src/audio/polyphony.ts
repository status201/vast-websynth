import { Voice } from './voice';
import { assertIndex } from '../utils/array';
import { midiToHz } from '../utils/math';

/**
 * Voice allocation + the "how it plays" voicing controls: poly/mono, unison
 * stacking, glide mode, and analogue per-voice pitch drift. Extracted from the
 * Engine (ADR-008) so note allocation is a single cohesive, testable unit;
 * the Engine builds the voice graph and delegates `playNote`/`releaseNote` here.
 *
 * The voice pool is the same array the Engine fans per-voice params over, passed
 * in by reference. The drift `ConstantSourceNode` is owned here and wired into
 * each voice via `connectDrift` during Engine voice setup.
 */
export class Polyphony {
  private polyMode = true;
  private unisonCount = 1;
  private unisonDetune = 12;
  private glideMode = 1; // 0 off · 1 always · 2 legato
  private glideTime = 0; // seconds, fanned out to the voices by setGlideTime
  private readonly heldNotes = new Map<number, Voice[]>();

  // Analogue oscillator drift — slow random detune summed into all oscs.
  private readonly drift: ConstantSourceNode;
  private driftAmount = 0;
  private driftTimer: number | null = null;

  /**
   * The pitch of the most recent note-on, in Hz, as a control signal — written
   * with the same time and glide ramp as the oscillators, so anything reading it
   * tracks a glide. It lives here because this is the module that already knows
   * what is sounding; nothing renders it unless something connects to it
   * (Zoetrope's cycle clock is the only consumer today).
   */
  readonly pitchHz: ConstantSourceNode;

  constructor(private readonly ctx: AudioContext, private readonly voices: Voice[]) {
    this.drift = ctx.createConstantSource();
    this.drift.offset.value = 0;
    this.drift.start();
    // The 110 ms wander interval only runs while drift > 0 (voicing.md REQ-4);
    // setDrift owns its lifecycle. Default drift is 0 → no recurring timer.

    this.pitchHz = ctx.createConstantSource();
    this.pitchHz.offset.value = 0;
    this.pitchHz.start();
  }

  /** Sum the analogue-drift detune source into a voice's oscillators. */
  connectDrift(v: Voice): void {
    this.drift.connect(v.osc1.detuneParam);
    this.drift.connect(v.osc2.detuneParam);
    this.drift.connect(v.sub.detuneParam);
  }

  // ---------- Voicing setters (driven by ParamBus subscriptions) ----------

  setPoly(on: boolean): void {
    if (this.polyMode === on) return;
    this.polyMode = on;
    this.killAll(); // no notes hang across the mode change
  }
  setUnisonCount(n: number): void { this.unisonCount = Math.max(1, Math.round(n)); }
  setUnisonDetune(cents: number): void { this.unisonDetune = cents; }
  setGlideMode(mode: number): void { this.glideMode = Math.round(mode); }
  /**
   * Glide time fans out to the voices from here rather than from the Engine, so
   * the one module that owns "how it plays" also knows the number — `pitchHz`
   * has to ramp on the same curve the oscillators do.
   */
  setGlideTime(seconds: number): void {
    this.glideTime = Math.max(0, seconds);
    for (const v of this.voices) v.setGlide(seconds);
  }
  setDrift(amount: number): void {
    this.driftAmount = amount;
    if (amount > 0) {
      if (this.driftTimer === null) this.driftTimer = window.setInterval(this.driftStep, 110);
    } else if (this.driftTimer !== null) {
      clearInterval(this.driftTimer);
      this.driftTimer = null;
      this.drift.offset.setTargetAtTime(0, this.ctx.currentTime, 0.12); // settle back
    }
  }

  // ---------- Note handling ----------

  /** Play a note at the given audio time (defaults to now). */
  playNote(note: number, velocity = 0.8, when?: number): void {
    const t = when ?? this.ctx.currentTime;
    const count = Math.max(1, Math.min(this.unisonCount, this.voices.length));
    // Legato = glide only when another note is already sounding.
    const anySounding = this.heldNotes.size > 0;
    const glide = this.glideMode === 1 ? true : this.glideMode === 2 ? anySounding : false;

    this.writePitch(midiToHz(note), t, glide ? this.glideTime : 0);

    if (!this.polyMode) {
      const used: Voice[] = [];
      for (let i = 0; i < count; i++) {
        const v = this.voices[i]!;
        v.noteOn(note, velocity, t, { detuneCents: this.unisonOffset(i, count), glide });
        used.push(v);
      }
      this.heldNotes.set(note, used);
      return;
    }

    const existing = this.heldNotes.get(note);
    if (existing && existing.some((v) => v.state !== 'idle')) {
      for (let i = 0; i < existing.length; i++) {
        existing[i]!.noteOn(note, velocity, t, { detuneCents: this.unisonOffset(i, existing.length), glide });
      }
      return;
    }
    const used: Voice[] = [];
    for (let i = 0; i < count; i++) {
      const v = this.pickVoice();
      v.noteOn(note, velocity, t, { detuneCents: this.unisonOffset(i, count), glide });
      used.push(v);
    }
    this.heldNotes.set(note, used);
  }

  /** Release a note at the given audio time (defaults to now). */
  releaseNote(note: number, when?: number): void {
    const t = when ?? this.ctx.currentTime;
    const vs = this.heldNotes.get(note);
    if (vs) {
      for (const v of vs) v.noteOff(t);
      this.heldNotes.delete(note);
    }
  }

  /** Force-silence every voice and forget held notes (no transport change). */
  killAll(): void {
    const t = this.ctx.currentTime;
    for (const v of this.voices) v.kill(t);
    this.heldNotes.clear();
  }

  // ---------- Internals ----------

  /**
   * Mirror the note onto `pitchHz`, matching `Osc.setFrequency`'s ramp exactly
   * (jump when glide is off, `setTargetAtTime` at glide/3 otherwise) so a
   * consumer's idea of the period never drifts from the oscillators'.
   */
  private writePitch(hz: number, when: number, glideSec: number): void {
    const p = this.pitchHz.offset;
    p.cancelScheduledValues(when);
    if (glideSec <= 0.001) p.setValueAtTime(hz, when);
    else p.setTargetAtTime(hz, when, glideSec / 3);
  }

  /** Symmetric detune spread in cents for unison copy i of n. */
  private unisonOffset(i: number, n: number): number {
    if (n <= 1) return 0;
    return (i / (n - 1) - 0.5) * 2 * this.unisonDetune;
  }

  private driftStep = (): void => {
    const range = this.driftAmount * 12; // ±12 cents at full
    const target = range <= 0 ? 0 : (Math.random() * 2 - 1) * range;
    this.drift.offset.setTargetAtTime(target, this.ctx.currentTime, 0.12);
  };

  private pickVoice(): Voice {
    // Prefer idle voices, then oldest releasing, then oldest playing
    let idle: Voice | null = null;
    let oldestReleasing: Voice | null = null;
    let oldestPlaying: Voice | null = null;
    for (const v of this.voices) {
      if (v.state === 'idle') { idle = v; break; }
      if (v.state === 'releasing') {
        if (!oldestReleasing || v.noteOffAt < oldestReleasing.noteOffAt) oldestReleasing = v;
      } else {
        if (!oldestPlaying || v.noteOnAt < oldestPlaying.noteOnAt) oldestPlaying = v;
      }
    }
    if (idle) return idle;
    if (oldestReleasing) return oldestReleasing;
    return oldestPlaying ?? assertIndex(this.voices, 0, 'voices');
  }
}
