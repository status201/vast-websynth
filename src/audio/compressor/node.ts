export type CompressorMode = 'fet' | 'vca';

/**
 * Thin wrapper around the `hardware-compressor` AudioWorklet. `loadModule()`
 * must be awaited once per context before `create()` — which is synchronous,
 * since AudioWorkletNode construction is sync once the module is registered.
 * The processor posts its current gain reduction (dB, ~31 Hz) on the port;
 * subscribe via `onGr`.
 */
export class CompressorNode {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly threshold: AudioParam;
  readonly ratio: AudioParam;
  readonly attack: AudioParam;
  readonly release: AudioParam;
  readonly autoRelease: AudioParam;
  readonly makeup: AudioParam;
  onGr: ((db: number) => void) | null = null;

  private constructor(node: AudioWorkletNode) {
    this.input = node;
    this.output = node;
    this.threshold = node.parameters.get('threshold')!;
    this.ratio = node.parameters.get('ratio')!;
    this.attack = node.parameters.get('attack')!;
    this.release = node.parameters.get('release')!;
    this.autoRelease = node.parameters.get('autoRelease')!;
    this.makeup = node.parameters.get('makeup')!;
    node.port.onmessage = (e: MessageEvent) => {
      this.onGr?.(e.data as number);
    };
  }

  static create(ctx: AudioContext, mode: CompressorMode): CompressorNode {
    const node = new AudioWorkletNode(ctx, 'hardware-compressor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { mode },
    });
    return new CompressorNode(node);
  }

  static async loadModule(ctx: AudioContext): Promise<void> {
    await ctx.audioWorklet.addModule('/worklets/compressor.js');
  }
}
