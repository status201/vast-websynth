import type { Clock } from '../clock';
import { JOIN_LEAD_MS, type SyncMessage } from './sync-types';
import { PulseBpmEstimator } from './bpm-estimator';
import { MAX_SYNC_JOIN_LEAD_MS } from '../../../state/limits';

/**
 * Slave role: follow a remote transport arriving as `SyncMessage`s.
 *
 * - 'start' moves the local clock to **step 0**, so bars realign
 *   (REQ-slave-restarts-from-zero-on-start). 'songposition' records a pending
 *   beat and 'continue' moves **to that beat** (REQ-song-position-pointer-jumps-the-slave) — a slave joining
 *   mid-song lands on the right bar instead of restarting at 0.
 * - (v8) Either join sounds on its **first pulse** (REQ-a-join-is-timed-by-its-first-pulse): at the
 *   message's own `at` when the transport carries one, otherwise at the first
 *   pulse at or after the message — never at "arrival + 50 ms", which was right
 *   only for this app's own master. A slave already following this master
 *   jumps in place on its phase-locked grid (REQ-a-following-slave-jumps-in-place); one playing on
 *   its own restarts.
 * - 'stop' stops it.
 * - 'pulse' (24 PPQN) feeds tempo estimation and phase correction. After a
 *   (re)start, pulses are ignored for a settle window (REQ-a-post-start-settle-window): a
 *   scheduled-send transport (Web MIDI) can reorder, so a stale in-flight
 *   tail may trail the start/continue; the first post-settle pulse re-anchors
 *   the counter from arrival time.
 * - 'tempo' (v2) sets the clock BPM explicitly; while a tempo message is fresh
 *   the pulse-estimate write path is suppressed (an explicit-tempo WiFi master
 *   wins), falling back to pulse estimation automatically when tempo messages
 *   stop (a MIDI-only master, which never sends 'tempo').
 *
 * Tempo is written via `clock.setBpm()` directly, never the bus (REQ-slave-follows-tempo-from-pulses): the
 * bus clamps 40..240, bus writes get baked into saved songs, and the
 * `transport.bpm` subscription would loop. Phase drift is corrected with
 * bounded `clock.nudge()` calls (REQ-phase-correction-uses-nudge) — the local grid's tick times are
 * recorded per step, each 12th pulse is matched to its step's grid time
 * (offset by the join `startStep`), and the EMA-smoothed error is nudged away
 * at most once per beat. An error past ~a pulse interval means the numbering
 * is skewed (reordered/stale/lost pulses) — the counter re-anchors from
 * arrival time instead of chasing it (REQ-sync-phase-re-anchor).
 *
 * On pulse silence > STALL_S while playing, the slave keeps playing at the
 * last tempo and reports `stalled` (REQ-a-stalled-pulse-stream-is-tolerated) — a USB hiccup must not kill a
 * performance; a 'stop' still stops it.
 *
 * All tuning constants live in the block below for field adjustment (USB MIDI
 * jitter varies wildly across devices).
 */

const WINDOW_PULSES = 24;        // estimator window: 24 intervals ~= one beat
const EMA_ALPHA = 0.25;          // estimator smoothing
const GAP_RESET_MS = 250;        // estimator window reset across gaps
const BPM_WRITE_MIN_MS = 250;    // setBpm throttle: time...
const BPM_WRITE_MIN_DELTA = 0.5; // ...and magnitude
const NUDGE_MAX_S = 0.010;       // per phase correction
const NUDGE_DEADBAND_S = 0.005;  // corrections below this are transport-latency noise
const NUDGE_MIN_PULSES = 24;     // at most one nudge per beat
const PHASE_ALPHA = 0.25;        // phase-error smoothing
const REANCHOR_RATIO = 0.75;     // |phaseErr| beyond this × pulse interval -> re-anchor
const REANCHOR_MIN_S = 0.015;    // re-anchor floor so delivery-jitter spikes can't trigger it
const PHASE_MISS_REANCHOR = 2;   // consecutive unmeasurable pulses -> re-anchor
const START_SETTLE_BASE_MS = 300; // + 12 pulse intervals: post-(re)start pulse-ignore span (REQ-a-post-start-settle-window)
const STALL_S = 1.0;             // pulse silence -> stalled
const TICK_MEMORY = 16;          // recorded grid times (steps) — a look-ahead-sized window
const TEMPO_MSG_FRESH_MS = 2500; // while a 'tempo' msg is this fresh, suppress pulse-estimate writes
const TEMPO_WRITE_MIN_DELTA = 0.05; // ignore a 'tempo' within this of the last written BPM

