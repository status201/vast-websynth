import type { Clock } from '../transport/clock';
import type { Arrangement } from '../transport/arrangement';
import type { CapturedAudio, RecorderNode } from './node';
import { SEQ_LENGTH } from '../../state/patterns';
import { clamp } from '../../utils/math';
import { encodeWav, encodeMp3, triggerDownload } from './encode';

export type ExportFormat = 'wav' | 'mp3';

/**
 * `idle → recording ⇄ paused → review → encoding → idle` (audio-export.md
 * REQ-4). `review` holds a finished manual take that has not been written yet;
 * an automatic export pass skips it. `encoding` is held across the encode+
 * download await so a UI can say "preparing your download" rather than going
 * inert and reading as stalled.
 */
export type RecorderPhase = 'idle' | 'recording' | 'paused' | 'review' | 'encoding';

export interface ExportOpts {
  /** Passes of the song to render. Clamped 1..MAX_RUNS; default 1. */
  runs?: number;
  /** Capture a whole bar of silence after the last step instead of TAIL_MS. */
  tailBar?: boolean;
}

/** Bars rendered by auto Export Song when no chain lane is enabled. Exported so
 *  the options modal's length note quotes the same number the render will use. */
export const FALLBACK_BARS = 4;
/** Grace period after the final bar so the worklet captures scheduled
 *  look-ahead audio + reverb/release tails before we read the buffer. */
const TAIL_MS = 350;
/** Ceiling on `ExportOpts.runs` — export renders in real time, so ten passes of
 *  a long song is already a ten-minute wait (audio-export.md open questions). */
export const MAX_RUNS = 10;

/**
 * Orchestrates transport + capture node + encoding + download.
 *
 * - `exportSong(fmt, opts?)` restarts from step 0, renders `runs` passes of the
 *   longest enabled arrangement chain (or FALLBACK_BARS), auto-stops, downloads.
 * - The manual verbs (`startManual`/`pauseManual`/`resumeManual`/`stopManual`)
 *   drive a free-form take, which parks in `review` until the caller decides:
 *   `saveTake(fmt)` writes it, `discardTake()` throws it away. Stopping never
 *   downloads by itself — that was v6's behaviour and it meant a fluffed take
 *   was on disk before you could refuse it.
 */
export class RecorderController {
  private _phase: RecorderPhase = 'idle';
  /** True while an automatic export pass owns the transport (REQ-2's seek guard
   *  keys off this, NOT off "a capture is running"). */
  private exporting = false;
  private finishing = false;
  /** True while `stopManual` awaits the worklet's flush (REQ-6b). */
  private stopping = false;
  private unsubTick: (() => void) | null = null;
  /** Absolute step the in-flight export ends at; 0 when none. Drives progress. */
  private stopAtStep = 0;
  /** Ticks seen since this export began — the wrap-free counterpart to `stopAtStep`. */
  private elapsedSteps = 0;
  /** The tail-grace timeout, so a cancel can disarm it. */
  private tailTimer: number | undefined;
  /** The finished take awaiting Save/Discard; null in every other phase. */
  private take: CapturedAudio | null = null;
  private readonly phaseListeners = new Set<(phase: RecorderPhase) => void>();

  constructor(
    private readonly clock: Clock,
    private readonly arrangement: Arrangement,
    private readonly node: RecorderNode,
  ) {}

  get phase(): RecorderPhase { return this._phase; }

  /** Audio is being taken right now — don't cut its samples, don't fight it
   *  for the transport. Read by Engine's stop-choke and by the bank render. */
  isCapturing(): boolean { return this._phase === 'recording' || this._phase === 'paused'; }

  /** An automatic pass owns the transport, so its absolute step bounds must not
   *  move under it (transport-position.md REQ-6). A manual take has no bounds
   *  and deliberately does not take that guard. */
  isExporting(): boolean { return this.exporting; }

  /**
   * Length of the **current** take in seconds — what will actually be written,
   * with any paused stretch excluded (it never entered the buffer). Derived
   * rather than accumulated, so a UI that stops watching and comes back is
   * instantly right.
   *
   * `idle` is 0: there is no take. The node's frame counter is only cleared by
   * `start()`, so without this it kept reporting the *previous* take's length
   * after a save or discard and the Record window sat on a stale `1:34`.
   */
  capturedSeconds(): number {
    if (this._phase === 'idle') return 0;
    const t = this.take;
    if (t) return t.left.length / t.sampleRate;
    return this.node.capturedFrames / this.node.sampleRate;
  }

