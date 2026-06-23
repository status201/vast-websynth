import type { Arrangement } from './arrangement';
import type { Performance } from './performance';
import type { PatternStore } from '../../state/patterns';
import { SEQ_LENGTH } from '../../state/patterns';
import type { SynthOutput } from './note-output';
import { rollProb, stepHits } from './step-hits';
import type { TickSubscriber } from './tick-source';

export type StepListener = (step: number) => void;
/** (midi note, audio time it sounds, audio time it releases). */
export type SeqNoteListener = (note: number, when: number, releaseAt: number) => void;

/**
 * Monophonic 16-step note sequencer. Triggers the synth engine on each
 * active step. Keyboard input still passes through (it can layer on top).
 */
export class StepSequencer {
  private enabled = false;
  private muted = false;
  private lastPlayedNote = -1;
  private lastReleaseAt = 0;
  private prevTied = false;
  private readonly stepListeners = new Set<StepListener>();
  private readonly noteListeners = new Set<SeqNoteListener>();

  constructor(
    private readonly output: SynthOutput,
    private readonly clock: TickSubscriber,
    private readonly patterns: PatternStore,
    private readonly arrangement: Arrangement,
    private readonly perf: Performance,
  ) {
    clock.onTick((step, when) => this.onTick(step, when));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on && this.lastPlayedNote >= 0) {
      this.output.releaseNote(this.lastPlayedNote);
      this.lastPlayedNote = -1;
    }
    if (!on) this.prevTied = false;
  }

  /**
   * Song-tab DJ mute: suppress note triggering while the pattern keeps running
   * (the playhead still advances). Live keyboard input is unaffected — it never
   * routed through the sequencer. Releases any ringing sequenced note at once.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted && this.lastPlayedNote >= 0) {
      this.output.releaseNote(this.lastPlayedNote);
      this.lastPlayedNote = -1;
      this.prevTied = false;
    }
  }

  onStep(fn: StepListener): () => void {
    this.stepListeners.add(fn);
    return () => { this.stepListeners.delete(fn); };
  }

  /** Fires when a step triggers a note, with its scheduled audio times. */
  onNote(fn: SeqNoteListener): () => void {
    this.noteListeners.add(fn);
    return () => { this.noteListeners.delete(fn); };
  }

  private onTick(step: number, when: number): void {
    if (!this.enabled) return;
    const idx = this.perf.mapStep(step) % SEQ_LENGTH;
    for (const l of this.stepListeners) l(idx);
    // Muted: keep the playhead moving (above) but trigger nothing. setMuted has
    // already released any held note, so just bail before scheduling.
    if (this.muted) return;
    const s = this.patterns.seqBank(this.arrangement.seqPlayBank)[idx];

    // Rest (or step skipped by probability): let any held note finish, but a
    // tie into a rest must be released here so it doesn't ring forever.
    if (!s || !s.on || !rollProb(s.prob)) {
      if (this.prevTied && this.lastPlayedNote >= 0) {
        this.output.releaseNote(this.lastPlayedNote, when);
        this.lastPlayedNote = -1;
      }
      this.prevTied = false;
      return;
    }

    // Release the previous note before this attack — unless the previous step
    // tied, in which case we leave its voice ringing so the engine's mono
    // glide slurs into the new note (audible slide needs mixer.glide > 0).
    if (!this.prevTied && this.lastPlayedNote >= 0) this.output.releaseNote(this.lastPlayedNote, when);

    const hits = stepHits(s, when, this.clock.sixteenthDuration());
    for (const h of hits) {
      this.output.playNote(s.note, s.velocity, h.t);
      // The final sub-hit holds (no release) when the step ties into the next.
      if (!h.holds) this.output.releaseNote(s.note, h.gateEnd);
    }
    this.lastPlayedNote = s.note;
    this.lastReleaseAt = hits[hits.length - 1]!.gateEnd;
    this.prevTied = s.tie;
    for (const l of this.noteListeners) l(s.note, when, hits[0]!.gateEnd);
  }
}
