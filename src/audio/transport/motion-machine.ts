import type { Arrangement } from './arrangement';
import type { MotionStep, MotionTrackStep, PatternStore } from '../../state/patterns';
import { MOTION_TRACK_COUNT } from '../../state/patterns';
import { LaneMeter } from './lane-meter';
import type { ParamBus } from '../../state/params';
import type { XyAssign, XyPadStore } from '../../state/xy-pad';
import { motionAxesInto, motionAxesMatch } from '../../state/xy-effective';
import { fromNorm } from '../../utils/taper';
import { createAnchorCache, valueAtInto, valueAt1D, type MotionMode, type MotionXY } from './motion-curve';
import { defaultTickTimer, type TickTimer } from './tick-timer';
import type { TickSubscriber } from './tick-source';
import { ListenerSet } from '../../utils/listeners';

export type MotionStepListener = (step: number) => void;

/**
 * "Evaluate this bank alone." Shared by the handover park (REQ-a-bank-parks-at-its-last-anchor), whose whole
 * point is the value the bank rests at rather than anything it was ramping
 * toward — and which only ever runs for params the next bar does not drive, i.e.
 * exactly where `carryBank` would have returned null anyway.
 */
const NO_CARRY = { prev: null, next: null };

/**
 * Cells the latch ring holds (REQ-the-governing-cell-is-the-latest-heard). It must
 * reach back past every cell queued ahead of `now` to the one being heard: the
 * weak tier's 0.2 s look-ahead plus a 25 ms wakeup, at 400 BPM and the finest
 * rate's two cells per tick, is ~12 cells. 32 leaves room; overflowing only
 * degrades to evaluating the oldest queued cell, never to a crash.
 */
const LATCH_SIZE = 32;

const newLatchedTick = (): LatchedTick => ({
  idx: 0, when: 0, span: 0, resting: false, playBank: 0,
  prevBank: 0, prevResting: false, nextBank: 0, nextResting: false,
});

/** The slice of `document` the frame loop's driver swap needs (REQ-the-motion-frame-loop-is-visibility-independent). */
export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
}

/** One scheduled cell plus the arrangement state captured with it — that state
 *  flips ahead of audible time, so frame() applies it only once `now` crosses
 *  the cell's `when`. */
interface LatchedTick {
  idx: number;
  when: number;
  /** Seconds to the next cell's onset on the swung grid (REQ-the-motion-playhead-follows-the-swung-grid). */
  span: number;
  resting: boolean;
  playBank: number;
  /** Neighbouring bars, for the bar-line carry (REQ-cross-bank-carry) — latched with the rest. */
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
  /** Wakeup source driving the loop while the document is hidden (REQ-the-motion-frame-loop-is-visibility-independent). */
  timer?: TickTimer;
  /** Visibility source; injectable so the driver swap is testable (REQ-the-motion-frame-loop-is-visibility-independent). */
  doc?: VisibilitySource;
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
 * unchanged values, so idle frames cost nothing). That one loop body has **two
 * drivers** (REQ-the-motion-frame-loop-is-visibility-independent): rAF while the document is visible, and the worker-backed
 * `TickTimer` while it is hidden, since browsers suspend rAF for a hidden
 * document and this loop decides what is *heard*, not what is drawn.
 * Arrangement state (rest
 * gate, play bank) advances with the scheduled tick too, so it is latched per
 * tick and applied at the tick's audible time (REQ-both-motion-modes-share-one-frame-loop) — reading it live would
 * truncate the final scheduleAheadS of every bar before a rest. The neighbouring
 * bars' banks are latched the same way and handed to the curve, so the segment
 * crossing the bar line ramps into the bank that actually plays next (REQ-cross-bank-carry).
 *
 * Baseline discipline (REQ-motion-writes-go-through-bus-set): the first write to a param in a play session
 * records its prior value; stop / disable restores every recorded baseline.
 * The machine never subscribes to the params it writes.
 */
