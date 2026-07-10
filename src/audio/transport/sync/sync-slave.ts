import type { Clock } from '../clock';
import type { SyncMessage } from './sync-types';
import { PulseBpmEstimator } from './bpm-estimator';

/**
 * Slave role: follow a remote transport arriving as `SyncMessage`s.
 *
 * - 'start' (re)starts the local clock **from step 0** — a restart even if
 *   already playing, so bars realign (REQ-3). 'songposition' records a pending
 *   beat and 'continue' starts **from that beat** (REQ-10) — a slave joining
 *   mid-song lands on the right bar instead of restarting at 0.
 * - 'stop' stops it.
 * - 'pulse' (24 PPQN) feeds tempo estimation and phase correction.
 * - 'tempo' (v2) sets the clock BPM explicitly; while a tempo message is fresh
 *   the pulse-estimate write path is suppressed (an explicit-tempo WiFi master
 *   wins), falling back to pulse estimation automatically when tempo messages
 *   stop (a MIDI-only master, which never sends 'tempo').
 *
 * Tempo is written via `clock.setBpm()` directly, never the bus (REQ-4): the
 * bus clamps 40..240, bus writes get baked into saved songs, and the
 * `transport.bpm` subscription would loop. Phase drift is corrected with
 * bounded `clock.nudge()` calls (REQ-5) — the local grid's tick times are
 * recorded per step, each 12th pulse is matched to its step's grid time
 * (offset by the join `startStep`), and the EMA-smoothed error is nudged away
 * at most once per beat.
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
const TEMPO_MSG_FRESH_MS = 2500; // while a 'tempo' msg is this fresh, suppress pulse-estimate writes
const TEMPO_WRITE_MIN_DELTA = 0.05; // ignore a 'tempo' within this of the last written BPM

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
  private startStep = 0;           // the step the current run started on (Song-Position join)
  private pendingBeat = 0;         // last 'songposition' — the step 'continue' will start from
  private lastPulseAudioT: number | null = null;
  private lastWriteMs = -Infinity;
  private lastWrittenBpm: number | null = null;
  private lastTempoMsgAtMs = -Infinity;
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
    this.lastTempoMsgAtMs = -Infinity;
  }

  handleMessage(msg: SyncMessage, receivedAtMs: number): void {
    switch (msg.type) {
      case 'start':
        this.pendingBeat = 0;
        this.restart(0);
        break;
      case 'continue':
        this.restart(this.pendingBeat);
        break;
      case 'songposition':
        this.pendingBeat = msg.beat & 0xffff;
        break;
      case 'stop':
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

  /** (Re)start the local clock from `fromStep`; the clock seeds its step before
   *  onStart so the Arrangement seeks to the right bar (midi-clock-sync REQ-10). */
  private restart(fromStep: number): void {
    if (this.clock.playing) this.clock.stop();
    this.resetFollowState(fromStep);
    this.clock.start(fromStep);
    this.emitChange();
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
    // The estimator is always fed — even while stopped — so hardware masters
    // that send continuous clock warm the tempo before the first start (REQ-4).
    this.estimator.addPulse(receivedAtMs);
    this.lastPulseAudioT = this.opts.toAudioTime(receivedAtMs);
    this.setStalled(false);
    this.maybeWriteBpm(receivedAtMs);
    if (this.clock.playing) this.trackPhase(this.pulseCount++, receivedAtMs);
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
   */
  private trackPhase(pulse: number, receivedAtMs: number): void {
    this.pulsesSinceNudge++;
    if (pulse % 12 !== 0) return;
    const step = (this.startStep + pulse / 6) & 0xffff;
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

  private resetFollowState(startStep = 0): void {
    this.startStep = startStep & 0xffff;
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
