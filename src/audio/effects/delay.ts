import { WrappedEffect, bindBypassMix, BUTTERWORTH_Q_DB } from './effect';
import { RAMP_SMOOTH } from '../param-utils';
import { bindTempoLocked } from '../tempo-bind';
import { delayTypeOf } from '../../state/delay';
import type { ParamBus } from '../../state/params';
import type { DelaySwitch } from './delay-switch';

/** The digital line's damping, which PING PONG keeps so its repeats match DIGITAL's tone. */
export const DELAY_DAMP_HZ = 4500;
/** The delay line's own range, shared by every type (delay-types.md REQ-every-type-is-bounded). */
export const clampDelayTime = (s: number): number => Math.max(0.001, Math.min(2, s));
export const clampDelayFeedback = (f: number): number => Math.max(0, Math.min(0.95, f));

/** The switch's module, imported once for every delay; a failure is forgotten. */
let switchModule: Promise<typeof import('./delay-switch')> | null = null;

/**
 * The delay. Until a TYPE other than DIGITAL is chosen it is exactly the delay
 * it always was (delay-types.md REQ-digital-is-the-unchanged-delay); the first
 * other choice imports `delay-switch.ts`, whose `DelaySwitch` takes this line
 * over as its digital core and binds every knob itself from then on
 * (REQ-the-other-types-load-on-first-use).
 */
export class Delay extends WrappedEffect {
  private readonly delay: DelayNode;
  private readonly feedback: GainNode;
  private readonly damp: BiquadFilterNode;
  /** Last commanded feedback, held across a quiesce so it can be restored. */
  private fb = 0.4;
  private quiesced = false;
  private sw: DelaySwitch | null = null;
  private loading: Promise<void> | null = null;

  constructor(ctx: AudioContext) {
    super(ctx, 0.3);

    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = 0.35;

    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.4;

    this.damp = ctx.createBiquadFilter();
    this.damp.type = 'lowpass';
    this.damp.frequency.value = DELAY_DAMP_HZ;
    this.damp.Q.value = BUTTERWORTH_Q_DB;

    // input → delay → damp → feedback → delay (loop)
    //                 ↘ processedOut
    this.wrap.processedIn.connect(this.delay);
    this.delay.connect(this.damp);
    this.damp.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.damp.connect(this.wrap.processedOut);
  }

  // Once the switch owns the line, these stand down: it drives it, and may be
  // holding its loop at zero for a drain.
  setMix(m: number): void { this.wrap.setMix(m); }
  setTime(s: number): void {
    if (this.sw) return;
    this.delay.delayTime.setTargetAtTime(clampDelayTime(s), this.ctx.currentTime, RAMP_SMOOTH);
  }
  setFeedback(f: number): void {
    if (this.sw) return;
    // Recorded even while quiesced, so `quiesce(false)` restores what the knob
    // says now rather than what it said when the effect was bypassed.
    this.fb = clampDelayFeedback(f);
    if (this.quiesced) return;
    this.feedback.gain.setTargetAtTime(this.fb, this.ctx.currentTime, RAMP_SMOOTH);
  }

  /**
   * The whole 2 s of `createDelay(2)`: fed silence for that long, every sample
   * in the ring buffer has been overwritten, whatever the read pointer is doing
   * (effects.md REQ-a-bypassed-effect-drains-before-disconnect). Once the switch
   * is in, the longest of its connected cores' (REQ-the-delay-drains-every-live-core).
   */
  protected override drainSeconds(): number { return this.sw?.drainSeconds() ?? 2; }

  /**
   * Feedback is what stops a delay line ever emptying — at 0.95 the content
   * recirculates indefinitely and no finite drain would clear it. Set directly,
   * not ramped: the wet path is already at zero, so there is nothing to hear.
   */
  protected override quiesce(on: boolean): void {
    this.quiesced = on;
    if (this.sw) return this.sw.quiesce(on);
    this.quiesceParam(this.feedback.gain, on, this.fb);
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    bindTempoLocked(bus, `${prefix}.time`, `${prefix}.sync`, 'time', (x) => this.setTime(x));
    bus.subscribe(`${prefix}.feedback`, (x) => this.setFeedback(x));
    // A failed load is logged and leaves the delay DIGITAL. Choosing a type again
    // retries, and so does switching the delay back on: the bus ignores a write
    // of the value it holds, so re-picking the same type alone could not
    // (REQ-the-other-types-load-on-first-use).
    const engage = (): void => {
      const type = delayTypeOf(bus.get(`${prefix}.type`));
      if (this.sw) return this.sw.select(type);
      if (this.loading || type === 'digital') return;
      this.loading = (switchModule ??= import('./delay-switch'))
        .then((m) => {
          this.sw = new m.DelaySwitch(this.ctx, this.wrap, this.delay, this.feedback, this.damp, this.fb, this.quiesced);
          this.sw.bind(bus, prefix);
        })
        .catch((err: unknown) => {
          switchModule = null;
          console.warn('[delay] types failed to load', err);
        })
        .finally(() => { this.loading = null; });
    };
    bus.subscribe(`${prefix}.type`, engage);
    bus.subscribe(`${prefix}.on`, (x) => { if (x >= 0.5) engage(); });
  }
}