export class MotionMachine {
  private enabled = false;
  private muted = false;
  /** The XY lane's interpolation mode; each extra track carries its own (REQ-set-steps-are-anchors). */
  private mode: MotionMode = 'slide';
  private readonly trackModes: MotionMode[] =
    Array.from({ length: MOTION_TRACK_COUNT }, () => 'slide' as MotionMode);
  /**
   * Every latched cell, newest at `latchHead - 1` (REQ-the-governing-cell-is-the-latest-heard).
   * Preallocated and overwritten in place, so latching allocates nothing
   * (REQ-the-motion-frame-loop-allocates-nothing).
   */
  private readonly latch: LatchedTick[] = Array.from({ length: LATCH_SIZE }, newLatchedTick);
  private latchHead = 0;
  private latchCount = 0;
  /** The last cell index latched this tick, for the one step emit per tick. */
  private lastIdx = -1;
  /**
   * The bank whose writes are live — `-1` while resting, and before the first
   * frame of a play session or of a seek. The handover park (REQ-a-bank-parks-at-its-last-anchor) reads it to
   * know which bank the chain just *left*; clearing it wherever the latch is
   * cleared is what keeps a seek or a stop from parking a bank nobody left.
   */
  private held = -1;
  private readonly baselines = new Map<string, number>();
  private readonly stepListeners = new ListenerSet<[number]>();
  /** Anchor-index memo for the frame loop; dropped on any bank mutation. */
  private readonly anchors = createAnchorCache();

  /** Whether the frame loop is armed — independent of *which* driver holds it. */
  private looping = false;
  private rafId: number | null = null;
  private lastFrameMs = 0;
  private readonly minFrameMs: number;
  private readonly now: () => number;
  private readonly raf: (cb: () => void) => number;
  private readonly caf: (id: number) => void;
  private readonly timer: TickTimer;
  private readonly doc: VisibilitySource | null;
  /** This machine's loop length + step rate (meter.md REQ-each-machine-has-a-loop-length/REQ-each-machine-has-a-step-rate). */
  readonly lane: LaneMeter;

  constructor(
    private readonly clock: TickSubscriber,
    private readonly patterns: PatternStore,
    private readonly arrangement: Arrangement,
    private readonly xy: XyPadStore,
    private readonly bus: ParamBus,
    opts: MotionMachineOpts = {},
  ) {
    this.lane = new LaneMeter(clock);
    this.minFrameMs = 1000 / (opts.fps ?? 60);
    this.now = opts.now ?? (() => 0);
    this.raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
    this.caf = opts.caf ?? ((id) => cancelAnimationFrame(id));
    // Lazy by construction: WorkerTimer spawns its Worker on the first start(),
    // so a session that is never backgrounded pays nothing for this.
    this.timer = opts.timer ?? defaultTickTimer();
    this.doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
    // One low-frequency global listener (runtime-performance.md REQ-global-listeners-live-only-for-a-gesture exempts
    // these). Never removed: the machine lives as long as the page does.
    this.doc?.addEventListener('visibilitychange', this.onVisibility);

    clock.onTick((step, when) => {
      // The LaneMeter is built with no stutter map on purpose: automation must
      // not follow a stutter remap (meter.md REQ-stutter-composes-with-length-and-rate). A cell finer than a tick
      // reports several times per tick, and each is latched — the frame loop
      // picks whichever one is being heard (REQ-the-governing-cell-is-the-latest-heard).
      this.lastIdx = -1;
      this.lane.forEachHit(step, when, this.latchCell);
      if (this.lastIdx < 0) return; // a coarser lane skips this tick entirely
      if (!this.enabled) return;
      this.stepListeners.emit(this.lastIdx);
    });
    clock.onStart(() => {
      this.latchCount = 0;
      this.held = -1;
      if (this.active) this.startLoop();
    });
    clock.onStop(() => {
      this.stopLoop();
      this.restoreBaselines();
    });
    // A playhead jump leaves `prev` and `curr` non-adjacent, so the frame loop
    // would interpolate across the gap — an audible glide to a value the curve
    // never contains. Drop the latch and let the next tick re-fill it, exactly
    // as onStart does. Emphatically NOT restoreBaselines(): those record each
    // param's value from before automation first touched it, for the whole play
    // session, and re-capturing them from automated values would lose the user's
    // original sound for good (motion-sequencer.md REQ-a-seek-clears-the-tick-latch).
    // `held` goes with the latch (v16): a seek lands wherever it lands, and the
    // bank it left was never *played* out of — parking it would write a value
    // the transport never reached (REQ-a-bank-parks-at-its-last-anchor).
    clock.onSeek(() => { this.latchCount = 0; this.held = -1; });

    // Anchor sets are cached across frames, and banks are mutated in place — so
    // every stream that can flip a step's `on` must drop the memo. Cheap to be
    // blunt about it: these fire on user edits and song loads, never per frame.
    const invalidate = (): void => this.anchors.clear();
    patterns.onMotionChange(invalidate);
    patterns.onMotionBankChange(invalidate);
    patterns.onMotionTrackChange(invalidate);
    patterns.onBulkRestore(invalidate);
  }

