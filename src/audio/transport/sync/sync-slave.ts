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
 * - 'pulse' (24 PPQN) feeds tempo estimation and phase correction. After a
 *   (re)start, pulses are ignored for a settle window (REQ-16): a
 *   scheduled-send transport (Web MIDI) can reorder, so a stale in-flight
 *   tail may trail the start/continue; the first post-settle pulse re-anchors
 *   the counter from arrival time.
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
 * at most once per beat. An error past ~a pulse interval means the numbering
 * is skewed (reordered/stale/lost pulses) — the counter re-anchors from
 * arrival time instead of chasing it (REQ-17).
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
const REANCHOR_RATIO = 0.75;     // |phaseErr| beyond this × pulse interval -> re-anchor
const REANCHOR_MIN_S = 0.015;    // re-anchor floor so delivery-jitter spikes can't trigger it
const PHASE_MISS_REANCHOR = 2;   // consecutive unmeasurable pulses -> re-anchor
const START_SETTLE_BASE_MS = 300; // + 12 pulse intervals: post-(re)start pulse-ignore span (REQ-16)
const STALL_S = 1.0;             // pulse silence -> stalled
const TICK_MEMORY = 16;          // recorded grid times (steps)
const TEMPO_MSG_FRESH_MS = 2500; // while a 'tempo' msg is this fresh, suppress pulse-estimate writes
const TEMPO_WRITE_MIN_DELTA = 0.05; // ignore a 'tempo' within this of the last written BPM

export interface SyncSlaveOptions {
  /** The BPM knob's bus value — the restore target when the role ends. */
  localBpm: () => number;
  /** performance.now()-domain ms -> AudioContext seconds. */
  toAudioTime: (perfMs: number) => number;
  /**
   * Adopt the master's time signature (meter.md REQ-18). Injected rather than
   * writing the bus here: the meter is two `ParamBus` scalars, and the audio
   * layer reaching for the bus would invert the dependency the whole app is
   * built on (architecture REQ-1). Omitted in tests that don't exercise it.
   */
  setMeter?: (beats: number, unit: number) => void;
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
  private phaseMisses = 0;
  private pulsesSinceNudge = 0;
  private settleUntilMs = -Infinity; // pulses before this are a reordered in-flight tail
  private needsAnchor = false;       // first post-settle pulse derives the counter from time
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
        this.restart(0, receivedAtMs);
        break;
      case 'continue':
        this.restart(this.pendingBeat, receivedAtMs);
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
  private restart(fromStep: number, atMs: number): void {
    if (this.clock.playing) this.clock.stop();
    this.resetFollowState(fromStep);
    // Scheduled-send transports reorder: pulses already queued with future
    // timestamps arrive *after* this message. Ignore the whole possible
    // in-flight span (idle horizon / look-ahead + one 12-pulse batch, in
    // current-tempo terms) rather than trying to tell streams apart —
    // burst-jitter makes per-pulse filtering unreliable (REQ-16). The first
    // pulse after the settle re-anchors the counter (REQ-17).
    this.settleUntilMs = atMs + START_SETTLE_BASE_MS + 2000 * this.clock.sixteenthDuration();
    this.needsAnchor = true;
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
    // Stall bookkeeping always runs — a settling pulse still proves the wire
    // is alive.
    this.lastPulseAudioT = this.opts.toAudioTime(receivedAtMs);
    this.setStalled(false);
    // Post-(re)start settle (REQ-16): a reordered stale tail may trail the
    // start/continue — drop the whole span so it can neither spike the
    // estimator nor skew the pulse counter.
    if (this.clock.playing && receivedAtMs < this.settleUntilMs) return;
    // The estimator is fed otherwise — even while stopped — so hardware
    // masters that send continuous clock warm the tempo before the first
    // start (REQ-4).
    this.estimator.addPulse(receivedAtMs);
    this.maybeWriteBpm(receivedAtMs);
    if (!this.clock.playing) return;
    if (this.needsAnchor) {
      // An unknown number of run pulses fell inside the settle — derive the
      // counter from arrival time before measuring anything (REQ-17).
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
   * Re-anchor (midi-clock-sync REQ-17): a healthy corrector never sees errors
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
      // large to even measure. Re-anchor instead of going silent (REQ-17).
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
    // The clock's step counter no longer wraps (transport.md REQ-10), so a
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
    this.startStep = Math.max(0, Math.floor(startStep));
    this.tickTimes = [];
    this.pulseCount = 0;
    this.phaseErr = null;
    this.phaseMisses = 0;
    this.pulsesSinceNudge = 0;
    this.settleUntilMs = -Infinity;
    this.needsAnchor = false;
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
