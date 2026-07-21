import type { Arrangement } from './arrangement';
import type { MotionStep, PatternStore } from '../../state/patterns';
import { SEQ_LENGTH } from '../../state/patterns';
import type { ParamBus } from '../../state/params';
import type { XyAssign, XyPadStore } from '../../state/xy-pad';
import { motionAxesFor } from '../../state/xy-effective';
import { fromNorm } from '../../utils/taper';
import { valueAt, type MotionMode, type MotionNeighbours } from './motion-curve';
import type { TickSubscriber } from './tick-source';
import { ListenerSet } from '../../utils/listeners';

export type MotionStepListener = (step: number) => void;

/** One scheduled tick plus the arrangement state captured with it — that state
 *  flips ahead of audible time, so frame() applies it only once `now` crosses
 *  the tick's `when`. */
interface LatchedTick {
  idx: number;
  when: number;
  dur: number;
  resting: boolean;
  playBank: number;
  /** Neighbouring bars, for the bar-line carry (REQ-2b) — latched with the rest. */
  prevBank: number;
  prevResting: boolean;
  nextBank: number;
  nextResting: boolean;
}

interface MotionMachineOpts {
  /** Frame-loop throttle (perf-tier fps). Default 60. */
  fps?: number;
  /** Audio-clock now, seconds (ctx.currentTime). Injectable for tests. */
  now?: () => number;
  /** rAF/cAF injection for tests (jsdom has no real frame loop). */
  raf?: (cb: () => void) => number;
  caf?: (id: number) => void;
}

/**
 * Motion sequencer — drives the XY Pad's two assigned params from a 16-step
 * bank of XY anchors (specs/features/motion-sequencer.md). Structurally a
 * sibling of the other machines (clock + patterns + arrangement) but it emits
 * **param writes**, not audio.
 *
 * Timing: clock ticks arrive with `when` scheduled ahead of real time, so
 * writing on the tick would run early relative to the heard step. Instead one
 * frame loop (throttled to the perf-tier fps) evaluates the pure motion curve
 * at the audio clock's *now* each frame — slide mode moves every frame, step
 * mode only produces a new value at anchor boundaries (`bus.set` no-ops on
 * unchanged values, so idle frames cost nothing). Arrangement state (rest
 * gate, play bank) advances with the scheduled tick too, so it is latched per
 * tick and applied at the tick's audible time (REQ-7) — reading it live would
 * truncate the final scheduleAheadS of every bar before a rest. The neighbouring
 * bars' banks are latched the same way and handed to the curve, so the segment
 * crossing the bar line ramps into the bank that actually plays next (REQ-2b).
 *
 * Baseline discipline (REQ-5): the first write to a param in a play session
 * records its prior value; stop / disable restores every recorded baseline.
 * The machine never subscribes to the params it writes.
 */
export class MotionMachine {
  private enabled = false;
  private muted = false;
  private mode: MotionMode = 'slide';
  private curr: LatchedTick | null = null;
  private prev: LatchedTick | null = null;
  private readonly baselines = new Map<string, number>();
  private readonly stepListeners = new ListenerSet<[number]>();

  private rafId: number | null = null;
  private lastFrameMs = 0;
  private readonly minFrameMs: number;
  private readonly now: () => number;
  private readonly raf: (cb: () => void) => number;
  private readonly caf: (id: number) => void;

  constructor(
    private readonly clock: TickSubscriber,
    private readonly patterns: PatternStore,
    private readonly arrangement: Arrangement,
    private readonly xy: XyPadStore,
    private readonly bus: ParamBus,
    opts: MotionMachineOpts = {},
  ) {
    this.minFrameMs = 1000 / (opts.fps ?? 60);
    this.now = opts.now ?? (() => 0);
    this.raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
    this.caf = opts.caf ?? ((id) => cancelAnimationFrame(id));

    clock.onTick((step, when) => {
      // Raw step, not perf.mapStep: automation must not follow stutter remaps.
      const idx = step % SEQ_LENGTH;
      this.prev = this.curr;
      this.curr = {
        idx,
        when,
        dur: clock.sixteenthDuration(),
        resting: this.arrangement.motionResting,
        playBank: this.arrangement.motionPlayBank,
        prevBank: this.arrangement.motionPrevPlayBank,
        prevResting: this.arrangement.motionPrevResting,
        nextBank: this.arrangement.motionNextPlayBank,
        nextResting: this.arrangement.motionNextResting,
      };
      if (!this.enabled) return;
      this.stepListeners.emit(idx);
    });
    clock.onStart(() => {
      this.curr = this.prev = null;
      if (this.active) this.startLoop();
    });
    clock.onStop(() => {
      this.stopLoop();
      this.restoreBaselines();
    });
  }