  /**
   * Latch one cell into the ring, with the arrangement state of the tick it
   * belongs to. Bound once, so a tick allocates no closure and no record
   * (REQ-the-motion-frame-loop-allocates-nothing).
   */
  private readonly latchCell = (idx: number, when: number, _cellDur: number, span: number): void => {
    const slot = this.latch[this.latchHead]!;
    slot.idx = idx;
    slot.when = when;
    slot.span = span;
    slot.resting = this.arrangement.motionResting;
    slot.playBank = this.arrangement.motionPlayBank;
    slot.prevBank = this.arrangement.motionPrevPlayBank;
    slot.prevResting = this.arrangement.motionPrevResting;
    slot.nextBank = this.arrangement.motionNextPlayBank;
    slot.nextResting = this.arrangement.motionNextResting;
    this.latchHead = (this.latchHead + 1) % LATCH_SIZE;
    if (this.latchCount < LATCH_SIZE) this.latchCount++;
    this.lastIdx = idx;
  };

  /**
   * The cell being heard at `nowS` (REQ-the-governing-cell-is-the-latest-heard):
   * the newest latched cell whose onset is at or before now. Cells arrive in
   * time order — swing delays an odd cell by less than a cell — so the scan
   * back from the newest stops at the first one heard. Before anything has been
   * heard (just after a start or seek) it is the oldest queued cell, evaluated
   * from a position still before its onset.
   */
  private governing(nowS: number): LatchedTick | null {
    const n = this.latchCount;
    if (n === 0) return null;
    for (let k = 1; k <= n; k++) {
      const slot = this.latch[(this.latchHead - k + LATCH_SIZE) % LATCH_SIZE]!;
      if (slot.when <= nowS) return slot;
    }
    return this.latch[(this.latchHead - n + LATCH_SIZE) % LATCH_SIZE]!;
  }

  /** Effective-active: enabled (motion.on) and not muted (motion.mute, REQ-motion-mute-is-an-ordinary-param). */
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

  /** The XY lane's mode (`motion.slide`). */
  setSlide(on: boolean): void {
    this.mode = on ? 'slide' : 'step';
  }

  /** One extra track's mode (`motion.t<i>.slide`) — independent of the XY lane
   *  and of the other track, so a bank can sweep one param while stepping another. */
  setTrackSlide(track: number, on: boolean): void {
    if (track < 0 || track >= this.trackModes.length) return;
    this.trackModes[track] = on ? 'slide' : 'step';
  }

  onStep(fn: MotionStepListener): () => void {
    return this.stepListeners.add(fn);
  }

  /**
   * One evaluation at audio-clock time `nowS` — the frame loop's body, public
   * so tests can drive it deterministically without a real rAF.
   *
   * Every write inside runs under `bus.withoutChangeSignal`: automation is not
   * a user edit (REQ-motion-baselines-are-unchanged). `frameAt` holds the clock time for the bracketed body
   * and `runFrame` is bound once in the constructor, so a 60 fps frame
   * allocates no closure (runtime-performance.md REQ-no-allocation-in-a-hot-loop).
   */
  frame(nowS: number): void {
    this.frameAt = nowS;
    this.bus.withoutChangeSignal(this.runFrame);
  }

