import { clamp01 } from '../../utils/math';
import type { ParamBus } from '../../state/params';
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

/**
 * The two subscriptions every insert effect's `bind` opens: `${prefix}.on`
 * drives bypass (a switch param, so < 0.5 is off) and `${prefix}.mix` the
 * dry/wet. Effects without a mix (Wah) simply omit `setMix`. `Compressor.bind`
 * does not use this — it has no mix and takes index tables (ADR-008).
 */
export function bindBypassMix(
  bus: ParamBus,
  prefix: string,
  fx: { setBypass(b: boolean): void; setMix?(m: number): void },
): void {
  bus.subscribe(`${prefix}.on`, (x) => fx.setBypass(x < 0.5));
  if (fx.setMix) bus.subscribe(`${prefix}.mix`, (x) => fx.setMix!(x));
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
 * How long after bypassing before the processed path is disconnected — must
 * comfortably outlast the RAMP_MEDIUM crossfade (~10 ms time constant, so the
 * wet gain is far below audibility by 150 ms). See ADR-012.
 */
export const DISCONNECT_DELAY_MS = 150;

/**
 * The shared body of an insert effect: it owns a `BypassWrapper`, publishes the
 * wrapper's `input`/`output` as the `Effect` surface, and delegates `setBypass`.
 * A subclass is then nothing but its own DSP — build the span from
 * `wrap.processedIn` to `wrap.processedOut`, and `bind` the params.
 *
 * `setMix` is intentionally absent. `bindBypassMix` keys off whether an effect
 * defines it, which is how Wah and the compressors — which have no `.mix` param
 * registered — opt out of a dry/wet. Declaring it here would make all six claim a
 * mix and subscribe a param that does not exist. Effects with a crossfade declare
 * the one-liner themselves; its presence is the declaration (effects.md REQ-1).
 */
export abstract class WrappedEffect implements Effect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  protected readonly wrap: BypassWrapper;

  protected constructor(protected readonly ctx: AudioContext, initialMix = 1) {
    this.wrap = new BypassWrapper(ctx, initialMix);
    this.input = this.wrap.input;
    this.output = this.wrap.output;
  }

  setBypass(b: boolean): void {
    this.wrap.setBypass(b);
  }
}

/**
 * Helper for bypass-able effects with a dry/wet crossfade.
 * Connect inputs to `inputGate`. The host wires `processedOut` into the
 * effect-specific DSP chain, which writes back into `wet`. `dry` is summed
 * with `wet` at `output`.
 *
 * True bypass (ADR-012): the renderer keeps computing any subgraph reachable
 * from the destination, so after the bypass crossfade settles the wrapper
 * disconnects its own two edges (`input → processedIn`, `processedOut → wet`)
 * — the effect's DSP (convolver, shaper, worklet, …) then costs nothing.
 * Un-bypassing reconnects *before* ramping, so it stays click-free. Only the
 * wrapper's own edges are ever touched; splices inside the processed path
 * (e.g. `Compressor.attachWorklet`) are unaffected.
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
  private disconnected = false;
  private disconnectTimer: number | null = null;

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
    this.scheduleDisconnect(); // effects boot bypassed — sleep the DSP path
  }

  setBypass(b: boolean): void {
    this.bypassed = b;
    if (b) {
      this.update(); // ramp wet → 0 first …
      this.scheduleDisconnect(); // … disconnect only after it has settled
    } else {
      this.cancelDisconnect();
      this.reconnect(); // reconnect before any signal is expected
      this.update();
    }
  }

  setMix(m: number): void {
    this.mix = clamp01(m);
    this.update(); // a bypassed (disconnected) wrapper stays disconnected
  }

  private update(): void {
    const wet = this.bypassed ? 0 : this.mix;
    const dry = this.bypassed ? 1 : 1 - this.mix;
    const ctx = this.dry.context as AudioContext;
    rampTo(this.dry.gain, dry, ctx, RAMP_MEDIUM);
    rampTo(this.wet.gain, wet, ctx, RAMP_MEDIUM);
  }

  private scheduleDisconnect(): void {
    if (this.disconnected || this.disconnectTimer !== null) return;
    this.disconnectTimer = window.setTimeout(() => {
      this.disconnectTimer = null;
      if (!this.bypassed || this.disconnected) return;
      this.input.disconnect(this.processedIn);
      this.processedOut.disconnect(this.wet);
      this.disconnected = true;
    }, DISCONNECT_DELAY_MS);
  }

  private cancelDisconnect(): void {
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private reconnect(): void {
    if (!this.disconnected) return;
    this.input.connect(this.processedIn);
    this.processedOut.connect(this.wet);
    this.disconnected = false;
  }
}