  onPhase(fn: (phase: RecorderPhase) => void): () => void {
    this.phaseListeners.add(fn);
    return () => { this.phaseListeners.delete(fn); };
  }

  private setPhase(phase: RecorderPhase): void {
    if (this._phase === phase) return;
    this._phase = phase;
    for (const l of this.phaseListeners) l(phase);
  }

  private begin(): void {
    if (this._phase !== 'idle') return;
    this.take = null;
    this.node.start();
    this.finishing = false;
    this.setPhase('recording');
  }

  // ---------- Manual take (record-window.md) ----------

  startManual(): void {
    if (this._phase !== 'idle' || this.exporting) return;
    this.begin();
    if (!this.clock.playing) this.clock.start();
  }

  /** Suspend capture. The TRANSPORT keeps running — you drop out of the take
   *  and punch back in, and the paused stretch is absent from the file. */
  pauseManual(): void {
    if (this._phase !== 'recording' || this.exporting) return;
    this.node.pause();
    this.setPhase('paused');
  }

  resumeManual(): void {
    if (this._phase !== 'paused') return;
    this.node.resume();
    this.setPhase('recording');
  }

  /** End the take and park it for review. Writes nothing; leaves the transport
   *  running (audio-export.md REQ-4).
   *
   *  Async because the recorder waits for the worklet's final batch (REQ-6b).
   *  The phase only becomes `review` once the take is actually in hand, or the
   *  window would offer Save with nothing to save; `stopping` guards the gap,
   *  since `isCapturing()` stays true across the await. */
  async stopManual(): Promise<void> {
    if (!this.isCapturing() || this.exporting || this.stopping) return;
    this.stopping = true;
    try {
      this.take = await this.node.stop();
      this.setPhase('review');
    } finally {
      this.stopping = false;
    }
  }

  /**
   * Encode and download the reviewed take. Async only because MP3 lazily
   * imports lamejs (REQ-7); the buffer is released before the await.
   *
   * The phase is `encoding` *across* the await, not `idle` — those seconds are
   * work, and reporting them as nothing is what made the UI look stalled.
   */
  async saveTake(format: ExportFormat): Promise<void> {
    const take = this.take;
    if (this._phase !== 'review' || !take) return;
    this.take = null;
    this.setPhase('encoding');
    try {
      await download(take, format);
    } finally {
      this.setPhase('idle');
    }
  }

  /** Throw the take away. Must null the buffer — a minute of stereo 48 k float
   *  is ~23 MB, and nothing else references it. */
  discardTake(): void {
    // Fire-and-forget: the flushed frames are being thrown away either way, so
    // there is nothing to wait for — but the worklet must still stop capturing.
    if (this.isCapturing()) void this.node.stop();
    this.take = null;
    this.setPhase('idle');
  }

  // ---------- Automatic song export ----------

  /**
   * Render `runs` full passes of the song and download the result.
   *
   * `opts` is optional and defaults to v6's exact behaviour — one pass, a
   * TAIL_MS grace — because `scripts/audio-bench.mjs` calls this with no
   * options and `verify-audio-by-ear.md` depends on those takes being bar-exact
   * and repeatable. The UI checkbox defaults the other way (audio-export REQ-3).
   */
  exportSong(format: ExportFormat, opts?: ExportOpts): void {
    if (this._phase !== 'idle') return; // a capture (or an unsaved take) is in the way
    // The three AUDIBLE lanes only — the motion lane is param automation, and
    // widening the rendered length to include it would change what every
    // existing song exports (audio-export.md REQ-2, transport-window.md).
    const bars = this.arrangement.songBars(['seq', 'drum', 'sampler']) || FALLBACK_BARS;
    const runs = Math.round(clamp(opts?.runs ?? 1, 1, MAX_RUNS));
    // Repeats need nothing from the arrangement: every lane already wraps its
    // slot index (`pos % steps.length`), so a longer capture just replays it.
    const stopAtStep = bars * runs * SEQ_LENGTH;
    // A whole bar of silence beats TAIL_MS for a long reverb. It is a longer
    // WAIT, not an extra arrangement bar: bar N+1 would replay chain slot 0,
    // which is music. The transport is already stopped here, so nothing new
    // triggers and the tails ring into real silence.
    const tailMs = opts?.tailBar
      ? SEQ_LENGTH * this.clock.sixteenthDuration() * 1000
      : TAIL_MS;

    this.clock.stop();
    this.exporting = true;
    this.stopAtStep = stopAtStep;
    this.elapsedSteps = 0;
    this.begin();             // arm before audio so nothing is clipped
    // Count steps ELAPSED rather than testing the clock's absolute step: `_step`
    // wraps at `& 0xffff` (transport.md REQ-5), so `step >= stopAtStep` was
    // unreachable once `bars × runs > 4096` and the export simply never stopped,
    // recording into memory indefinitely. `bars` is the arrangement chain length,
    // which an imported song controls — so counting removes the ceiling instead
    // of capping the song (audio-export.md REQ-2).
    this.unsubTick = this.clock.onTick(() => {
      // Post-increment, so `step` is 0,1,2,… — exactly what `clock.step` read
      // before, just without the 16-bit wrap. The rendered length is therefore
      // byte-identical to v8's (it stops on the FIRST tick at or past the
      // bound, so that step is the last one rendered), which the audio bench
      // and verify-audio-by-ear.md depend on.
      const step = this.elapsedSteps++;
      if (step >= stopAtStep) {
        this.clock.stop();
        this.tailTimer = window.setTimeout(() => void this.finishExport(format), tailMs);
      }
    });
    // The 0 is explicit: the capture must begin at the top of the arrangement,
    // and a plain start() now resumes from the user's cue (transport.md REQ-7),
    // which would truncate the export silently. Fires onStart → arrangement.
    this.clock.start(0);
  }