  private frameAt = 0;
  private readonly runFrame = (): void => {
    const nowS = this.frameAt;
    if (!this.active || !this.clock.playing) return;
    // Evaluate against the cell whose *audible* window contains now: cells
    // arrive (with their arrangement state) up to scheduleAheadS early, so a
    // queued one governs only once now crosses its `when` — rests and bank
    // switches land on the heard bar boundary, at any tempo
    // (REQ-the-governing-cell-is-the-latest-heard).
    const tick = this.governing(nowS);
    if (!tick || tick.span <= 0) return;

    // The chain has moved on — park the bank it left at its last anchor before
    // this bar writes anything (REQ-a-bank-parks-at-its-last-anchor). A rest holds nothing of its own, so it
    // reads as "no bank live" on both sides of the comparison.
    const live = tick.resting ? -1 : tick.playBank;
    if (this.held >= 0 && this.held !== live) this.parkBank(this.held, tick);
    this.held = live;
    if (tick.resting) return;

    const bank = this.patterns.motionBank(tick.playBank);
    // Read into the frame's reusable holders rather than taking three fresh
    // objects per frame (runtime-performance.md REQ-no-allocation-in-a-hot-loop) — the same reason
    // `neighbours` below is refilled instead of rebuilt.
    const base = this.base;
    const axes = this.axes;
    this.xy.readAssignInto(base);
    motionAxesInto(this.patterns, tick.playBank, base, axes);
    // True playhead position in step units: the governing cell's index plus
    // the fraction of its span elapsed since (negative while that cell is still
    // ahead of now — valueAt wraps, matching the loop seam). Over the *span*,
    // not the cell duration: under swing the cells are not evenly spaced, and
    // only the span reaches `idx + 1` exactly when the next cell sounds
    // (REQ-the-motion-playhead-follows-the-swung-grid).
    const pos = tick.idx + (nowS - tick.when) / tick.span;
    // `neighbours` is reused rather than rebuilt: this runs up to 60x/s
    // (runtime-performance.md REQ-no-allocation-in-a-hot-loop), and valueAt only reads it.
    this.neighbours.prev = this.carryBank(tick.prevBank, tick.prevResting, axes, base);
    this.neighbours.next = this.carryBank(tick.nextBank, tick.nextResting, axes, base);
    const cells = this.lane.cells;
    if (valueAtInto(bank, pos / cells, this.mode, this.neighbours, this.anchors, this.xyOut, cells)) {
      this.write(axes.x, this.xyOut.x);
      this.write(axes.y, this.xyOut.y);
    }

    this.frameTracks(tick, pos);
  };

  /**
   * Frame scratch, refilled each frame rather than rebuilt (REQ-motion-has-the-fourth-chain-lane): the XY Pad's
   * base assignment, the axes this bank actually drives, and the value read off
   * the curve. Private and never handed out, so the sharing is invisible.
   */
  private readonly base: XyAssign = { x: '', y: '' };
  private readonly axes: XyAssign = { x: '', y: '' };
  private readonly xyOut: MotionXY = { x: 0, y: 0 };

  /** Scratch carry pair, refilled each frame (see the comment in runFrame). */
  private readonly neighbours: { prev: readonly MotionStep[] | null; next: readonly MotionStep[] | null } =
    { prev: null, next: null };
  private readonly trackNeighbours: { prev: readonly MotionTrackStep[] | null; next: readonly MotionTrackStep[] | null } =
    { prev: null, next: null };

  /** Park scratch: the outgoing bank's axes, and every id the incoming bar drives. */
  private readonly heldAxes: XyAssign = { x: '', y: '' };
  private readonly driven = new Set<string>();

