export class LadderFilterNode {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly cutoffNote: AudioParam;
  readonly resonance: AudioParam;
  readonly drive: AudioParam;

  private constructor(private readonly node: AudioWorkletNode) {
    this.input = node;
    this.output = node;
    this.cutoffNote = node.parameters.get('cutoffNote')!;
    this.resonance = node.parameters.get('resonance')!;
    this.drive = node.parameters.get('drive')!;
  }

  static async create(ctx: AudioContext): Promise<LadderFilterNode> {
    const node = new AudioWorkletNode(ctx, 'ladder-filter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    return new LadderFilterNode(node);
  }

  static async loadModule(ctx: AudioContext): Promise<void> {
    await ctx.audioWorklet.addModule('/worklets/ladder-filter.js');
  }
}
