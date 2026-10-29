import { WrappedEffect, bindBypassMix } from './effect';
import type { ParamBus } from '../../state/params';
import type { FlangerLive } from './flanger-live';

/**
 * The flanger as the chain holds it from boot (flanger.md): a shell that owns
 * only the bypass, the mix, the drain and a trigger. The first switch-on
 * imports `flanger-live`, which loads the worklet, splices it in and binds
 * rate, depth and feedback (REQ-the-flanger-loads-on-first-use). Until then it
 * stays bypassed whatever its switch says (REQ-an-unloaded-flanger-stays-bypassed).
 */
export class Flanger extends WrappedEffect {
  private live: FlangerLive | null = null;
  private loading: Promise<void> | null = null;
  private quiesced = false;
  /** What the switch last asked for; applied once the DSP is in. */
  private wantOn = false;

  constructor(ctx: AudioContext) {
    super(ctx, 0.5);
  }

  /**
   * An un-bypass waits for the splice, so the crossfade only ever fades in the
   * real wet. Swapping a stand-in for the node mid-fade stepped the waveform
   * (REQ-an-unloaded-flanger-stays-bypassed).
   */
  override setBypass(b: boolean): void {
    this.wantOn = !b;
    if (b || this.live) super.setBypass(b);
  }

  setMix(m: number): void { this.wrap.setMix(m); }

  /**
   * Import, load and splice, once. A failure is logged and leaves the flanger
   * bypassed, and nothing throws into the subscriber that asked (ADR-015). The
   * memo is cleared, so the next switch-on tries again
   * (lazy-load-failure.md REQ-retry-reruns-the-whole-gesture's rule).
   */
  ensureLive(bus: ParamBus, prefix: string): Promise<void> {
    this.loading ??= import('./flanger-live')
      .then((m) => m.spliceFlanger(this.ctx, this.wrap, bus, prefix))
      .then((live) => {
        this.live = live;
        if (this.quiesced) this.quiesce(true);
        if (this.wantOn) super.setBypass(false);
      })
      .catch((err: unknown) => {
        this.loading = null;
        console.warn('[flanger] the flanger failed to load; it stays bypassed', err);
      });
    return this.loading;
  }

  /**
   * At most ~5.7 ms of buffer, emptied in one pass once the feedback is at 0
   * (REQ-the-flanger-drains-before-disconnect).
   */
  protected override drainSeconds(): number { return 0.05; }

  protected override quiesce(on: boolean): void {
    this.quiesced = on;
    if (this.live) this.quiesceParam(this.live.feedback, on, this.live.hold(on));
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    bus.subscribe(`${prefix}.on`, (x) => { if (x >= 0.5) void this.ensureLive(bus, prefix); });
  }
}
