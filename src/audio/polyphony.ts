import { Voice } from './voice';
import { assertIndex } from '../utils/array';

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
  private readonly heldNotes = new Map<number, Voice[]>();

  // Analogue oscillator drift — slow random detune summed into all oscs.
  private readonly drift: ConstantSourceNode;
  private driftAmount = 0;
  private driftTimer: number | null = null;

  constructor(private readonly ctx: AudioContext, private readonly voices: Voice[]) {
    this.drift = ctx.createConstantSource();
    this.drift.offset.value = 0;
    this.drift.start();
    // The 110 ms wander interval only runs while drift > 0 (voicing.md REQ-4);
    // setDrift owns its lifecycle. Default drift is 0 → no recurring timer.
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
      // Taking a voice hands it to this note, so whatever note held it before must
      // stop claiming it (REQ-9). Without this the old note's entry still names the
      // voice, and releasing that key sends noteOff to a voice now sounding
      // something else — audible as "let go of one key, a different note stops".
      this.evictVoice(v);
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

  /**
   * Drop `v` from whatever note currently claims it, and forget a note left with
   * no voices at all (REQ-9). Upholds the invariant `releaseNote` depends on: a
   * voice appears in at most one `heldNotes` entry, so the note a voice is filed
   * under is always the note it is actually sounding.
   *
   * Scans every entry rather than stopping at the first hit — `heldNotes` holds at
   * most one entry per sounding note, so this is a handful of comparisons on the
   * note path, and it stays correct even if the invariant is ever broken elsewhere.
   * Deleting the current key while iterating a Map is well defined.
   */
  private evictVoice(v: Voice): void {
    for (const [n, vs] of this.heldNotes) {
      const i = vs.indexOf(v);
      if (i < 0) continue;
      vs.splice(i, 1);
      if (vs.length === 0) this.heldNotes.delete(n);
    }
  }

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
