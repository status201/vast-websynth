import { WrappedEffect, bindBypassMix } from './effect';
import { LimiterNode } from '../limiter/node';
import { RAMP_SMOOTH } from '../param-utils';
import type { ParamBus } from '../../state/params';

/**
 * The master limiter (master-limiter.md): the last stage before the
 * destination and the recorder, on by default (ADR-029).
 *
 * Unlike `Compressor`, the processed path starts as a **direct passthrough**
 * (`processedIn → processedOut`) rather than empty. This effect boots enabled,
 * so an empty wet path would mute the whole master until the worklet attached,
 * and for good if its module never loaded
 * (REQ-a-failed-load-never-mutes-the-master). `attachWorklet()` swaps the
 * passthrough for the node and replays the cached setters.
 */
export class Limiter extends WrappedEffect {
  private node: LimiterNode | null = null;
  private grCb: ((db: number) => void) | null = null;
  private drive = 0;
  private ceiling = 0;
  /** Mirrors the wrapper's state: posts from a draining worklet are dropped while true. */
  private bypassed = true;

  constructor(ctx: AudioContext) {
    super(ctx, 1);
    this.wrap.processedIn.connect(this.wrap.processedOut);
  }

  /** Whether the worklet node is in the path (false = still the passthrough). */
  get attached(): boolean {
    return this.node !== null;
  }

  /**
   * Splice the worklet in where the passthrough was. Call once `LimiterNode.loadModule`
   * has resolved; at boot that is before the master fades in, so the swap is silent.
   */
  attachWorklet(): void {
    if (this.node) return;
    const node = LimiterNode.create(this.ctx);
    const t = this.ctx.currentTime;
    node.drive.setValueAtTime(this.drive, t);
    node.ceiling.setValueAtTime(this.ceiling, t);
    // A bypassed limiter still runs through its drain, and its last post must
    // not leave the meter stale (REQ-the-limiter-posts-gain-reduction).
    node.onGr = (db) => { if (!this.bypassed) this.grCb?.(db); };
    this.wrap.processedIn.disconnect(this.wrap.processedOut);
    this.wrap.processedIn.connect(node.input);
    node.output.connect(this.wrap.processedOut);
    this.node = node;
  }

  onGr(cb: (db: number) => void): void {
    this.grCb = cb;
  }

  /** Also clears the meter, so bypassing never leaves it frozen on a stale value. */
  override setBypass(b: boolean): void {
    this.bypassed = b;
    super.setBypass(b);
    if (b) this.grCb?.(0);
  }

  /**
   * The wet path is silent by now, so reset the worklet to rest: the disconnect
   * that follows would otherwise freeze it mid-release, and the next switch-on
   * would start ducked (master-limiter.md REQ-re-engaging-starts-at-rest). Nothing
   * to undo on the way back in, as rest is where it should resume.
   */
  protected override quiesce(on: boolean): void {
    if (on) this.node?.reset();
  }

  setDrive(db: number): void {
    this.drive = db;
    this.apply(this.node?.drive, db);
  }

  setCeiling(db: number): void {
    this.ceiling = db;
    this.apply(this.node?.ceiling, db);
  }

  /** `.on` drives bypass; there is no `.mix` (effects.md REQ-every-effect-implements-the-interface). */
  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    bus.subscribe(`${prefix}.drive`, (x) => this.setDrive(x));
    bus.subscribe(`${prefix}.ceiling`, (x) => this.setCeiling(x));
  }

  /** Both are continuous, so smoothed (REQ-drive-and-ceiling-are-continuous). */
  private apply(param: AudioParam | undefined, v: number): void {
    param?.setTargetAtTime(v, this.ctx.currentTime, RAMP_SMOOTH);
  }
}
