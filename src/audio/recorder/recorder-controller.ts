import type { Clock } from '../transport/clock';
import type { Arrangement, ChainLane } from '../transport/arrangement';
import type { RecorderNode } from './node';
import { SEQ_LENGTH } from '../../state/patterns';
import { encodeWav, encodeMp3, triggerDownload } from './encode';

export type ExportFormat = 'wav' | 'mp3';

/** Bars rendered by auto Export Song when no chain lane is enabled. */
const FALLBACK_BARS = 4;
/** Grace period after the final bar so the worklet captures scheduled
 *  look-ahead audio + reverb/release tails before we read the buffer. */
const TAIL_MS = 350;

/**
 * Orchestrates transport + capture node + encoding + download.
 *
 * - `exportSong(fmt)` restarts from the top, renders exactly one pass of the
 *   longest enabled arrangement chain (or FALLBACK_BARS), auto-stops, downloads.
 * - `toggleManual(fmt)` is a free-form record toggle (starts transport if
 *   stopped); a second call stops + downloads, leaving the transport running.
 */
export class RecorderController {
  private armed = false;
  private finishing = false;
  private unsubTick: (() => void) | null = null;
  private readonly stateListeners = new Set<(recording: boolean) => void>();

  constructor(
    private readonly clock: Clock,
    private readonly arrangement: Arrangement,
    private readonly node: RecorderNode,
  ) {}

  isRecording(): boolean { return this.armed; }

  onState(fn: (recording: boolean) => void): () => void {
    this.stateListeners.add(fn);
    return () => { this.stateListeners.delete(fn); };
  }

  private notify(): void {
    for (const l of this.stateListeners) l(this.armed);
  }

  private begin(): void {
    if (this.armed) return;
    this.node.start();
    this.armed = true;
    this.finishing = false;
    this.notify();
  }

  /**
   * Async only because MP3 encoding lazily imports lamejs (audio-export.md
   * REQ-7). The `finishing` guard and `node.stop()` both run *before* the
   * await, so capture timing and re-entrancy are unchanged; callers
   * fire-and-forget. A download one microtask later is fine — `exportSong`
   * already downloads from a timeout with no user activation at all.
   */
  private async finish(format: ExportFormat): Promise<void> {
    if (!this.armed || this.finishing) return;
    this.finishing = true;
    if (this.unsubTick) { this.unsubTick(); this.unsubTick = null; }
    const { left, right, sampleRate } = this.node.stop();
    this.armed = false;
    this.notify();

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (left.length === 0) return; // nothing captured — skip empty download
    const blob = format === 'mp3'
      ? await encodeMp3(left, right, sampleRate)
      : encodeWav(left, right, sampleRate);
    const ext = blob.type === 'audio/mpeg' ? 'mp3' : 'wav';
    triggerDownload(blob, `websynth-${stamp}.${ext}`);
  }

  /** Manual free-form record toggle. */
  toggleManual(format: ExportFormat): void {
    if (this.armed) { void this.finish(format); return; }
    this.begin();
    if (!this.clock.playing) this.clock.start();
  }

  /** Render one full pass of the song and download it. */
  exportSong(format: ExportFormat): void {
    if (this.armed) return; // a recording is already in flight
    const barsFor = (lane: ChainLane) =>
      lane.enabled && lane.steps.length ? lane.steps.length : 0;
    const bars = Math.max(
      barsFor(this.arrangement.seq),
      barsFor(this.arrangement.drum),
      barsFor(this.arrangement.sampler),
    ) || FALLBACK_BARS;
    const stopAtStep = bars * SEQ_LENGTH;

    this.clock.stop();
    this.begin();             // arm before audio so nothing is clipped
    this.unsubTick = this.clock.onTick((step) => {
      if (step >= stopAtStep) {
        this.clock.stop();
        window.setTimeout(() => void this.finish(format), TAIL_MS);
      }
    });
    this.clock.start();       // resets step to 0, fires onStart → arrangement
  }
}
