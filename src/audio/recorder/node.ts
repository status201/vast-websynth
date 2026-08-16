/**
 * Thin wrapper around the `recorder` AudioWorklet (mirrors LadderFilterNode).
 * Tap it off `master`; it has zero outputs so it never reaches the
 * destination. While armed, the worklet posts stereo Float32 chunks which
 * we accumulate, then concatenate into one contiguous buffer on stop().
 */
/**
 * Quanta the worklet accumulates per message (audio-export.md REQ-6b). Mirrors
 * `BATCH_QUANTA` in `public/worklets/recorder.js`, which cannot import it — the
 * worklet is loaded as a bare module by URL, outside the bundle. Declared here
 * so the contract has one written-down home and the tests can name it.
 */
export const RECORD_BATCH_QUANTA = 16;

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
  /** Set by `dispose()` — a released node posts nothing and captures nothing. */
  private disposed = false;

  /** Resolvers for an in-flight `stop`/`pause`, waiting on the worklet's flush. */
  private pendingFlush: (() => void)[] = [];

  private constructor(
    private readonly node: AudioWorkletNode,
    readonly sampleRate: number,
  ) {
    this.input = node;
    node.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { l?: Float32Array; r?: Float32Array; f?: number; done?: boolean };
      if (!d) return;
      if (d.l && d.r) {
        if (this._firstFrame === null && typeof d.f === 'number') this._firstFrame = d.f;
        this.chunksL.push(d.l);
        this.chunksR.push(d.r);
        this._capturedFrames += d.l.length;
      }
      // The flush reply lands after its own frames are appended above, so a
      // waiter always sees the complete take (audio-export.md REQ-6b).
      if (d.done) {
        const waiters = this.pendingFlush;
        this.pendingFlush = [];
        for (const resolve of waiters) resolve();
      }
    };
  }

  /**
   * Ask the worklet to stop capturing and hand back its partial batch, resolving
   * once that batch has been appended.
   *
   * The worklet is batching, so the frames of the current batch exist only there
   * until it is asked to flush — reading `chunksL` without waiting would drop up
   * to `RECORD_BATCH_QUANTA` quanta off the end of every take.
   *
   * A node that was never started (or has been disposed) has no worklet activity
   * to wait on and resolves immediately, so a stray `stop()` cannot hang.
   */
  private flush(cmd: 'stop' | 'pause'): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const waited = new Promise<void>((resolve) => { this.pendingFlush.push(resolve); });
    this.node.port.postMessage({ cmd });
    return waited;
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
    if (this.disposed) return;
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
  pause(): Promise<void> {
    // Flushes like a stop, so the paused stretch cannot straddle a batch.
    return this.flush('pause');
  }

  resume(): void {
    if (this.disposed) return;
    this.node.port.postMessage({ cmd: 'start' });
  }

  async stop(): Promise<CapturedAudio> {
    if (this.disposed) return { left: EMPTY, right: EMPTY, sampleRate: this.sampleRate };
    await this.flush('stop');
    const left = concat(this.chunksL);
    const right = concat(this.chunksR);
    // Free the chunk lists so the encode step doesn't hold both.
    this.chunksL = [];
    this.chunksR = [];
    return { left, right, sampleRate: this.sampleRate };
  }

  /**
   * Release the node for good (sample-recorder.md REQ-6).
   *
   * Only for a node with an *end* — the mic session's fresh one. The engine's two
   * master-tapped recorders live as long as the graph and must never be disposed.
   *
   * Both halves matter, and they leak different things: the `AudioWorkletNode`
   * keeps its processor alive on the render thread, while `port.onmessage` keeps
   * the closure — and through it the captured chunk arrays — alive on the main
   * thread. Dropping only one of the two still leaks.
   *
   * Idempotent and terminal: it is reachable from cancel, save and re-open alike,
   * and afterwards `start`/`stop` are no-ops rather than posts to a dead port.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Release anything still waiting on a flush that will now never arrive.
    const waiters = this.pendingFlush;
    this.pendingFlush = [];
    for (const resolve of waiters) resolve();
    this.node.port.onmessage = null;
    try { this.node.disconnect(); } catch { /* already disconnected */ }
    this.chunksL = [];
    this.chunksR = [];
  }
}

const EMPTY = new Float32Array(0);

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
