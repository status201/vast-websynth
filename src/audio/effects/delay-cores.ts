import { pinParam } from './effect';
import { BUTTERWORTH_Q_DB, DELAY_DAMP_HZ, clampDelayFeedback, clampDelayTime } from './delay';
import { RAMP_SMOOTH } from '../param-utils';
import { loadWorkletModule } from '../worklet-module';
import { clamp01 } from '../../utils/math';
import type { DelayType } from '../../state/delay';

/**
 * The delay's types as DSP spans (delay-types.md REQ-each-type-has-its-own-topology),
 * loaded with the switch that moves between them (delay-switch.ts). Each core
 * is only its own DSP: the switch owns the gates, the spill and the drain.
 *
 * Every number below is a starting point dialled by ear (ADR-010), named once.
 */

/** One delay type's DSP span. */
export interface DelayCore {
  readonly input: AudioNode;
  readonly output: AudioNode;
  setTime(s: number): void;
  setFeedback(f: number): void;
  setChar(c: number): void;
  /**
   * Zero (`true`) or restore the feedback loop, for a drain. A restore with
   * `glide` approaches the knob instead of stepping to it, for a loop that
   * still holds audio (REQ-a-type-switch-is-click-free-and-spills).
   */
  quiesce(on: boolean, glide?: boolean): void;
  /** Seconds of silence in that leave the core holding none of the old audio. */
  drainSeconds(): number;
  /**
   * The switch connected the core: from here its knobs glide, and anything it
   * runs on its own (an LFO) runs. Before the first wake every knob lands at
   * once, so a new core never glides in from its nodes' defaults.
   */
  wake(): void;
  /** The switch disconnected it: stop anything that would run unheard. */
  sleep(): void;
  /**
   * Pause (`true`) or resume what the core runs on its own while it stays
   * connected but unheard: a bypass. Unlike `sleep`, its knobs keep gliding, so
   * every core can rest, DIGITAL included (REQ-a-type-switch-is-click-free-and-spills).
   */
  rest(on: boolean): void;
}

/** A to B by `t`, linearly. */
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** What every core shares: the context, and knob writes that land at once until it is first heard. */
abstract class CoreBase {
  protected awake = false;
  protected resting = false;

  constructor(protected readonly ctx: BaseAudioContext, awake = false) {
    this.awake = awake;
  }

  /** Write a knob: at once before the first wake, with the effect controls' smoothing after (effects.md REQ-an-effects-own-controls-ramp). */
  write(p: AudioParam, v: number): void {
    if (this.awake) p.setTargetAtTime(v, this.ctx.currentTime, RAMP_SMOOTH);
    else p.value = v;
  }

  wake(): void { this.awake = true; }
  /** Disconnected and drained, so the next wake's knobs may land at once again. */
  sleep(): void { this.awake = false; }
  /** A core with nothing of its own to run only records it. */
  rest(on: boolean): void { this.resting = on; }
}

/**
 * A core's feedback knob, held across a drain (REQ-the-delay-drains-every-live-core):
 * a value written while quiesced is recorded, not applied, so the release lands
 * on what the knob says now — the rule `Delay` and `Flanger` keep for their own
 * loops. Drives every param of one loop (ping-pong has two).
 */
class HeldFeedback {
  /** `fb` and `quiesced` are the state the params already hold; nothing is written. */
  constructor(
    private readonly ctx: BaseAudioContext,
    /** The owning core's knob write, so the loop primes and glides as its other knobs do. */
    private readonly write: (p: AudioParam, v: number) => void,
    private readonly params: readonly AudioParam[],
    private fb = 0.4,
    private quiesced = false,
  ) {}

  set(f: number): void {
    this.fb = clampDelayFeedback(f);
    if (this.quiesced) return;
    for (const p of this.params) this.write(p, this.fb);
  }

  quiesce(on: boolean, glide = false): void {
    this.quiesced = on;
    // A glide needs no cancel: setTargetAtTime continues from wherever the
    // pinned value left the curve (architecture.md "Never cancel automation
    // without anchoring it").
    for (const p of this.params) {
      if (!on && glide) this.write(p, this.fb);
      else pinParam(this.ctx, p, on, this.fb);
    }
  }
}