export interface SyncSlaveOptions {
  /** The BPM knob's bus value — the restore target when the role ends. */
  localBpm: () => number;
  /** performance.now()-domain ms -> AudioContext seconds. */
  toAudioTime: (perfMs: number) => number;
  /**
   * Adopt the master's time signature (meter.md REQ-meter-travels-on-the-wifi-wire). Injected rather than
   * writing the bus here: the meter is two `ParamBus` scalars, and the audio
   * layer reaching for the bus would invert the dependency the whole app is
   * built on (architecture REQ-ui-and-audio-never-call-each-other). Omitted in tests that don't exercise it.
   */
  setMeter?: (beats: number, unit: number) => void;
}

export class SyncSlave {
  private readonly estimator = new PulseBpmEstimator({
    windowPulses: WINDOW_PULSES, emaAlpha: EMA_ALPHA, gapResetMs: GAP_RESET_MS,
  });
  private unsubs: Array<() => void> = [];
  private readonly changeListeners = new Set<() => void>();

  /** Recent local grid times, newest last — every step, at its UNSWUNG time (v8: a
   *  jump to an odd step puts pulse 0 on an odd step, which even-only records
   *  could never measure). */
  private tickTimes: Array<{ step: number; when: number }> = [];
  private pulseCount = 0;
  private startStep = 0;           // the step the current run started on (Song-Position join)
  private pendingBeat = 0;         // last 'songposition' — the step 'continue' will start from
  private lastPulseAudioT: number | null = null;
  private lastWriteMs = -Infinity;
  private lastWrittenBpm: number | null = null;
  private lastTempoMsgAtMs = -Infinity;
  private phaseErr: number | null = null;
  private phaseMisses = 0;
  private pulsesSinceNudge = 0;
  private settleUntilMs = -Infinity; // pulses before this are a reordered in-flight tail
  private needsAnchor = false;       // first post-settle pulse derives the counter from time
  private _stalled = false;
  /** Our clock was started by a join and has not stopped or been restarted
   *  locally since — so its grid is phase-locked and a join can jump it in place
   *  (REQ-a-following-slave-jumps-in-place). */
  private following = false;
  /** Set around our own `clock.start`, so onStart can tell it from a local Play. */
  private starting = false;
  /** A join with no time on it, waiting for its first pulse (REQ-a-join-is-timed-by-its-first-pulse). */
  private pendingJoin: { fromStep: number; afterMs: number } | null = null;
  /** An in-place jump whose pulse numbering switches at `atMs` (REQ-a-following-slave-jumps-in-place). */
  private pendingSwitch: { fromStep: number; atMs: number } | null = null;
  /** Where the current pulse numbering begins; an older pulse arriving late belongs to the run before. */
  private runStartMs = -Infinity;

  constructor(private readonly clock: Clock, private readonly opts: SyncSlaveOptions) {}

  enable(): void {
    if (this.unsubs.length) return;
    this.unsubs.push(
      this.clock.onTick(this.onTick),
      // A local Play, or any stop, means the grid is no longer one a join set.
      this.clock.onStart(() => { if (!this.starting) this.following = false; }),
      this.clock.onStop(() => { this.following = false; }),
    );
  }

  /** Ends the role: local tempo comes back; a playing clock keeps playing. */
  disable(): void {
    if (!this.unsubs.length) return;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.clock.setBpm(this.opts.localBpm());
    this.resetFollowState();
    this.pendingJoin = null;
    this.following = false;
    this.estimator.reset();
    this._stalled = false;
    this.lastTempoMsgAtMs = -Infinity;
  }

  handleMessage(msg: SyncMessage, receivedAtMs: number): void {
    switch (msg.type) {
      case 'start':
        this.pendingBeat = 0;
        this.join(0, msg.at, receivedAtMs);
        break;
      case 'continue':
        this.join(this.pendingBeat, msg.at, receivedAtMs);
        break;
      case 'songposition':
        this.pendingBeat = msg.beat & 0xffff;
        break;
      case 'meter':
        // Applied immediately, not on the next start: `pendingBeat` is a count of
        // 16ths, and which BAR that lands in is exactly what the meter decides.
        this.opts.setMeter?.(msg.beats, msg.unit);
        break;
      case 'stop':
        this.pendingJoin = null; // a join still waiting for its pulse is cancelled too
        this.pendingSwitch = null;
        this.clock.stop();
        this.setStalled(false);
        this.emitChange();
        break;
      case 'pulse':
        this.onPulse(receivedAtMs);
        break;
      case 'tempo':
        this.onTempo(msg.bpm, receivedAtMs);
        break;
    }
  }

