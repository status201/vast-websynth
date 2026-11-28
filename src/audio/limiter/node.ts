import { loadWorkletModule } from '../worklet-module';

const MODULE_URL = '/worklets/limiter.js';

/**
 * Thin wrapper around the `master-limiter` AudioWorklet
 * (master-limiter.md). `loadModule()` must resolve before `create()`. The
 * processor posts its gain reduction (dB, ~31 Hz) on the port; subscribe via
 * `onGr`. Both params are dB and k-rate.
 */
export class LimiterNode {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly drive: AudioParam;
  readonly ceiling: AudioParam;
  onGr: ((db: number) => void) | null = null;

  private constructor(node: AudioWorkletNode) {
    this.input = node;
    this.output = node;
    this.drive = node.parameters.get('drive')!;
    this.ceiling = node.parameters.get('ceiling')!;
    node.port.onmessage = (e: MessageEvent) => {
      this.onGr?.(e.data as number);
    };
  }

  static create(ctx: AudioContext): LimiterNode {
    const node = new AudioWorkletNode(ctx, 'master-limiter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    return new LimiterNode(node);
  }

  /** Once per context; a failure is forgotten, so a later call retries. */
  static loadModule(ctx: AudioContext): Promise<void> {
    return loadWorkletModule(ctx, MODULE_URL);
  }
}