/**
 * DIGITAL, once the switch owns it: the `Delay`'s own line, driven exactly as
 * `Delay` drives it before any type is chosen (REQ-digital-is-the-unchanged-delay).
 * It is already sounding, so it starts awake.
 */
export class DigitalCore extends CoreBase implements DelayCore {
  private readonly loop: HeldFeedback;

  constructor(
    ctx: BaseAudioContext,
    readonly input: DelayNode,
    feedback: GainNode,
    readonly output: BiquadFilterNode,
    heldFeedback: number,
    quiesced: boolean,
  ) {
    super(ctx, true);
    // Carries over what `Delay` held, without writing it: the line already has it.
    this.loop = new HeldFeedback(ctx, (p, v) => this.write(p, v), [feedback.gain], heldFeedback, quiesced);
  }

  setTime(s: number): void { this.write(this.input.delayTime, clampDelayTime(s)); }
  setFeedback(f: number): void { this.loop.set(f); }
  setChar(): void { /* DIGITAL has no character */ }
  quiesce(on: boolean, glide?: boolean): void { this.loop.quiesce(on, glide); }
  drainSeconds(): number { return 2; }
}

/** Ping-pong width from CHAR: never fully mono, hard L/R at 1. */
export function pingPongWidth(char: number): number {
  return 0.3 + 0.7 * clamp01(char);
}

/**
 * Ping-pong's per-repeat gains, own side and other side, by an equal-power pan
 * law (REQ-ping-pong-keeps-the-digital-level): `near² + far² = 2`, which is the
 * power of DIGITAL's mono echo up-mixed to both channels. At width 0 both are
 * 1 — DIGITAL's image exactly — and at width 1 the repeat is hard to one side.
 */
export function pingPongGains(char: number): [near: number, far: number] {
  const theta = (Math.PI / 4) * (1 - pingPongWidth(char));
  return [Math.SQRT2 * Math.cos(theta), Math.SQRT2 * Math.sin(theta)];
}

/** A Butterworth lowpass or highpass at `hz`: no bump, so never above unity in a loop (REQ-every-type-is-bounded). */
function butterworth(ctx: BaseAudioContext, type: 'lowpass' | 'highpass', hz: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = BUTTERWORTH_Q_DB;
  return f;
}

/**
 * PING PONG: the input folded to mono feeds the left line, whose output feeds
 * the right, whose output feeds back into the left — so the first repeat is left
 * and they alternate, each `fb` quieter than the last, as DIGITAL's are. A 2 × 2
 * matrix sets the width.
 */
class PingPongCore extends CoreBase implements DelayCore {
  readonly input: GainNode;
  readonly output: ChannelMergerNode;
  private readonly dL: DelayNode;
  private readonly dR: DelayNode;
  private readonly near: GainNode[];
  private readonly far: GainNode[];
  private readonly loop: HeldFeedback;

  constructor(ctx: BaseAudioContext) {
    super(ctx);
    this.input = ctx.createGain();
    this.input.channelCount = 1;
    this.input.channelCountMode = 'explicit';
    this.dL = ctx.createDelay(2);
    this.dR = ctx.createDelay(2);
    const dampL = butterworth(ctx, 'lowpass', DELAY_DAMP_HZ);
    const dampR = butterworth(ctx, 'lowpass', DELAY_DAMP_HZ);
    const lr = ctx.createGain();
    const rl = ctx.createGain();
    this.loop = new HeldFeedback(ctx, (p, v) => this.write(p, v), [lr.gain, rl.gain]);
    this.output = ctx.createChannelMerger(2);
    this.near = [ctx.createGain(), ctx.createGain()];
    this.far = [ctx.createGain(), ctx.createGain()];

    // in → L ─damp─┬──────────→ lr(fb) → R ─damp─┬─→ rl(fb) → L
    //              └ near₀ → out L, far₁ → out R  └ near₁ → out R, far₀ → out L
    this.input.connect(this.dL);
    this.dL.connect(dampL);
    dampL.connect(lr).connect(this.dR);
    this.dR.connect(dampR);
    dampR.connect(rl).connect(this.dL);
    dampL.connect(this.near[0]!).connect(this.output, 0, 0);
    dampL.connect(this.far[1]!).connect(this.output, 0, 1);
    dampR.connect(this.near[1]!).connect(this.output, 0, 1);
    dampR.connect(this.far[0]!).connect(this.output, 0, 0);
  }

