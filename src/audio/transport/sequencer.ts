import type { Arrangement } from './arrangement';
import type { Performance } from './performance';
import type { PatternStore, SeqStep } from '../../state/patterns';
import { SEQ_TRACK_COUNT } from '../../state/patterns';
import type { SynthOutput } from './note-output';
import { rollProb, stepHits } from './step-hits';
import type { TickSubscriber } from './tick-source';
import { ListenerSet } from '../../utils/listeners';

export type StepListener = (step: number) => void;
/** (midi note, audio time it sounds, audio time it releases). */
export type SeqNoteListener = (note: number, when: number, releaseAt: number) => void;

/**
 * Per-track held-note state. Each of the four tracks is independently
 * monophonic — it owns its ringing note and its tie flag — so four active
 * tracks layer into a chord through the shared voice pool (sequencer.md REQ-8)
 * without any of them stealing another's release.
 */
interface SeqTrackState {
  lastPlayedNote: number;
  lastReleaseAt: number;
  prevTied: boolean;
  muted: boolean;
}

const newTrackState = (): SeqTrackState =>
  ({ lastPlayedNote: -1, lastReleaseAt: 0, prevTied: false, muted: false });

/**
 * Four-track 16-step note sequencer. Triggers the synth engine on each active
 * step of each track. Keyboard input still passes through (it can layer on top).
 *
 * Tracks 2..4 only sound in **poly** voicing (REQ-9): in mono they would fight
 * over the single voice and produce last-note-wins mush, so they are gated
 * rather than silently mixed. Their data is untouched either way.
 */
export class StepSequencer {
  private enabled = false;
  private muted = false;
  private polyphonic = true;
  private readonly tracks: SeqTrackState[] =
    Array.from({ length: SEQ_TRACK_COUNT }, newTrackState);
  private readonly stepListeners = new ListenerSet<[number]>();
  private readonly noteListeners = new ListenerSet<[number, number, number]>();

  constructor(
    private readonly output: SynthOutput,
    private readonly clock: TickSubscriber,
    private readonly patterns: PatternStore,
    private readonly arrangement: Arrangement,
    private readonly perf: Performance,
  ) {
    clock.onTick((step, when) => this.onTick(step, when));
    // A playhead jump makes the per-track tie/held-note state meaningless: it
    // only ever describes the *adjacent* step. Left alone, a note tied at the
    // old position slurs into the new one — or never gets released at all
    // (sequencer.md REQ-14).
    clock.onSeek(() => this.releaseAll());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.releaseAll();
  }

  /** Poly voicing gate for tracks 2..4 (REQ-9). Track 1 always plays. */
  setPolyphonic(poly: boolean): void {
    if (poly === this.polyphonic) return;
    this.polyphonic = poly;
    if (!poly) {
      for (let t = 1; t < this.tracks.length; t++) this.releaseTrack(this.tracks[t]!);
    }
  }

  /** Per-track mute (REQ-10): stop triggering, keep the playhead advancing. */
  setTrackMuted(track: number, muted: boolean): void {
    const st = this.tracks[track];
    if (!st || st.muted === muted) return;
    st.muted = muted;
    if (muted) this.releaseTrack(st);
  }

  private releaseTrack(st: SeqTrackState, when?: number): void {
    if (st.lastPlayedNote >= 0) {
      this.output.releaseNote(st.lastPlayedNote, when);
      st.lastPlayedNote = -1;
    }
    st.prevTied = false;
  }

  private releaseAll(when?: number): void {
    for (const st of this.tracks) this.releaseTrack(st, when);
  }

  /**
   * Song-tab DJ mute: suppress note triggering while the pattern keeps running
   * (the playhead still advances). Live keyboard input is unaffected — it never
   * routed through the sequencer. Releases any ringing sequenced note at once.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.releaseAll();
  }

  onStep(fn: StepListener): () => void {
    return this.stepListeners.add(fn);
  }

  /** Fires when a step triggers a note, with its scheduled audio times. */
  onNote(fn: SeqNoteListener): () => void {
    return this.noteListeners.add(fn);
  }

  private onTick(step: number, when: number): void {
    if (!this.enabled) return;
    const idx = this.perf.stepIndex(step);
    this.stepListeners.emit(idx);
    // Arrangement rest bar: play nothing this bar, but release notes tied into
    // the rest so they don't ring forever (mirrors the per-step rest path).
    if (this.arrangement.seqResting) {
      for (const st of this.tracks) {
        if (st.prevTied) this.releaseTrack(st, when);
        st.prevTied = false;
      }
      return;
    }
    // Muted: keep the playhead moving (above) but trigger nothing. setMuted has
    // already released any held note, so just bail before scheduling.
    if (this.muted) return;

    const bank = this.patterns.seqBank(this.arrangement.seqPlayBank);
    // Track 1 always plays; 2..4 need poly voicing (REQ-9) and their own
    // un-muted state (REQ-10). Each track advances independently below.
    const last = this.polyphonic ? this.tracks.length : 1;
    for (let t = 0; t < last; t++) {
      const st = this.tracks[t]!;
      if (st.muted) continue;
      this.tickTrack(bank[t]?.[idx], st, when);
    }
  }

  /** One track's step. Its held-note/tie handling is exactly the pre-v3
   *  monophonic logic, now scoped to `st` instead of the whole machine. */
  private tickTrack(s: SeqStep | undefined, st: SeqTrackState, when: number): void {
    // Rest (or step skipped by probability): let any held note finish, but a
    // tie into a rest must be released here so it doesn't ring forever.
    if (!s || !s.on || !rollProb(s.prob)) {
      if (st.prevTied) this.releaseTrack(st, when);
      st.prevTied = false;
      return;
    }

    // Release the previous note before this attack — unless the previous step
    // tied, in which case we leave its voice ringing so the engine's mono
    // glide slurs into the new note (audible slide needs mixer.glide > 0).
    if (!st.prevTied && st.lastPlayedNote >= 0) this.output.releaseNote(st.lastPlayedNote, when);

    const hits = stepHits(s, when, this.clock.sixteenthDuration());
    for (const h of hits) {
      this.output.playNote(s.note, s.velocity, h.t);
      // The final sub-hit holds (no release) when the step ties into the next.
      if (!h.holds) this.output.releaseNote(s.note, h.gateEnd);
    }
    st.lastPlayedNote = s.note;
    st.lastReleaseAt = hits[hits.length - 1]!.gateEnd;
    st.prevTied = s.tie;
    this.noteListeners.emit(s.note, when, hits[0]!.gateEnd);
  }
}