  /** Effective-active: enabled (motion.on) and not muted (motion.mute, REQ-12). */
  private get active(): boolean {
    return this.enabled && !this.muted;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    const was = this.active;
    this.enabled = on;
    this.applyActive(was);
  }

  /** Song-tab mute — deactivates like setEnabled(false) but keeps motion.on. */
  setMuted(m: boolean): void {
    if (m === this.muted) return;
    const was = this.active;
    this.muted = m;
    this.applyActive(was);
  }

  /** React to an active-state flip: deactivating restores every baseline. */
  private applyActive(was: boolean): void {
    if (this.active === was) return;
    if (this.active) {
      if (this.clock.playing) this.startLoop();
    } else {
      this.stopLoop();
      this.restoreBaselines();
    }
  }

  setSlide(on: boolean): void {
    this.mode = on ? 'slide' : 'step';
  }

  onStep(fn: MotionStepListener): () => void {
    return this.stepListeners.add(fn);
  }

  /**
   * One evaluation at audio-clock time `nowS` — the frame loop's body, public
   * so tests can drive it deterministically without a real rAF.
   */
  frame(nowS: number): void {
    if (!this.active || !this.clock.playing) return;
    const curr = this.curr;
    if (!curr) return;
    // Evaluate against the tick whose *audible* window contains now: the
    // latest tick arrives (with its arrangement state) up to scheduleAheadS
    // early, so until now crosses its `when` the previous tick still governs —
    // rests and bank switches land on the heard bar boundary.
    const tick = nowS < curr.when && this.prev ? this.prev : curr;
    if (tick.dur <= 0) return;
    if (tick.resting) return;

    const bank = this.patterns.motionBank(tick.playBank);
    const base = this.xy.get();
    const axes = motionAxesFor(this.patterns, tick.playBank, base);
    // True playhead position in step units: the governing tick's index plus
    // the fraction of a step elapsed since (negative while that tick is still
    // ahead of now — valueAt wraps, matching the loop seam).
    const pos = tick.idx + (nowS - tick.when) / tick.dur;
    const v = valueAt(bank, pos / SEQ_LENGTH, this.mode, {
      prev: this.carryBank(tick.prevBank, tick.prevResting, axes, base),
      next: this.carryBank(tick.nextBank, tick.nextResting, axes, base),
    });
    if (!v) return;

    this.write(axes.x, v.x);
    this.write(axes.y, v.y);
  }

  /**
   * The neighbouring bar's bank as a carry target (REQ-2b), or null when there is
   * nothing meaningful to ramp toward: a rest bar writes nothing, and a bank
   * driving *other* params holds its anchors in a different value space — ramping
   * into either would move this bar's params for no authored reason.
   */
  private carryBank(
    bank: number,
    resting: boolean,
    axes: XyAssign,
    base: XyAssign,
  ): readonly MotionStep[] | null {
    if (resting) return null;
    const nb = motionAxesFor(this.patterns, bank, base);
    if (nb.x !== axes.x || nb.y !== axes.y) return null;
    return this.patterns.motionBank(bank);
  }

  private write(id: string, norm: number): void {
    const def = this.bus.def(id);
    if (!def) return;
    if (!this.baselines.has(id)) this.baselines.set(id, this.bus.get(id));
    this.bus.set(id, fromNorm(def, norm));
  }

  private restoreBaselines(): void {
    for (const [id, v] of this.baselines) this.bus.set(id, v);
    this.baselines.clear();
  }

  private startLoop(): void {
    if (this.rafId !== null) return;
    const step = (): void => {
      this.rafId = this.raf(step);
      const nowMs = Date.now();
      if (nowMs - this.lastFrameMs < this.minFrameMs) return;
      this.lastFrameMs = nowMs;
      this.frame(this.now());
    };
    this.rafId = this.raf(step);
  }

  private stopLoop(): void {
    if (this.rafId === null) return;
    this.caf(this.rafId);
    this.rafId = null;
  }
}