  setTime(s: number): void {
    this.write(this.dL.delayTime, clampDelayTime(s));
    this.write(this.dR.delayTime, clampDelayTime(s));
  }

  setFeedback(f: number): void { this.loop.set(f); }

  setChar(c: number): void {
    const [near, far] = pingPongGains(c);
    for (const g of this.near) this.write(g.gain, near);
    for (const g of this.far) this.write(g.gain, far);
  }

  quiesce(on: boolean, glide?: boolean): void { this.loop.quiesce(on, glide); }
  drainSeconds(): number { return 2; }
}

/**
 * The analog loop's saturator, `tanh(k·x)/k`: slope 1 at the origin and never
 * above 1 in magnitude, so the loop gain is the FEEDBACK knob's at most
 * (REQ-every-type-is-bounded). Bucketed and memoized like the drive curves
 * (effects.md REQ-drive-curves-are-bucketed-and-memoized), since CHAR is continuous.
 */
const CURVE_SAMPLES = 1024;
const curves = new Map<number, Float32Array<ArrayBuffer>>();
export function saturationCurve(k: number): Float32Array<ArrayBuffer> {
  const key = Math.round(Math.max(1, k) * 20) / 20;
  let c = curves.get(key);
  if (!c) {
    c = new Float32Array(CURVE_SAMPLES);
    for (let i = 0; i < CURVE_SAMPLES; i++) {
      const x = (i / (CURVE_SAMPLES - 1)) * 2 - 1;
      c[i] = Math.tanh(key * x) / key;
    }
    curves.set(key, c);
  }
  return c;
}

/** What CHAR does to one analog voicing: each pair is its value at CHAR 0 and at 1. */
interface AnalogVoicing {
  /** Wow and flutter: rate (Hz) and swing (s). */
  wow: { hz: number; s0: number; s1: number };
  flutter: { hz: number; s0: number; s1: number };
  /** Saturator `k`. */
  drive: [number, number];
  /** Loop lowpass (Hz), and whether it is two poles deep. */
  lowpass: [number, number];
  twoPole: boolean;
  highpass: number;
  /** SPACE ECHO: CHAR is the spring's share instead, and the tape wear is fixed here. */
  spring: boolean;
}

/** The three analog types; SPACE ECHO's tape wear is TAPE's at about CHAR 0.5. */
export const ANALOG_VOICINGS: Record<'tape' | 'bbd' | 'spaceecho', AnalogVoicing> = {
  tape: {
    wow: { hz: 0.55, s0: 0.0002, s1: 0.0016 },
    flutter: { hz: 6.5, s0: 0.000006, s1: 0.00005 },
    drive: [1, 3],
    lowpass: [7000, 3000],
    twoPole: false,
    highpass: 110,
    spring: false,
  },
  bbd: {
    wow: { hz: 0.35, s0: 0.0001, s1: 0.0012 },
    flutter: { hz: 4, s0: 0, s1: 0.00002 },
    drive: [1, 1.8],
    lowpass: [3600, 1600],
    twoPole: true,
    highpass: 70,
    spring: false,
  },
  spaceecho: {
    wow: { hz: 0.55, s0: 0.0009, s1: 0.0009 },
    flutter: { hz: 6.5, s0: 0.000028, s1: 0.000028 },
    drive: [2, 2],
    lowpass: [4500, 4500],
    twoPole: false,
    highpass: 110,
    spring: true,
  },
};

/**
 * Headroom over the 2 s TIME ceiling for the wow and flutter swing, so the
 * read head is never pinned at the line's maximum for half a wow cycle.
 */
const ANALOG_SWING_HEADROOM_S = 0.01;

/** The spring colour's numbers: four dispersive allpasses into a short damped loop. */
const SPRING_ALLPASS_HZ = [380, 760, 1500, 2900];
const SPRING_DELAY_S = 0.033;
const SPRING_FEEDBACK = 0.55;
const SPRING_DAMP_HZ = 3000;

/**
 * TAPE, BBD and SPACE ECHO: one loop, three voicings.
 * `delay → shaper → highpass → lowpass(es) → feedback → delay`, the output
 * taken after the filters, `delayTime` swung by two sines. SPACE ECHO's
 * output also runs through the spring colour.
 */
