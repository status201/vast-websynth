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
      }
    };
  }

  get firstFrame(): number | null { return this._firstFrame; }

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