  /**
   * The chain has left `outBank` (REQ-a-bank-parks-at-its-last-anchor). Write its **last in-lane anchor** —
   * the curve at the lane's seam, with no carry, which is that anchor in both
   * modes — for every param the incoming bar does not drive itself.
   *
   * Without this a bank parks wherever the bar line happened to fall inside its
   * loop. While every lane was 16 cells against a 16-tick bar those were the
   * same instant, so the bank always ended on its last cell for free; a lane
   * that does not tile the bar (meter.md REQ-each-machine-has-a-loop-length) ends its bar mid-sweep, and
   * with nothing else driving those params they held that arbitrary value until
   * the bank came round again. A lane that *does* tile the bar writes the value
   * already there, so nothing about those songs changes.
   *
   * Params the incoming bar keeps driving are skipped rather than written and
   * immediately overwritten: it evaluates them later in this same frame, and
   * putting the outgoing seam in front of that would insert a value the curve
   * never contains — exactly what REQ-cross-bank-carry's carry exists to avoid.
   *
   * Runs at most once per bar, so it may allocate nothing per *frame* but is not
   * on the 60 fps path itself (runtime-performance.md REQ-no-allocation-in-a-hot-loop); the scratch above
   * is reused all the same, since `runFrame` refills its own straight after.
   */
  private parkBank(outBank: number, incoming: LatchedTick): void {
    const base = this.base;
    this.xy.readAssignInto(base);
    this.fillDriven(incoming, base);
    const axes = this.heldAxes;
    motionAxesInto(this.patterns, outBank, base, axes);
    const cells = this.lane.cells;
    // A sliver before the seam — `barPos` 1 wraps back to 0, which would give
    // the bank's *opening* value instead of its last anchor.
    const seam = (cells - 1e-6) / cells;
    const bank = this.patterns.motionBank(outBank);
    if (valueAtInto(bank, seam, this.mode, NO_CARRY, this.anchors, this.xyOut, cells)) {
      if (!this.driven.has(axes.x)) this.write(axes.x, this.xyOut.x);
      if (!this.driven.has(axes.y)) this.write(axes.y, this.xyOut.y);
    }
    const tracks = this.patterns.motionTracks(outBank);
    for (let t = 0; t < MOTION_TRACK_COUNT; t++) {
      const track = tracks[t];
      const id = track?.param;
      if (!track || !id || this.driven.has(id)) continue;
      const v = valueAt1D(track.steps, seam, this.trackModes[t]!, NO_CARRY, this.anchors, cells);
      if (v !== null) this.write(id, v);
    }
  }

  /** Every param id the incoming bar drives itself — a rest drives none. */
  private fillDriven(tick: LatchedTick, base: XyAssign): void {
    const ids = this.driven;
    ids.clear();
    if (tick.resting) return;
    const axes = this.axes;
    motionAxesInto(this.patterns, tick.playBank, base, axes);
    ids.add(axes.x);
    ids.add(axes.y);
    const tracks = this.patterns.motionTracks(tick.playBank);
    for (let t = 0; t < MOTION_TRACK_COUNT; t++) {
      const id = tracks[t]?.param;
      if (id) ids.add(id);
    }
  }

  /**
   * The extra single-param tracks (REQ-extra-single-param-tracks-per-bank/REQ-tracks-share-the-lanes-curve-semantics). Each is evaluated with the
   * same scalar core the XY axes use, so slide/step and the bar-line carry are
   * identical by construction. An unassigned track — or one with no anchors —
   * writes nothing; that is the no-op default, and it is why the tracks need no
   * on/off of their own.
   */
  private frameTracks(tick: LatchedTick, pos: number): void {
    const tracks = this.patterns.motionTracks(tick.playBank);
    for (let t = 0; t < MOTION_TRACK_COUNT; t++) {
      const track = tracks[t];
      const id = track?.param;
      if (!track || !id) continue;
      this.trackNeighbours.prev = this.carryTrack(tick.prevBank, tick.prevResting, t, id);
      this.trackNeighbours.next = this.carryTrack(tick.nextBank, tick.nextResting, t, id);
      const cells = this.lane.cells;
      const v = valueAt1D(
        track.steps, pos / cells, this.trackModes[t]!, this.trackNeighbours, this.anchors, cells,
      );
      if (v !== null) this.write(id, v);
    }
  }

