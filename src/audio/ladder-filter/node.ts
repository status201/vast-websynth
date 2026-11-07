/**
 * The voice filter. Hosts BOTH models — LADDER (`ladder-filter.md`) and POLY
 * (`filter-models.md`) — in one worklet, selected by the `model` AudioParam
 * rather than by swapping nodes (ADR-016). The name is historical: renaming it
 * would churn every import for no behavioural gain.
 */
export class LadderFilterNode {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly cutoffNote: AudioParam;
  readonly resonance: AudioParam;
  readonly drive: AudioParam;
  /** Which model runs: 0 = LADDER, 1 = POLY (filter-models.md REQ-filter-model-is-a-discrete-param). */
  readonly model: AudioParam;
  /** POLY pole-mix morph, 0 = LP24 … 1 = HP24. The LFO sums in here (filter-models.md REQ-shape-is-an-lfo-destination). */
  readonly shape: AudioParam;
  /** The idle gate (ladder-filter.md REQ-the-filter-idles-when-gated); written only by `setActive`. */
  private readonly active: AudioParam;

  private constructor(private readonly node: AudioWorkletNode) {
    this.input = node;
    this.output = node;
    this.cutoffNote = node.parameters.get('cutoffNote')!;
    this.resonance = node.parameters.get('resonance')!;
    this.drive = node.parameters.get('drive')!;
    this.model = node.parameters.get('model')!;
    this.shape = node.parameters.get('shape')!;
    this.active = node.parameters.get('active')!;
  }

  /**
   * Idle gating (ladder-filter.md REQ-the-filter-idles-when-gated): while inactive the processor skips
   * its per-sample DSP and outputs silence.
   *
   * Scheduled at `currentTime`, never messaged (REQ-the-gate-is-scheduled-not-messaged):
   * a voice's envelope anchors its attack at `when >= currentTime` on this same
   * clock, so the filter is awake by the block the VCA opens in. A port message
   * lands whenever the audio thread gets to it, and a late one let the note
   * start on silence and jump to full level a block or two in.
   */
  setActive(on: boolean): void {
    this.active.setValueAtTime(on ? 1 : 0, this.node.context.currentTime);
  }

  static async create(ctx: AudioContext): Promise<LadderFilterNode> {
    // Mono: the voice path is mono end-to-end; stereo starts downstream by
    // up-mix. A stereo node here would compute identical samples twice
    // (ladder-filter.md REQ-the-filter-worklet-is-mono).
    const node = new AudioWorkletNode(ctx, 'ladder-filter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    return new LadderFilterNode(node);
  }

  static async loadModule(ctx: AudioContext): Promise<void> {
    await ctx.audioWorklet.addModule('/worklets/ladder-filter.js');
  }
}