class AnalogCore extends CoreBase implements DelayCore {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly line: DelayNode;
  private readonly shaper: WaveShaperNode;
  private readonly lps: BiquadFilterNode[];
  private readonly loop: HeldFeedback;
  /** The swing depths; the sines feeding them run only while the core is connected. */
  private readonly wowGain: GainNode;
  private readonly flutterGain: GainNode;
  private sines: OscillatorNode[] = [];
  private readonly echoLevel: GainNode;
  private readonly spring: { level: GainNode; loop: GainNode } | null = null;

  constructor(ctx: BaseAudioContext, private readonly v: AnalogVoicing) {
    super(ctx);
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.line = ctx.createDelay(2 + ANALOG_SWING_HEADROOM_S);
    this.shaper = ctx.createWaveShaper();
    const hp = butterworth(ctx, 'highpass', v.highpass);
    this.lps = (v.twoPole ? [0, 1] : [0]).map(() => butterworth(ctx, 'lowpass', v.lowpass[0]));
    const loop = ctx.createGain();
    this.loop = new HeldFeedback(ctx, (p, v) => this.write(p, v), [loop.gain]);

    this.input.connect(this.line);
    let tail: AudioNode = this.line.connect(this.shaper).connect(hp);
    for (const lp of this.lps) tail = tail.connect(lp);
    tail.connect(loop).connect(this.line);

    // Wow and flutter swing the read head in seconds, not as a share of TIME,
    // so the pitch wobble is the same at any delay time.
    this.wowGain = ctx.createGain();
    this.flutterGain = ctx.createGain();
    this.wowGain.connect(this.line.delayTime);
    this.flutterGain.connect(this.line.delayTime);

    this.echoLevel = ctx.createGain();
    tail.connect(this.echoLevel).connect(this.output);
    if (v.spring) this.spring = this.springTank(tail);
  }

  /** The spring colour, fed from the echo and summed into the output. */
  private springTank(from: AudioNode): { level: GainNode; loop: GainNode } {
    const ctx = this.ctx;
    let s = from;
    for (const hz of SPRING_ALLPASS_HZ) {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = hz;
      ap.Q.value = 0.7;
      s = s.connect(ap);
    }
    const sd = ctx.createDelay(0.1);
    sd.delayTime.value = SPRING_DELAY_S;
    const sdamp = butterworth(ctx, 'lowpass', SPRING_DAMP_HZ);
    const loop = ctx.createGain();
    loop.gain.value = SPRING_FEEDBACK;
    const level = ctx.createGain();
    s.connect(sd).connect(sdamp);
    sdamp.connect(loop).connect(sd);
    sdamp.connect(level).connect(this.output);
    return { level, loop };
  }

  /** Start the two sines, unless resting. A stopped oscillator cannot restart, so each start makes new ones. */
  override wake(): void {
    super.wake();
    if (!this.resting) this.startSines();
  }

  override rest(on: boolean): void {
    super.rest(on);
    if (on) this.stopSines();
    else if (this.awake) this.startSines();
  }

  private startSines(): void {
    if (this.sines.length) return;
    this.sines = [this.sine(this.v.wow.hz, this.wowGain), this.sine(this.v.flutter.hz, this.flutterGain)];
  }

  private stopSines(): void {
    for (const osc of this.sines) { osc.stop(); osc.disconnect(); }
    this.sines = [];
  }

  private sine(hz: number, depth: GainNode): OscillatorNode {
    const osc = this.ctx.createOscillator();
    osc.frequency.value = hz;
    osc.connect(depth);
    osc.start();
    return osc;
  }

  /** Stop the sines: a started source can keep costing CPU even unheard. */
  override sleep(): void {
    super.sleep();
    this.stopSines();
  }

  setTime(s: number): void {
    // Kept clear of the swing at the bottom, so the read head never reaches zero.
    this.write(this.line.delayTime, Math.max(0.005, clampDelayTime(s)));
  }

  setFeedback(f: number): void { this.loop.set(f); }

