/**
 * Thin wrapper around the `recorder` AudioWorklet (mirrors LadderFilterNode).
 * Tap it off `master`; it has zero outputs so it never reaches the
 * destination. While armed, the worklet posts stereo Float32 chunks which
 * we accumulate, then concatenate into one contiguous buffer on stop().
 */
export interface CapturedAudio {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

export class RecorderNode {
  readonly input: AudioNode;

  private chunksL: Float32Array[] = [];
  private chunksR: Float32Array[] = [];
  /** Absolute frame index of the first captured sample (audio-export REQ-6);
   *  null until the first chunk of the current capture arrives. */
  private _firstFrame: number | null = null;
  /** Frames captured so far — what `stop()` is about to return the length of.
   *  Reset by `start()` and, deliberately, NOT by `pause()`: it is the take's
   *  true duration with paused time excluded (audio-export REQ-4). */
  private _capturedFrames = 0;

  private constructor(
    private readonly node: AudioWorkletNode,
    readonly sampleRate: number,
  ) {
    this.input = node;
    node.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { l?: Float32Array; r?: Float32Array; f?: number };
      if (d && d.l && d.r) {
        if (this._firstFrame === null && typeof d.f === 'number') this._firstFrame = d.f;
        this.chunksL.push(d.l);
        this.chunksR.push(d.r);
        this._capturedFrames += d.l.length;
      }
    };
  }

  /**
   * REQ-6. Only meaningful for an **un-paused** capture: a pause removes real
   * time from the stream, so `firstFrame + n` stops naming frame `n` of the
   * take. The one consumer that does this arithmetic (render-to-sampler) is
   * automatic and never pauses.
   */
  get firstFrame(): number | null { return this._firstFrame; }

  get capturedFrames(): number { return this._capturedFrames; }

  static async loadModule(ctx: AudioContext): Promise<void> {
    await ctx.audioWorklet.addModule('/worklets/recorder.js');
  }

  static async create(ctx: AudioContext): Promise<RecorderNode> {
    const node = new AudioWorkletNode(ctx, 'recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    return new RecorderNode(node, ctx.sampleRate);
  }

  start(): void {
    this.chunksL = [];
    this.chunksR = [];
    this._firstFrame = null;
    this._capturedFrames = 0;
    this.node.port.postMessage({ cmd: 'start' });
  }

  /**
   * Suspend capture, keeping everything taken so far (audio-export REQ-4).
   * The worklet has only ever understood `start`/`stop` — the *destructive*
   * half of a restart is `start()`'s chunk-clearing, right here on the node.
   * So pause/resume are those same two messages with the clearing left out, and
   * the paused stretch is simply absent from the buffer: splice-out for free,
   * with no worklet change.
   */
  pause(): void {
    this.node.port.postMessage({ cmd: 'stop' });
  }

  resume(): void {
    this.node.port.postMessage({ cmd: 'start' });
  }

  stop(): CapturedAudio {
    this.node.port.postMessage({ cmd: 'stop' });
    const left = concat(this.chunksL);
    const right = concat(this.chunksR);
    // Free the chunk lists so the encode step doesn't hold both.
    this.chunksL = [];
    this.chunksR = [];
    return { left, right, sampleRate: this.sampleRate };
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
