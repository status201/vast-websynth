import { rampTo, RAMP_MEDIUM } from '../param-utils';

/**
 * Common interface for all effects. Each effect owns a fixed signal graph
 * with `input` and `output` AudioNodes — wire them into the chain once at
 * setup time. Bypass is realised as a dry/wet crossfade so it never clicks.
 *
 * Concrete effects additionally expose `bind(bus, prefix)` to self-wire their
 * own params (ADR-008); it is not on this interface because `Compressor.bind`
 * takes extra index-table args. See `add-an-effect.md`.
 */
export interface Effect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  setBypass(b: boolean): void;
}

/** Series-wire `input → fx[0] → fx[1] → … → output`. */
export function chain(input: AudioNode, fx: Effect[], output: AudioNode): void {
  let node: AudioNode = input;
  for (const e of fx) {
    node.connect(e.input);
    node = e.output;
  }
  node.connect(output);
}

/**
 * Helper for bypass-able effects with a dry/wet crossfade.
 * Connect inputs to `inputGate`. The host wires `processedOut` into the
 * effect-specific DSP chain, which writes back into `wet`. `dry` is summed
 * with `wet` at `output`.
 */
export class BypassWrapper {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly dry: GainNode;
  readonly wet: GainNode;
  readonly processedIn: GainNode;
  readonly processedOut: GainNode;

  private mix = 1;
  private bypassed = true;

  constructor(ctx: AudioContext, initialMix = 1) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.processedIn = ctx.createGain();
    this.processedOut = ctx.createGain();

    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.processedIn);
    this.processedOut.connect(this.wet).connect(this.output);

    this.mix = initialMix;
    this.update();
  }

  setBypass(b: boolean): void {
    this.bypassed = b;
    this.update();
  }

  setMix(m: number): void {
    this.mix = Math.max(0, Math.min(1, m));
    this.update();
  }

  private update(): void {
    const wet = this.bypassed ? 0 : this.mix;
    const dry = this.bypassed ? 1 : 1 - this.mix;
    const ctx = this.dry.context as AudioContext;
    rampTo(this.dry.gain, dry, ctx, RAMP_MEDIUM);
    rampTo(this.wet.gain, wet, ctx, RAMP_MEDIUM);
  }
}
