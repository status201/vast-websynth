/** One frame of cycle-library telemetry, posted by the worklet while metering. */
export interface CycleMeter {
  /** Peak amplitude per stored cycle, oldest → newest. */
  readonly peaks: Float32Array;
  /** Ring index of the newest cycle (the write head). */
  readonly head: number;
  /** Which cycle is being read right now; 1 = newest. */
  readonly lag: number;
  /** How many cycles the library currently holds. */
  readonly count: number;
  /** The period being played back, in Hz (0 while nothing is tracked). */
  readonly hz: number;
}

/**
 * Thin wrapper around the `zoetrope` AudioWorklet. `loadModule()` must be
 * awaited once per context before `create()` — which is synchronous, since
 * AudioWorkletNode construction is sync once the module is registered.
 *
 * The node has **two** inputs: 0 is the signal being processed, 1 the external
 * source (the drum bus) recorded with the same cycle boundaries. Telemetry for
 * the cycle-library display is **off** until `setMetering(true)`; subscribe via
 * `onCycles`.
 */
export class ZoetropeNode {
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** The raw node — the Effect needs it to connect the external input at index 1. */
  readonly node: AudioWorkletNode;

  readonly frequency: AudioParam;
  readonly scatter: AudioParam;
  readonly chaos: AudioParam;
  readonly smear: AudioParam;
  readonly sieve: AudioParam;
  readonly depth: AudioParam;
  readonly mix: AudioParam;
  readonly freeze: AudioParam;
  readonly source: AudioParam;
  readonly selectMode: AudioParam;
  readonly taps: AudioParam;
  readonly sub: AudioParam;
  readonly xfadeFloor: AudioParam;

  onCycles: ((m: CycleMeter) => void) | null = null;

  private constructor(node: AudioWorkletNode) {
    this.node = node;
    this.input = node;
    this.output = node;
    this.frequency = node.parameters.get('frequency')!;
    this.scatter = node.parameters.get('scatter')!;
    this.chaos = node.parameters.get('chaos')!;
    this.smear = node.parameters.get('smear')!;
    this.sieve = node.parameters.get('sieve')!;
    this.depth = node.parameters.get('depth')!;
    this.mix = node.parameters.get('mix')!;
    this.freeze = node.parameters.get('freeze')!;
    this.source = node.parameters.get('source')!;
    this.selectMode = node.parameters.get('selectMode')!;
    this.taps = node.parameters.get('taps')!;
    this.sub = node.parameters.get('sub')!;
    this.xfadeFloor = node.parameters.get('xfadeFloor')!;
    node.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string } | null;
      if (d && d.type === 'cycles') this.onCycles?.(d as unknown as CycleMeter);
    };
  }

  static create(ctx: AudioContext): ZoetropeNode {
    const node = new AudioWorkletNode(ctx, 'zoetrope', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    return new ZoetropeNode(node);
  }

  static async loadModule(ctx: AudioContext): Promise<void> {
    await ctx.audioWorklet.addModule('/worklets/zoetrope.js');
  }

  /** Telemetry costs a post per ~32 ms, so the UI only asks while it can be seen. */
  setMetering(on: boolean): void {
    this.node.port.postMessage({ type: 'meter', on });
  }

  /** Drop the stored library (clear-on-note-on). */
  clear(): void {
    this.node.port.postMessage('clear');
  }
}
