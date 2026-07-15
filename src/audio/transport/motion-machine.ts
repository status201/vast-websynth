import type { Arrangement } from './arrangement';
import type { PatternStore } from '../../state/patterns';
import { SEQ_LENGTH } from '../../state/patterns';
import type { ParamBus } from '../../state/params';
import type { XyPadStore } from '../../state/xy-pad';
import { fromNorm } from '../../utils/taper';
import { valueAt, type MotionMode } from './motion-curve';
import type { TickSubscriber } from './tick-source';

export type MotionStepListener = (step: number) => void;

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
 * unchanged values, so idle frames cost nothing).
 *
 * Baseline discipline (REQ-5): the first write to a param in a play session
 * records its prior value; stop / disable restores every recorded baseline.
 * The machine never subscribes to the params it writes.
 */
export class MotionMachine {
  private enabled = false;
  private mode: MotionMode = 'slide';
  private lastTick: { idx: number; when: number; dur: number } | null = null;
  private readonly baselines = new Map<string, number>();
  private readonly stepListeners = new Set<MotionStepListener>();

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
      this.lastTick = { idx, when, dur: clock.sixteenthDuration() };
      if (!this.enabled) return;
      for (const l of this.stepListeners) l(idx);
    });
    clock.onStart(() => {
      this.lastTick = null;
      if (this.enabled) this.startLoop();
    });
    clock.onStop(() => {
      this.stopLoop();
      this.restoreBaselines();
    });
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
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
    this.stepListeners.add(fn);
    return () => { this.stepListeners.delete(fn); };
  }

  /**
   * One evaluation at audio-clock time `nowS` — the frame loop's body, public
   * so tests can drive it deterministically without a real rAF.
   */
  frame(nowS: number): void {
    if (!this.enabled || !this.clock.playing) return;
    const tick = this.lastTick;
    if (!tick || tick.dur <= 0) return;
    if (this.arrangement.motionResting) return;

    const bank = this.patterns.motionBank(this.arrangement.motionPlayBank);
    // True playhead position in step units: the last scheduled tick's index
    // plus the fraction of a step elapsed since (negative while the tick is
    // still ahead of now — valueAt wraps, matching the loop seam).
    const pos = tick.idx + (nowS - tick.when) / tick.dur;
    const v = valueAt(bank, pos / SEQ_LENGTH, this.mode);
    if (!v) return;

    const assign = this.patterns.motionAssign(this.arrangement.motionPlayBank);
    const base = this.xy.get();
    this.write(assign?.x ?? base.x, v.x);
    this.write(assign?.y ?? base.y, v.y);
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
