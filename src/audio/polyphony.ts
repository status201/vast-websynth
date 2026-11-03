import { Voice, type VoiceNoteOptions } from './voice';
import { liveStartTime } from './param-utils';
import { assertIndex } from '../utils/array';
import type { NoteOptions } from './transport/note-output';

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
  /** Per envelope: single-trigger (true) or multi — mono only (voicing.md REQ-single-trigger-legatos-a-mono-line). */
  private readonly singleTrigger = { amp: false, fil: false };
  private readonly heldNotes = new Map<number, Voice[]>();

  // Analogue oscillator drift — slow random detune summed into all oscs.
  private readonly drift: ConstantSourceNode;
  private driftAmount = 0;
  private driftTimer: number | null = null;

  constructor(private readonly ctx: AudioContext, private readonly voices: Voice[]) {
    this.drift = ctx.createConstantSource();
    this.drift.offset.value = 0;
    this.drift.start();
    // The 110 ms wander interval only runs while drift > 0 (voicing.md REQ-analogue-drift-is-off-by-default);
    // setDrift owns its lifecycle. Default drift is 0 → no recurring timer.
  }

  /** Sum the analogue-drift detune source into a voice's oscillators — and the
   *  sync pair's junction (oscillator-sync.md REQ-every-pitch-source-reaches-the-pair). */
  connectDrift(v: Voice): void {
    for (const t of v.pitchTargets()) this.drift.connect(t);
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
  setSingleTrigger(env: 'amp' | 'fil', on: boolean): void { this.singleTrigger[env] = on; }
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

  /** Play a note at the given audio time — a live note (none given) a render
   *  burst ahead of now (REQ-a-live-note-starts-ahead-of-the-render). */
  playNote(note: number, velocity = 0.8, when?: number, opts?: NoteOptions): void {
    const t = when ?? liveStartTime(this.ctx);
    const count = Math.max(1, Math.min(this.unisonCount, this.voices.length));
    // Legato = glide only when another note is already sounding.
    const anySounding = this.heldNotes.size > 0;
    // What every voice this note uses gets, unison copies included: a spread chord
    // is still one track, in one place, and a per-note bend bends every copy alike
    // (step-settings.md REQ-a-bend-is-per-voice). Only the detune differs per copy.
    const base: VoiceNoteOptions = {
      glide: this.glideMode === 1 ? true : this.glideMode === 2 ? anySounding : false,
      pan: opts?.pan ?? 0,
      panGroup: opts?.panGroup,
      bend: opts?.bend,
    };

    const from = opts?.legatoFrom;

    if (!this.polyMode) {
      // Mono plays its fixed voices either way, so continuing a note is only a
      // question of whether the envelopes are struck again: neither when the caller
      // continues a note still held (a legato tie), and each one not when a note is
      // still held and its own trigger is single (REQ-single-trigger-legatos-a-mono-line).
      const continues = from !== undefined && this.heldNotes.has(from);
      const restrikes = (env: 'amp' | 'fil') => !(continues || (this.singleTrigger[env] && anySounding));
      const retriggerAmp = restrikes('amp');
      const retriggerFil = restrikes('fil');
      const used: Voice[] = [];
      for (let i = 0; i < count; i++) {
        const v = this.voices[i]!;
        // Mono reuses the SAME voices for every note, so without this each held
        // key keeps an entry naming them and releasing an older key sends
        // noteOff to the voice now sounding the newer note — the invariant of
        // REQ-a-stolen-voice-leaves-the-held-list, violated by construction
        // rather than by stealing. Evicting leaves exactly one entry: the
        // newest note.
        this.evictVoice(v);
        v.noteOn(note, velocity, t, { ...base, detuneCents: this.unisonOffset(i, count), retriggerAmp, retriggerFil });
        used.push(v);
      }
      this.heldNotes.set(note, used);
      return;
    }

    if (from !== undefined) {
      if (this.continueNote(from, note, velocity, t, base)) return;
      // Its voices are gone — stolen by another note. Whatever still claims the
      // old note goes, so the caller never strands it, and this one strikes.
      if (from !== note) this.releaseNote(from, t);
    }

    const existing = this.heldNotes.get(note);
    if (existing && existing.some((v) => v.state !== 'idle')) {
      for (let i = 0; i < existing.length; i++) {
        existing[i]!.noteOn(note, velocity, t, { ...base, detuneCents: this.unisonOffset(i, existing.length) });
      }
      return;
    }
    const used: Voice[] = [];
    for (let i = 0; i < count; i++) {
      const v = this.pickVoice();
      // Taking a voice hands it to this note, so whatever note held it before must
      // stop claiming it (REQ-a-stolen-voice-leaves-the-held-list). Without this the old note's entry still names the
      // voice, and releasing that key sends noteOff to a voice now sounding
      // something else — audible as "let go of one key, a different note stops".
      this.evictVoice(v);
      v.noteOn(note, velocity, t, { ...base, detuneCents: this.unisonOffset(i, count) });
      used.push(v);
    }
    this.heldNotes.set(note, used);
  }

  /**
   * Re-file `from`'s voices under `note` and move them there without striking
   * (voicing.md REQ-a-legato-note-takes-over-the-held-voices). False — and nothing
   * touched — when `from` holds no voice that is still playing.
   *
   * A pitch some other source already holds is JOINED, not overwritten: replacing
   * its entry would orphan that source's voices, which no release could then reach.
   * Sharing one entry is the same collapse two tracks on one pitch already make
   * (sequencer.md REQ-two-tracks-on-one-pitch-share-a-pan).
   */
  private continueNote(from: number, note: number, velocity: number, t: number, base: VoiceNoteOptions): boolean {
    const vs = this.heldNotes.get(from);
    if (!vs || vs.length === 0 || vs.some((v) => v.state !== 'playing')) return false;
    this.heldNotes.delete(from);
    for (let i = 0; i < vs.length; i++) {
      vs[i]!.noteOn(note, velocity, t, {
        ...base, detuneCents: this.unisonOffset(i, vs.length), retriggerAmp: false, retriggerFil: false,
      });
    }
    const joined = this.heldNotes.get(note);
    this.heldNotes.set(note, joined ? [...joined, ...vs] : vs);
    return true;
  }

  /**
   * A sequencer track's pan knob moved (sequencer.md REQ-a-seq-track-carries-a-pan).
   * Every voice decides for itself whether it is sounding that track, so a knob
   * turned over a held note moves it rather than waiting for the next one.
   */
  setGroupPan(group: number, pan: number): void {
    for (const v of this.voices) v.setGroupPan(group, pan);
  }

  /**
   * Engage or drop the per-voice spread stage across the whole pool
   * (sequencer.md REQ-the-spread-stage-engages-off-centre). Both halves are
   * pool-wide because the decision is: the panned edges are in circuit, or none
   * of them are.
   */
  setSpread(on: boolean): void {
    for (const v of this.voices) v.setSpread(on);
  }

  dropSpread(): void {
    for (const v of this.voices) v.dropSpread();
  }

  /** Release a note at the given audio time — a live release with the same
   *  margin as a live note, so a quick tap still releases after it attacks. */
  releaseNote(note: number, when?: number): void {
    const t = when ?? liveStartTime(this.ctx);
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
   * no voices at all (REQ-a-stolen-voice-leaves-the-held-list). Upholds the invariant `releaseNote` depends on: a
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