  setChar(c: number): void {
    const t = clamp01(c);
    const v = this.v;
    this.write(this.wowGain.gain, lerp(v.wow.s0, v.wow.s1, t));
    this.write(this.flutterGain.gain, lerp(v.flutter.s0, v.flutter.s1, t));
    this.shaper.curve = saturationCurve(lerp(v.drive[0], v.drive[1], t));
    const hz = v.lowpass[0] * Math.pow(v.lowpass[1] / v.lowpass[0], t);
    for (const lp of this.lps) this.write(lp.frequency, hz);
    if (this.spring) {
      // The spring's loop has a DC gain of 1 / (1 - SPRING_FEEDBACK); its level
      // undoes that, and the echo yields a little as the tank comes in.
      this.write(this.spring.level.gain, t * (1 - SPRING_FEEDBACK));
      this.write(this.echoLevel.gain, 1 - 0.4 * t);
    }
  }

  quiesce(on: boolean, glide?: boolean): void {
    this.loop.quiesce(on, glide);
    if (!this.spring) return;
    // The tank rings on too, so it is released the main loop's way: a glide, never a step back up.
    if (!on && glide) this.write(this.spring.loop.gain, SPRING_FEEDBACK);
    else pinParam(this.ctx, this.spring.loop.gain, on, SPRING_FEEDBACK);
  }

  drainSeconds(): number { return 2.1; }
}

/** The reverse worklet's window range, mirrored from public/worklets/reverse-delay.js. */
export const REVERSE_MAX_TIME_S = 2;
export const REVERSE_MIN_TIME_S = 0.02;

/**
 * REVERSE: windows of TIME played backwards, on alternating crossfaded heads,
 * in a worklet (a `DelayNode` cannot read backwards). The node's params are
 * k-rate and read at each window's start, so TIME applies at the next window.
 */
class ReverseCore extends CoreBase implements DelayCore {
  readonly input: AudioWorkletNode;
  readonly output: AudioWorkletNode;
  private readonly time: AudioParam;
  private readonly char: AudioParam;
  private readonly loop: HeldFeedback;

  constructor(ctx: BaseAudioContext) {
    super(ctx);
    // `outputChannelCount` is left unset, so the output follows the input.
    const node = new AudioWorkletNode(ctx, 'reverse-delay', { numberOfInputs: 1, numberOfOutputs: 1 });
    this.input = node;
    this.output = node;
    this.time = node.parameters.get('time')!;
    this.char = node.parameters.get('char')!;
    this.loop = new HeldFeedback(ctx, (p, v) => this.write(p, v), [node.parameters.get('feedback')!]);
  }

  setTime(s: number): void {
    // Read once per window, so it is set, not glided.
    const v = Math.max(REVERSE_MIN_TIME_S, Math.min(REVERSE_MAX_TIME_S, s));
    this.time.setValueAtTime(v, this.ctx.currentTime);
  }

  setFeedback(f: number): void { this.loop.set(f); }
  setChar(c: number): void { this.write(this.char, clamp01(c)); }
  quiesce(on: boolean, glide?: boolean): void { this.loop.quiesce(on, glide); }

  /** The heads read up to two windows back (REQ-the-delay-drains-every-live-core). */
  drainSeconds(): number { return 2 * REVERSE_MAX_TIME_S + 0.2; }
}

/**
 * How each non-digital type is built — one entry per type, so the compiler
 * rejects a new `DELAY_TYPES` row that has no core. REVERSE waits for its
 * worklet (REQ-the-other-types-load-on-first-use).
 */
const CORES: Record<Exclude<DelayType, 'digital'>, (ctx: BaseAudioContext) => Promise<DelayCore>> = {
  pingpong: async (ctx) => new PingPongCore(ctx),
  tape: async (ctx) => new AnalogCore(ctx, ANALOG_VOICINGS.tape),
  bbd: async (ctx) => new AnalogCore(ctx, ANALOG_VOICINGS.bbd),
  spaceecho: async (ctx) => new AnalogCore(ctx, ANALOG_VOICINGS.spaceecho),
  reverse: async (ctx) => {
    await loadWorkletModule(ctx, '/worklets/reverse-delay.js');
    return new ReverseCore(ctx);
  },
};

/** Build `type`'s core. DIGITAL is not built here: it is the `Delay`'s own line. */
export function createCore(ctx: BaseAudioContext, type: Exclude<DelayType, 'digital'>): Promise<DelayCore> {
  return CORES[type](ctx);
}
