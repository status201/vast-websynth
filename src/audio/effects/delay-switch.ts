import { RAMP_BYPASS, rampTo } from '../param-utils';
import { bindTempoLocked } from '../tempo-bind';
import { delayTypeOf, type DelayType } from '../../state/delay';
import type { ParamBus } from '../../state/params';
import { createCore, DigitalCore, type DelayCore } from './delay-cores';
import { DISCONNECT_DELAY_MS } from './effect';

/**
 * The switch between the delay's types (delay-types.md
 * REQ-a-type-switch-is-click-free-and-spills), imported the first time any
 * delay leaves DIGITAL, so none of it is in the entry chunk
 * (REQ-the-other-types-load-on-first-use). `Delay` (delay.ts) is the effect and
 * the digital line; once a type is chosen it hands its wet path to a
 * {@link DelaySwitch}. Each type's DSP is a `DelayCore` (delay-cores.ts).
 */

/**
 * How long a core that was switched away from keeps sounding its echoes before
 * it is faded and drained.
 */
export const DELAY_SPILL_S = 2;

/** A core between its two gates, and where it is in its life. */
interface CoreSlot {
  readonly core: DelayCore;
  readonly inGate: GainNode;
  readonly outGate: GainNode;
  state: 'live' | 'spill' | 'idle';
  connected: boolean;
  /** Whether the core's loop is pinned at zero, so a release is only ever written when it is. */
  quiesced: boolean;
  timer: number | null;
}

/**
 * The delay's types, each its own core between two gates, one live at a time.
 * Built around the digital line, which it re-routes through unity gates in one
 * task — the same samples, so the splice is inaudible.
 */
export class DelaySwitch {
  private active: DelayType = 'digital';
  private readonly slots = new Map<DelayType, CoreSlot>();
  /** Core loads in flight, by type. */
  private readonly loading = new Map<DelayType, Promise<void>>();
  /** The knobs every type reads, as they stand — a core coming in starts on them. */
  private readonly knobs = { time: 0.35, fb: 0.4, char: 0.5 };

  constructor(
    private readonly ctx: AudioContext,
    private readonly span: { readonly processedIn: AudioNode; readonly processedOut: AudioNode },
    line: DelayNode,
    feedback: GainNode,
    damp: BiquadFilterNode,
    heldFeedback: number,
    private quiesced: boolean,
  ) {
    const digital = new DigitalCore(ctx, line, feedback, damp, heldFeedback, quiesced);
    const slot = this.makeSlot('digital', digital);
    slot.quiesced = quiesced;
    this.connectSlot(slot);
    span.processedIn.disconnect(line);
    damp.disconnect(span.processedOut);
    slot.state = 'live';
  }

  /**
   * Take the delay's knobs over from `Delay`, which stands down once the switch
   * exists. Every subscription fires at once with the current value, so the
   * cores start on the knobs as they stand and the type now chosen is selected.
   */
  bind(bus: ParamBus, prefix: string): void {
    /** Remember a knob for cores yet to come, and hand it to every core there is. */
    const fanOut = (knob: keyof DelaySwitch['knobs'], apply: (core: DelayCore, v: number) => void) =>
      (v: number): void => {
        this.knobs[knob] = v;
        for (const slot of this.slots.values()) apply(slot.core, v);
      };
    bindTempoLocked(bus, `${prefix}.time`, `${prefix}.sync`, 'time', fanOut('time', (c, v) => c.setTime(v)));
    bus.subscribe(`${prefix}.feedback`, fanOut('fb', (c, v) => c.setFeedback(v)));
    bus.subscribe(`${prefix}.char`, fanOut('char', (c, v) => c.setChar(v)));
    bus.subscribe(`${prefix}.type`, (t) => this.select(delayTypeOf(t)));
  }

  /**
   * Hand the wet path to `type`'s core. The core going out stops taking input
   * but keeps sounding; the one coming in starts on new audio. A type not yet
   * built is made first, and until it is in, the wet path carries only the
   * spill. A failed build is logged and the next choice of it retries.
   */
  select(type: DelayType): void {
    const had = this.slots.get(type);
    if (type === this.active && (had || this.loading.has(type))) return;
    this.active = type;
    for (const [t, slot] of this.slots) if (t !== type && slot.state === 'live') this.spill(slot);
    if (had) return this.take(had);
    if (type === 'digital' || this.loading.has(type)) return;

    const load = createCore(this.ctx, type)
      .then((core) => {
        const slot = this.makeSlot(type, core);
        if (this.active === type) this.take(slot);
      })
      .catch((err: unknown) => {
        console.warn(`[delay] the ${type} delay failed to load; its wet stays silent`, err);
      })
      .finally(() => this.loading.delete(type));
    this.loading.set(type, load);
  }

  /** Every connected core's longest drain (REQ-the-delay-drains-every-live-core). */
  drainSeconds(): number {
    let s = 0;
    for (const slot of this.slots.values()) if (slot.connected) s = Math.max(s, slot.core.drainSeconds());
    return s;
  }

