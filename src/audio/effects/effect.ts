import { clamp01 } from '../../utils/math';
import type { ParamBus } from '../../state/params';
import { rampTo, RAMP_BYPASS } from '../param-utils';

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
 * comfortably outlast the `RAMP_BYPASS` crossfade. Twelve of its 25 ms time
 * constants, so the wet gain is at -104 dB by the time the edge is cut. Moved
 * from 150 ms along with the crossfade's constant (effects.md REQ-12).
 * See ADR-012.
 */
export const DISCONNECT_DELAY_MS = 300;

/**
 * How long a stateless effect needs, fed silence, before what it holds *is*
 * silence — one `RAMP_MEDIUM`-ish settle for a biquad or a gain, no more. An
 * effect with real memory (a delay line, a convolver) overrides `drainSeconds`;
 * see effects.md REQ-2c for why the drain happens on the way out.
 */
export const DRAIN_DEFAULT_S = 0.02;

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
    this.wrap = new BypassWrapper(ctx, initialMix, {
      drainSeconds: () => this.drainSeconds(),
      quiesce: (on) => this.quiesce(on),
    });
    this.input = this.wrap.input;
    this.output = this.wrap.output;
  }

  setBypass(b: boolean): void {
    this.wrap.setBypass(b);
  }

  /**
   * How long this effect's DSP must be fed silence before it holds none of the
   * old audio (effects.md REQ-2c). The wrapper waits this long after cutting the
   * input before it detaches the output — so a later re-enable resumes a
   * subgraph full of silence rather than the last song's tail.
   *
   * Override only if the effect actually has memory: a delay line's buffer, a
   * convolver's IR length. Its presence is the declaration, the same way
   * `setMix`'s is (REQ-1).
   */
  protected drainSeconds(): number { return DRAIN_DEFAULT_S; }

  /**
   * Zero (`true`) or restore (`false`) an internal feedback path for the drain.
   * Without this a delay at 0.95 feedback recirculates rather than emptying, and
   * no finite drain would ever clear it. Written directly, not ramped: the wet
   * path is at zero by the time this runs, so there is nothing to hear a step in.
   */
  protected quiesce(_on: boolean): void { /* stateless by default */ }
}

/**
 * What the wrapper needs to know about its host's DSP to drain it safely
 * (effects.md REQ-2c). `WrappedEffect` supplies these from its two overridable
 * methods, so the wrapper stays ignorant of what is inside the processed path.
 */
export interface DrainHooks {
  drainSeconds(): number;
  quiesce(on: boolean): void;
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
 *
 * Those two edges come down in **two stages** (effects.md REQ-2c): dropping both
 * at once freezes the DSP instead of clearing it, and a delay line or convolver
 * then replays the audio it was holding the next time the effect is switched on.
 * So the input edge goes at `DISCONNECT_DELAY_MS`, the effect quiesces any
 * feedback loop, and the output edge follows only after `drainSeconds()` of
 * silence has washed through.
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
  /** The input edge is cut — no new signal is entering the processed path. */
  private inputCut = false;
  /** The output edge is cut too — the subgraph is detached and holds silence. */
  private disconnected = false;
  private disconnectTimer: number | null = null;
  private drainTimer: number | null = null;

  constructor(ctx: AudioContext, initialMix = 1, private readonly hooks?: DrainHooks) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.processedIn = ctx.createGain();
    this.processedOut = ctx.createGain();

    // A fresh GainNode defaults to 1, and the wrapper boots BYPASSED — so this
    // is the value `update()` immediately targets. Seeding it stops the first
    // ~30 ms of audio running dry+wet (~+6 dB hot) on an effect the boot patch
    // or the session restore turns on: `update()`'s `setTargetAtTime` only
    // *approaches* 0, and while the context is suspended it is scheduled at a
    // frozen `currentTime` so the approach does not begin until audio does.
    this.wet.gain.value = 0;

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
      this.scheduleDisconnect(); // … cut the input only after it has settled
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
    rampTo(this.dry.gain, dry, ctx, RAMP_BYPASS);
    rampTo(this.wet.gain, wet, ctx, RAMP_BYPASS);
  }

  /**
   * Bypass teardown, in two stages (effects.md REQ-2c). Cutting both edges at
   * once *freezes* the DSP rather than clearing it — the renderer stops pulling
   * an unreachable subgraph, so a delay line keeps its ring buffer and a
   * convolver its tail, indefinitely, and re-enabling replays them. So the input
   * goes first, the effect quiesces any feedback loop, and only once it has been
   * fed silence for its own `drainSeconds()` does the output edge go too — by
   * which point what it holds is silence and reconnecting is clean.
   */
  private scheduleDisconnect(): void {
    if (this.disconnected || this.disconnectTimer !== null) return;
    this.disconnectTimer = window.setTimeout(() => {
      this.disconnectTimer = null;
      if (!this.bypassed || this.inputCut) return;
      this.input.disconnect(this.processedIn);
      this.inputCut = true;
      // Zero the feedback *now*: a 0.95-feedback delay recirculates forever
      // otherwise and no finite drain would empty it.
      this.hooks?.quiesce(true);
      this.scheduleDrain();
    }, DISCONNECT_DELAY_MS);
  }

  private scheduleDrain(): void {
    const drainMs = Math.max(0, (this.hooks?.drainSeconds() ?? DRAIN_DEFAULT_S)) * 1000;
    this.drainTimer = window.setTimeout(() => {
      this.drainTimer = null;
      if (!this.bypassed || this.disconnected) return;
      this.processedOut.disconnect(this.wet);
      this.disconnected = true;
    }, drainMs);
  }

  private cancelDisconnect(): void {
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  /** Restore whichever edges the two stages had taken down, in wiring order. */
  private reconnect(): void {
    if (this.inputCut) {
      if (this.disconnected) {
        this.processedOut.connect(this.wet);
        this.disconnected = false;
      }
      this.input.connect(this.processedIn);
      this.inputCut = false;
      this.hooks?.quiesce(false);
    }
  }
}
