import { capturedToAudioBuffer } from './audio-buffer';
import type { CapturedAudio } from './node';
import { clipFades, fadeOutAt } from '../clip-fades';
import { liveStartTime } from '../param-utils';

/**
 * The sample editor's audition player (sample-recorder.md
 * REQ-the-preview-fades-like-the-slot): one clip at a time, with the sampler's
 * own edges — in over `SAMPLER_ATTACK`, out over `CHOKE_FADE` as the buffer runs
 * out — and a Stop mid-clip that fades from the level it had reached instead of
 * cutting. Owns its nodes so the editor (UI) builds no audio graph of its own.
 *
 * It plays to `ctx.destination`, outside the master bus: an audition of raw
 * material, not a voice of the instrument.
 */
export class ClipPreview {
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private levelAt: ((at: number) => number) | null = null;
  private _startTime = 0;
  private _samples = 0;

  constructor(private readonly ctx: AudioContext) {}

  get playing(): boolean { return this.src !== null; }
  /** The context time the current clip started at. */
  get startTime(): number { return this._startTime; }
  /** The current clip's length in frames. */
  get samples(): number { return this._samples; }

  /**
   * Play `clip`, replacing whatever was playing. `onEnded` fires when the clip
   * runs out by itself — never for a `stop()` or a replacement.
   */
  play(clip: CapturedAudio, onEnded: () => void): void {
    this.stop();
    const node = this.ctx.createBufferSource();
    node.buffer = capturedToAudioBuffer(this.ctx, clip);
    const gain = this.ctx.createGain();
    const t = liveStartTime(this.ctx);
    this.levelAt = clipFades(gain.gain, t, node.buffer.duration);
    node.connect(gain).connect(this.ctx.destination);
    this._startTime = t;
    this._samples = Math.min(clip.left.length, clip.right.length);
    node.onended = (): void => {
      if (this.src !== node) return;
      this.stop(true);
      onEnded();
    };
    this.src = node;
    this.gain = gain;
    node.start(t);
  }

  /** `ended`: the clip ran out by itself, so there is nothing left to fade. */
  stop(ended = false): void {
    const src = this.src;
    if (!src) return;
    const gain = this.gain;
    const levelAt = this.levelAt;
    this.src = null;
    this.gain = null;
    this.levelAt = null;
    const release = (): void => {
      try { src.disconnect(); } catch { /* already disconnected */ }
      try { gain?.disconnect(); } catch { /* already disconnected */ }
    };
    if (ended || !gain || !levelAt) {
      try { src.stop(); } catch { /* already stopped */ }
      release();
      return;
    }
    // Mid-clip: fade from where the shape has got to, then stop, rather than
    // cutting on whatever sample is playing.
    const at = liveStartTime(this.ctx);
    const silentAt = fadeOutAt(gain.gain, at, levelAt(at));
    src.onended = release;
    try { src.stop(silentAt); } catch { release(); }
  }
}