  /**
   * A bypass also retires any core still spilling: there is nothing left to hear
   * it through. The wrapper has already faded, so every loop still holding audio
   * is zeroed now, a retiring one's pending zero included, or the wrapper's
   * drain could end before the core's.
   *
   * The live core rests through the bypass too, so its own sources (the analog
   * wow and flutter sines) stop costing CPU; the wet is already 0 when this runs,
   * and the release resumes them before the wet ramps back.
   */
  quiesce(on: boolean): void {
    this.quiesced = on;
    for (const slot of this.slots.values()) {
      if (slot.state === 'live') {
        this.pin(slot, on);
        slot.core.rest(on);
      } else if (on && slot.state === 'spill') this.retire(slot, true);
      else if (on && slot.connected) this.pin(slot, true);
    }
  }

  /**
   * Zero or restore `slot`'s loop, only if it is not already there. A restore
   * glides (REQ-a-type-switch-is-click-free-and-spills): a core taken back
   * mid-drain still holds echoes, and stepping its loop gain from 0 would click.
   */
  private pin(slot: CoreSlot, on: boolean): void {
    if (slot.quiesced === on) return;
    slot.core.quiesce(on, true);
    slot.quiesced = on;
  }

  private makeSlot(type: DelayType, core: DelayCore): CoreSlot {
    const inGate = this.ctx.createGain();
    const outGate = this.ctx.createGain();
    inGate.connect(core.input);
    core.output.connect(outGate);
    const slot: CoreSlot = { core, inGate, outGate, state: 'idle', connected: false, quiesced: false, timer: null };
    this.slots.set(type, slot);
    return slot;
  }

  private connectSlot(slot: CoreSlot): void {
    if (slot.connected) return;
    this.span.processedIn.connect(slot.inGate);
    slot.outGate.connect(this.span.processedOut);
    slot.connected = true;
  }

  private clearTimer(slot: CoreSlot): void {
    if (slot.timer !== null) { clearTimeout(slot.timer); slot.timer = null; }
  }

  /** Ramp both of `slot`'s gates, through the bypass's own crossfade constant. */
  private gate(slot: CoreSlot, input: number, output: number): void {
    rampTo(slot.inGate.gain, input, this.ctx, RAMP_BYPASS);
    rampTo(slot.outGate.gain, output, this.ctx, RAMP_BYPASS);
  }

  /**
   * Make `slot` the live core: connected, seeded with the knobs, awake, both
   * gates open. A core that is not yet awake takes the knobs at once, so it
   * never glides in from its nodes' defaults; one taken back mid-spill or
   * mid-drain is awake, so they glide. While the delay is bypassed it is taken
   * resting, so nothing of its own runs until the release (see `quiesce`).
   */
  private take(slot: CoreSlot): void {
    this.clearTimer(slot);
    if (!slot.connected) {
      // A newly connected core opens from silence, so nothing steps.
      slot.inGate.gain.value = 0;
      slot.outGate.gain.value = 0;
      this.connectSlot(slot);
    }
    slot.core.setTime(this.knobs.time);
    slot.core.setFeedback(this.knobs.fb);
    slot.core.setChar(this.knobs.char);
    this.pin(slot, this.quiesced);
    slot.core.rest(this.quiesced);
    slot.core.wake();
    this.gate(slot, 1, 1);
    slot.state = 'live';
  }

  /** Stop feeding `slot`, let its echoes ring for `DELAY_SPILL_S`, then retire it. */
  private spill(slot: CoreSlot): void {
    rampTo(slot.inGate.gain, 0, this.ctx, RAMP_BYPASS);
    slot.state = 'spill';
    this.clearTimer(slot);
    slot.timer = window.setTimeout(() => this.retire(slot), DELAY_SPILL_S * 1000);
  }

  /**
   * Fade `slot` out, zero its loop once the fade has closed the output gate, and
   * disconnect it once it holds only silence. The bypass wrapper's own order
   * (effects.md REQ-a-bypassed-effect-drains-before-disconnect): a loop stepped
   * to 0 while still heard reaches the output one TIME later, a click at a short
   * TIME. `now` is for a bypass, which has already faded.
   */
  private retire(slot: CoreSlot, now = false): void {
    this.clearTimer(slot);
    this.gate(slot, 0, 0);
    slot.state = 'idle';
    const drain = (): void => {
      this.pin(slot, true);
      slot.timer = window.setTimeout(() => {
        slot.timer = null;
        if (slot.state !== 'idle' || !slot.connected) return;
        this.span.processedIn.disconnect(slot.inGate);
        slot.outGate.disconnect(this.span.processedOut);
        slot.connected = false;
        slot.core.sleep();
      }, slot.core.drainSeconds() * 1000);
    };
    if (now) drain();
    else slot.timer = window.setTimeout(drain, DISCONNECT_DELAY_MS);
  }
}