  /**
   * A neighbouring bar's same-index track as a carry target — usable only when it
   * drives the *same* param, mirroring `carryBank`'s rule for the axes. A track
   * pointed at a different param holds its anchors in another value space, so
   * ramping toward it would move this bar's param for no authored reason.
   */
  private carryTrack(
    bank: number,
    resting: boolean,
    track: number,
    id: string,
  ): readonly MotionTrackStep[] | null {
    if (resting) return null;
    const nb = this.patterns.motionTracks(bank)[track];
    if (!nb || nb.param !== id) return null;
    return nb.steps;
  }

  /**
   * The neighbouring bar's bank as a carry target (REQ-cross-bank-carry), or null when there is
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
    // `motionAxesMatch`, not `motionAxesFor(...)` compared field-by-field: same
    // answer, no object per neighbour per frame (runtime-performance.md REQ-no-allocation-in-a-hot-loop).
    if (!motionAxesMatch(this.patterns, bank, base, axes)) return null;
    return this.patterns.motionBank(bank);
  }

  private write(id: string, norm: number): void {
    const def = this.bus.def(id);
    if (!def) return;
    if (!this.baselines.has(id)) this.baselines.set(id, this.bus.get(id));
    this.bus.set(id, fromNorm(def, norm));
  }

  /** Return every automated param to its pre-automation value. Suppressed like
   *  the writes it undoes — putting a value back is not a user edit either. */
  private restoreBaselines(): void {
    this.bus.withoutChangeSignal(this.runRestoreBaselines);
  }

  private readonly runRestoreBaselines = (): void => {
    for (const [id, v] of this.baselines) this.bus.set(id, v);
    this.baselines.clear();
    // Nothing is live any more, so the next frame must not park what this just
    // undid (REQ-a-bank-parks-at-its-last-anchor) — a stop, a mute or motion.on → 0 is not a handover.
    this.held = -1;
  };

  private startLoop(): void {
    if (this.looping) return;
    this.looping = true;
    this.attachDriver();
  }

  private stopLoop(): void {
    if (!this.looping) return;
    this.looping = false;
    this.detachDriver();
  }

  /**
   * Arm whichever driver suits the document's current visibility (REQ-the-motion-frame-loop-is-visibility-independent).
   * rAF is suspended for a hidden document, and this loop drives what is heard —
   * so hidden falls back to the worker timer the transport clock already uses.
   */
  private attachDriver(): void {
    if (this.doc?.hidden) this.timer.start(this.wake, this.minFrameMs);
    else this.rafId = this.raf(this.rafStep);
  }

  private detachDriver(): void {
    this.timer.stop();
    if (this.rafId !== null) {
      this.caf(this.rafId);
      this.rafId = null;
    }
  }

  /** Swap drivers under a running loop — never start, stop or restore anything:
   *  hiding the tab is not a transport event, and restoring baselines here would
   *  jump the sound on every tab switch (REQ-motion-writes-go-through-bus-set). */
  private readonly onVisibility = (): void => {
    if (!this.looping) return;
    this.detachDriver();
    this.attachDriver();
  };

  /** Bound once, so re-arming the loop allocates no closure (REQ-the-motion-frame-loop-allocates-nothing). */
  private readonly rafStep = (): void => {
    this.rafId = this.raf(this.rafStep);
    const nowMs = Date.now();
    if (nowMs - this.lastFrameMs < this.minFrameMs) return;
    this.lastFrameMs = nowMs;
    this.frame(this.now());
  };

  /** The hidden driver already fires at `minFrameMs`, so it skips that throttle:
   *  a wakeup landing a millisecond early would otherwise drop every other frame
   *  and halve the rate. A wakeup in flight past `stop()` is harmless — `frame`
   *  early-returns unless playing ∧ active. */
  private readonly wake = (): void => {
    this.lastFrameMs = Date.now();
    this.frame(this.now());
  };
}