  get followedBpm(): number | null {
    return this.estimator.bpm;
  }

  get stalled(): boolean {
    return this._stalled;
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => { this.changeListeners.delete(cb); };
  }

  /**
   * A `start` / `continue` arrived (REQ-a-join-is-timed-by-its-first-pulse). With a time on it the
   * first step is that time plus the master's lead — clamped, since a peer
   * supplies it; without one it waits for the first pulse at or after the
   * message, which is exactly what MIDI hardware counts from.
   */
  private join(fromStep: number, at: number | undefined, receivedAtMs: number): void {
    this.pendingJoin = null;
    if (at !== undefined && Number.isFinite(at)) {
      this.applyJoin(fromStep, Math.min(at, receivedAtMs + MAX_SYNC_JOIN_LEAD_MS) + JOIN_LEAD_MS);
    } else {
      this.pendingJoin = { fromStep, afterMs: receivedAtMs };
    }
  }

  /**
   * Put `fromStep` at `firstMs`. Following, that is a jump on the phase-locked
   * grid (REQ-a-following-slave-jumps-in-place): no restart, no settle, and the pulse numbering
   * switches at the jump's time. Otherwise the clock (re)starts there — the
   * clock seeds its step before onStart so the Arrangement seeks to the right
   * bar (REQ-song-position-pointer-jumps-the-slave).
   */
  private applyJoin(fromStep: number, firstMs: number): void {
    const firstS = this.opts.toAudioTime(firstMs);
    if (this.clock.playing && this.following) {
      this.clock.seekAt(fromStep, firstS);
      this.pendingSwitch = { fromStep, atMs: firstMs };
      this.emitChange();
      return;
    }
    if (this.clock.playing) this.clock.stop();
    this.resetFollowState(fromStep);
    this.runStartMs = firstMs;
    // Scheduled-send transports reorder: an idle tail the flush could not
    // cancel still arrives after this. Ignore the whole possible in-flight span
    // (idle horizon + one 12-pulse batch, in current-tempo terms), counted from
    // the first step rather than from the message (REQ-a-post-start-settle-window). The first pulse
    // after it re-anchors the counter (REQ-sync-phase-re-anchor), on a grid that
    // now starts in the right place.
    this.settleUntilMs = firstMs + START_SETTLE_BASE_MS + 2000 * this.clock.sixteenthDuration();
    this.needsAnchor = true;
    this.starting = true;
    try {
      this.clock.start(fromStep, firstS);
    } finally {
      this.starting = false;
    }
    this.following = true;
    this.emitChange();
  }

  /**
   * The in-place jump's time has come, as far as pulses are concerned
   * (REQ-a-following-slave-jumps-in-place): number pulses afresh from it, keep the recorded grid at
   * and after it under the new step numbers, and drop the rest — a looped bar
   * reuses its step numbers, so an old record would match a pulse to the wrong
   * pass. The first pulse's index comes from its time, which also absorbs one
   * that overtook the join on another channel.
   */
  private switchRun(atMs: number, fromStep: number, pulseAtMs: number): void {
    const sixteenth = this.clock.sixteenthDuration();
    const atS = this.opts.toAudioTime(atMs);
    const kept: Array<{ step: number; when: number }> = [];
    for (const rec of this.tickTimes) {
      if (rec.when < atS - sixteenth / 2) continue;
      kept.push({ step: fromStep + Math.round((rec.when - atS) / sixteenth), when: rec.when });
    }
    this.tickTimes = kept;
    this.startStep = Math.max(0, Math.floor(fromStep));
    this.pulseCount = Math.max(0, Math.round((pulseAtMs - atMs) / ((sixteenth / 6) * 1000)));
    this.phaseErr = null;
    this.phaseMisses = 0;
    this.pulsesSinceNudge = 0;
    this.runStartMs = atMs;
  }

