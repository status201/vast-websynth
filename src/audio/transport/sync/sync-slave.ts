import type { Clock } from '../clock';
import type { SyncMessage } from './sync-types';
import { PulseBpmEstimator } from './bpm-estimator';

/**
 * Slave role: follow a remote transport arriving as `SyncMessage`s.
 *
 * - 'start'/'continue' (re)start the local clock **from step 0** — a restart
 *   even if already playing, so bars realign (REQ-3).
 * - 'stop' stops it.
 * - 'pulse' (24 PPQN) feeds tempo estimation and phase correction.
 *
 * Tempo is written via `clock.setBpm()` directly, never the bus (REQ-4): the
 * bus clamps 40..240, bus writes get baked into saved songs, and the
 * `transport.bpm` subscription would loop. Phase drift is corrected with
 * bounded `clock.nudge()` calls (REQ-5) — the local grid's tick times are
 * recorded per step, each 12th pulse is matched to its step's grid time, and
 * the EMA-smoothed error is nudged away at most once per beat.
 *
 * On pulse silence > STALL_S while playing, the slave keeps playing at the
 * last tempo and reports `stalled` (REQ-6) — a USB hiccup must not kill a
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
const STALL_S = 1.0;             // pulse silence -> stalled
const TICK_MEMORY = 16;          // recorded grid times (steps)

export interface SyncSlaveOptions {
  /** The BPM knob's bus value — the restore target when the role ends. */
  localBpm: () => number;
  /** performance.now()-domain ms -> AudioContext seconds. */
  toAudioTime: (perfMs: number) => number;
}

export class SyncSlave {
  private readonly estimator = new PulseBpmEstimator({
    windowPulses: WINDOW_PULSES, emaAlpha: EMA_ALPHA, gapResetMs: GAP_RESET_MS,
  });
  private unsubs: Array<() => void> = [];
  private readonly changeListeners = new Set<() => void>();

  /** Recent local grid times, newest last (even steps only — never swung). */
  private tickTimes: Array<{ step: number; when: number }> = [];
  private pulseCount = 0;
  private lastPulseAudioT: number | null = null;
  private lastWriteMs = -Infinity;
  private lastWrittenBpm: number | null = null;
  private phaseErr: number | null = null;
  private pulsesSinceNudge = 0;
  private _stalled = false;

  constructor(private readonly clock: Clock, private readonly opts: SyncSlaveOptions) {}

  enable(): void {
    if (this.unsubs.length) return;
    this.unsubs.push(this.clock.onTick(this.onTick));
  }

  /** Ends the role: local tempo comes back; a playing clock keeps playing. */
  disable(): void {
    if (!this.unsubs.length) return;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.clock.setBpm(this.opts.localBpm());
    this.resetFollowState();
    this.estimator.reset();
    this._stalled = false;
  }

  handleMessage(msg: SyncMessage, receivedAtMs: number): void {
    switch (msg.type) {
      case 'start':
      case 'continue': // v1: no song position — continue realigns like start
        if (this.clock.playing) this.clock.stop();
        this.resetFollowState();
        this.clock.start();
        this.emitChange();
        break;
      case 'stop':
        this.clock.stop();
        this.setStalled(false);
        this.emitChange();
        break;
      case 'pulse':
        this.onPulse(receivedAtMs);
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

  private onPulse(receivedAtMs: number): void {
    // The estimator is always fed — even while stopped — so hardware masters
    // that send continuous clock warm the tempo before the first start (REQ-4).
    this.estimator.addPulse(receivedAtMs);
    this.lastPulseAudioT = this.opts.toAudioTime(receivedAtMs);
    this.setStalled(false);
    this.maybeWriteBpm(receivedAtMs);
    if (this.clock.playing) this.trackPhase(this.pulseCount++, receivedAtMs);
  }

  private maybeWriteBpm(nowMs: number): void {
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
   * Phase correction. Pulses are numbered from 'start' (pulse 0 = step 0), so
   * every 12th pulse lands on an even step whose unswung grid time we have
   * recorded from our own onTick (the look-ahead means the tick has always
   * fired by the time its pulse arrives). Error = arrival − local grid time;
   * positive = master runs late relative to us, so future steps shift later.
   */
  private trackPhase(pulse: number, receivedAtMs: number): void {
    this.pulsesSinceNudge++;
    if (pulse % 12 !== 0) return;
    const step = (pulse / 6) & 0xffff;
    const rec = this.tickTimes.find((t) => t.step === step);
    if (!rec) return;
    const err = this.opts.toAudioTime(receivedAtMs) - rec.when;
    this.phaseErr = this.phaseErr === null ? err : this.phaseErr + PHASE_ALPHA * (err - this.phaseErr);
    if (this.pulsesSinceNudge < NUDGE_MIN_PULSES) return;
    if (Math.abs(this.phaseErr) < NUDGE_DEADBAND_S) return;
    this.clock.nudge(Math.max(-NUDGE_MAX_S, Math.min(NUDGE_MAX_S, this.phaseErr)));
    this.pulsesSinceNudge = 0;
    this.phaseErr = null; // pre-nudge measurements are stale now
  }

  private onTick = (step: number, when: number): void => {
    if ((step & 1) === 0) {
      this.tickTimes.push({ step, when });
      if (this.tickTimes.length > TICK_MEMORY) this.tickTimes.shift();
    }
    // Stall check rides the tick (fires every 16th while playing — no extra
    // timer). `when` is look-ahead time, close enough for a 1 s threshold.
    if (this.lastPulseAudioT !== null && when - this.lastPulseAudioT > STALL_S) {
      this.setStalled(true);
    }
  };

  private resetFollowState(): void {
    this.tickTimes = [];
    this.pulseCount = 0;
    this.phaseErr = null;
    this.pulsesSinceNudge = 0;
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