  /**
   * How far through the current export pass, 0..1 — `0` whenever one is not
   * rendering. Derived from the clock rather than counted, so a UI that
   * subscribes late (or repaints on its own schedule) is always right.
   */
  exportProgress(): number {
    if (this._phase !== 'recording' || !this.exporting || this.stopAtStep <= 0) return 0;
    return clamp(this.elapsedSteps / this.stopAtStep, 0, 1);
  }

  /**
   * Abort a render in flight and write nothing (REQ-10). Export is real time —
   * ten runs of a long song is a ten-minute wait — so the progress UI needs a
   * Cancel that genuinely cancels; a dead button beside a long bar is worse than
   * no button. A no-op unless a pass is actually recording.
   */
  cancelExport(): void {
    if (!this.exporting || this._phase !== 'recording') return;
    this.clearExport();
    this.clock.stop();
    this.node.stop();   // drop the buffer; nothing is encoded or downloaded
    this.setPhase('idle');
  }

  /** Release everything the in-flight pass is holding. Shared by cancel and the
   *  normal finish, so a cancelled render can't leave a tail timer armed. */
  private clearExport(): void {
    if (this.unsubTick) { this.unsubTick(); this.unsubTick = null; }
    if (this.tailTimer !== undefined) {
      window.clearTimeout(this.tailTimer);
      this.tailTimer = undefined;
    }
    this.exporting = false;
    this.stopAtStep = 0;
    this.elapsedSteps = 0;
  }

  /** An export is automatic, so it never parks in `review` — it stops, encodes
   *  and downloads in one go, then returns to idle. It does hold `encoding`
   *  across the encode, though, so the modal driving it can say so. */
  private async finishExport(format: ExportFormat): Promise<void> {
    if (!this.isCapturing() || this.finishing) return;
    this.finishing = true;
    // `exporting` stays true across the encode: the operation is atomic from
    // the outside, so a second export cannot start mid-encode.
    if (this.unsubTick) { this.unsubTick(); this.unsubTick = null; }
    this.tailTimer = undefined;
    this.stopAtStep = 0;
    this.elapsedSteps = 0;
    // Enter `encoding` before awaiting the recorder's flush (REQ-6b), so the tail
    // firing still moves the phase synchronously. The alternative left a window
    // where the transport had stopped but the modal still read `recording`.
    this.setPhase('encoding');
    const captured = await this.node.stop();
    try {
      await download(captured, format);
    } finally {
      this.exporting = false;
      this.setPhase('idle');
    }
  }
}

/** Encode + save, or do nothing at all if the capture came up empty. */
async function download({ left, right, sampleRate }: CapturedAudio, format: ExportFormat): Promise<void> {
  if (left.length === 0) return; // nothing captured — skip an empty download
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = format === 'mp3'
    ? await encodeMp3(left, right, sampleRate)
    : encodeWav(left, right, sampleRate);
  // From the blob, not from `format`: an unsupported rate falls back to WAV.
  const ext = blob.type === 'audio/mpeg' ? 'mp3' : 'wav';
  triggerDownload(blob, `websynth-${stamp}.${ext}`);
}