  private onTempo(bpm: number, receivedAtMs: number): void {
    // Record freshness even if we don't rewrite — it's what suppresses the
    // pulse-estimate path (an explicit-tempo master wins over jittery pulses).
    this.lastTempoMsgAtMs = receivedAtMs;
    if (this.lastWrittenBpm !== null && Math.abs(bpm - this.lastWrittenBpm) < TEMPO_WRITE_MIN_DELTA) return;
    this.clock.setBpm(bpm);
    this.lastWrittenBpm = bpm;
    this.lastWriteMs = receivedAtMs;
    this.emitChange();
  }

  private onPulse(receivedAtMs: number): void {
    // Stall bookkeeping always runs — a settling pulse still proves the wire
    // is alive.
    this.lastPulseAudioT = this.opts.toAudioTime(receivedAtMs);
    this.setStalled(false);
    const halfPulseMs = (this.clock.sixteenthDuration() / 12) * 1000;
    // A join waiting for its first pulse (REQ-a-join-is-timed-by-its-first-pulse): this is it.
    const pj = this.pendingJoin;
    if (pj && receivedAtMs >= pj.afterMs) {
      this.pendingJoin = null;
      this.applyJoin(pj.fromStep, receivedAtMs);
    }
    // An in-place jump's numbering switches on its first pulse (REQ-a-following-slave-jumps-in-place).
    const sw = this.pendingSwitch;
    if (sw && receivedAtMs >= sw.atMs - halfPulseMs) {
      this.pendingSwitch = null;
      this.switchRun(sw.atMs, sw.fromStep, receivedAtMs);
    }
    // A pulse from before the current run, delivered late (the WiFi timing
    // channel is unordered): it belongs to numbering that no longer exists.
    if (receivedAtMs < this.runStartMs - halfPulseMs) return;
    // Post-(re)start settle (REQ-a-post-start-settle-window): a reordered stale tail may trail the
    // start/continue — drop the whole span so it can neither spike the
    // estimator nor skew the pulse counter.
    if (this.clock.playing && receivedAtMs < this.settleUntilMs) return;
    // The estimator is fed otherwise — even while stopped — so hardware
    // masters that send continuous clock warm the tempo before the first
    // start (REQ-slave-follows-tempo-from-pulses).
    this.estimator.addPulse(receivedAtMs);
    this.maybeWriteBpm(receivedAtMs);
    if (!this.clock.playing) return;
    if (this.needsAnchor) {
      // An unknown number of run pulses fell inside the settle — derive the
      // counter from arrival time before measuring anything (REQ-sync-phase-re-anchor).
      if (this.reanchor(receivedAtMs, this.clock.sixteenthDuration() / 6)) this.needsAnchor = false;
      return;
    }
    this.trackPhase(this.pulseCount++, receivedAtMs);
  }

  private maybeWriteBpm(nowMs: number): void {
    // An explicit 'tempo' message, while fresh, is authoritative — let it drive
    // the clock and hold the pulse estimate back (it still runs, for fallback).
    if (nowMs - this.lastTempoMsgAtMs < TEMPO_MSG_FRESH_MS) return;
    const bpm = this.estimator.bpm;
    if (bpm === null) return;
    if (nowMs - this.lastWriteMs < BPM_WRITE_MIN_MS) return;
    if (this.lastWrittenBpm !== null && Math.abs(bpm - this.lastWrittenBpm) < BPM_WRITE_MIN_DELTA) return;
    this.clock.setBpm(bpm);
    this.lastWriteMs = nowMs;
    this.lastWrittenBpm = bpm;
    this.emitChange();
  }

  /**
   * Phase correction. Pulses are numbered from the start ('start'/'continue'):
   * pulse 0 = the run's `startStep`. Every 12th pulse lands on an even step
   * whose unswung grid time we recorded from our own onTick (the look-ahead
   * means the tick has always fired by the time its pulse arrives). Error =
   * arrival − local grid time; positive = master runs late relative to us, so
   * future steps shift later.
   *
   * Re-anchor (midi-clock-sync REQ-sync-phase-re-anchor): a healthy corrector never sees errors
   * beyond delivery jitter, so a smoothed error past ~a pulse interval means
   * the numbering itself is skewed (stale in-flight pulses reordered past a
   * Start, or lost pulses). Chasing it with ±10 ms nudges would *hold* the
   * skew forever — instead re-derive the counter from this pulse's arrival
   * time against the recorded local grid and start measuring afresh.
   */
  private trackPhase(pulse: number, receivedAtMs: number): void {
    this.pulsesSinceNudge++;
    if (pulse % 12 !== 0) return;
    const pulseS = this.clock.sixteenthDuration() / 6;
    const step = this.startStep + pulse / 6;
    const rec = this.tickTimes.find((t) => t.step === step);
    if (!rec) {
      // The look-ahead guarantees a tick precedes its own pulse, so persistent
      // misses mean the mapped step lies beyond the look-ahead — a skew too
      // large to even measure. Re-anchor instead of going silent (REQ-sync-phase-re-anchor).
      if (this.tickTimes.length > 0 && ++this.phaseMisses >= PHASE_MISS_REANCHOR) {
        this.reanchor(receivedAtMs, pulseS);
      }
      return;
    }
    this.phaseMisses = 0;
    const err = this.opts.toAudioTime(receivedAtMs) - rec.when;
    this.phaseErr = this.phaseErr === null ? err : this.phaseErr + PHASE_ALPHA * (err - this.phaseErr);
    if (Math.abs(this.phaseErr) > Math.max(REANCHOR_RATIO * pulseS, REANCHOR_MIN_S)) {
      this.reanchor(receivedAtMs, pulseS);
      return;
    }
    if (this.pulsesSinceNudge < NUDGE_MIN_PULSES) return;
    if (Math.abs(this.phaseErr) < NUDGE_DEADBAND_S) return;
    this.clock.nudge(Math.max(-NUDGE_MAX_S, Math.min(NUDGE_MAX_S, this.phaseErr)));
    this.pulsesSinceNudge = 0;
    this.phaseErr = null; // pre-nudge measurements are stale now
  }

  /** Re-derive the pulse counter from arrival time vs. the recorded local grid
   *  (nearest even step, then rounded pulse offset). Residual accuracy is
   *  ± half a pulse interval — at Start the true error is milliseconds, so the
   *  anchor lands on the true grid. Returns false when no usable grid record
   *  exists yet (caller retries on the next pulse). */
  private reanchor(receivedAtMs: number, pulseS: number): boolean {
    const t = this.opts.toAudioTime(receivedAtMs);
    let nearest: { step: number; when: number } | null = null;
    for (const rec of this.tickTimes) {
      if (nearest === null || Math.abs(t - rec.when) < Math.abs(t - nearest.when)) nearest = rec;
    }
    if (!nearest) return false;
    // The clock's step counter no longer wraps (transport.md REQ-the-step-counter-is-bounded-at-ingress), so a
    // backwards delta is simply negative — it used to have to be recovered from
    // a 16-bit fold by testing against 0x8000.
    const stepDelta = nearest.step - this.startStep;
    if (stepDelta < 0) return false; // grid memory predates this run
    const idx = stepDelta * 6 + Math.round((t - nearest.when) / pulseS);
    if (idx < 0) return false;
    this.pulseCount = idx + 1; // this pulse was idx; the next one continues from there
    this.phaseErr = null;      // pre-anchor measurements are meaningless now
    this.phaseMisses = 0;
    this.pulsesSinceNudge = 0; // demand a fresh beat of clean measurements before nudging
    return true;
  }

  private onTick = (step: number, when: number): void => {
    // Every step, unswung: MIDI clock is straight, and pulses map to the grid.
    this.tickTimes.push({ step, when: when - this.clock.swingOffset(step) });
    if (this.tickTimes.length > TICK_MEMORY) this.tickTimes.shift();
    // Stall check rides the tick (fires every 16th while playing — no extra
    // timer). `when` is look-ahead time, close enough for a 1 s threshold.
    if (this.lastPulseAudioT !== null && when - this.lastPulseAudioT > STALL_S) {
      this.setStalled(true);
    }
  };

  private resetFollowState(startStep = 0): void {
    this.startStep = Math.max(0, Math.floor(startStep));
    this.tickTimes = [];
    this.pulseCount = 0;
    this.phaseErr = null;
    this.phaseMisses = 0;
    this.pulsesSinceNudge = 0;
    this.settleUntilMs = -Infinity;
    this.needsAnchor = false;
    this.pendingSwitch = null;
    this.runStartMs = -Infinity;
  }

  private setStalled(v: boolean): void {
    if (this._stalled === v) return;
    this._stalled = v;
    this.emitChange();
  }

  private emitChange(): void {
    for (const l of this.changeListeners) l();
  }
}
