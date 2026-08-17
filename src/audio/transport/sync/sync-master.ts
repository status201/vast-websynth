import type { Clock } from '../clock';
import type { SyncMessage } from './sync-types';
import { type TickTimer, defaultTickTimer } from '../tick-timer';

/**
 * Master role: mirror the local transport onto a `SyncTransport`.
 *
 * Hooks `clock.onStart`/`onStop`/`onTick`, so *any* local start/stop (Play
 * button, arp auto-start, recorder, panic) broadcasts — the role is
 * transport-source-agnostic by construction.
 *
 * Pulses: MIDI clock is 24 PPQN = 6 pulses per 16th, but `onTick`'s `when`
 * includes the swing offset on odd 16ths and MIDI clock is *straight*
 * (hardware convention: the slave applies its own shuffle). So we act on
 * **even ticks only** — never swung — and emit 12 pulses spanning two 16ths
 * from the unswung grid time, converted to the performance.now() domain via
 * the injected `toPerfMs` so `MIDIOutput.send(data, timestamp)` fires them
 * with hardware timing.
 *
 * v2 additions (midi-clock-sync REQ-10/11/12):
 * - `announceTo(send)` — a targeted "join here" for a newly-opened transport:
 *   `tempo`, plus `songposition` + `continue` while playing (never a bare
 *   `start`, which would restart already-locked slaves at bar 0).
 * - **Explicit tempo** — emitted on enable, every start, on even ticks when the
 *   BPM moved (Tape Stop, knob), and as a 2 s idle heartbeat. Carries tempo the
 *   MIDI transport can't (it drops `tempo` — MIDI implies tempo in pulse
 *   spacing) and lets a WiFi slave lock instantly.
 * - **Idle clock** — while enabled and stopped, an injected `TickTimer` keeps
 *   emitting timestamped pulses so slaves' estimates stay warm before Start.
 */

const IDLE_WAKE_MS = 100;          // idle timer wakeup cadence while stopped
const IDLE_HORIZON_MS = 200;       // schedule idle pulses covering up to now + this
const TEMPO_HEARTBEAT_MS = 2000;   // idle 'tempo' emission spacing
const TEMPO_SEND_MIN_DELTA = 0.1;  // emit 'tempo' on even ticks when |bpm - lastSent| >= this
const SONG_POSITION_MASK = 0x3fff; // 14-bit MIDI beat

export interface SyncMasterOptions {
  /** Idle-clock wakeup source; defaults to a Worker timer (test double injected). */
  timer?: TickTimer;
  /** performance.now() (injectable for tests). */
  nowMs?: () => number;
  /** Best-effort cancel of scheduled-but-unsent messages (REQ-18): called
   *  before the start/stop sends so a stale queued pulse tail cannot trail
   *  them on a scheduled-send transport (Web MIDI). */
  flush?: () => void;
  /** The song's time signature, for the `meter` announce (meter.md REQ-18).
   *  Omitted in tests that don't exercise it — the announce is then skipped
   *  rather than sending a fabricated 4/4 over a peer's real 7/8. */
  meter?: () => { beats: number; unit: number };
}

export class SyncMaster {
  private unsubs: Array<() => void> = [];
  private readonly timer: TickTimer;
  private readonly nowMs: () => number;
  private readonly flush: (() => void) | undefined;

  private readonly readMeter: (() => { beats: number; unit: number }) | undefined;

  private lastSentBpm: number | null = null;
  private idleRunning = false;
  private idleLastScheduledMs = 0;
  private lastHeartbeatMs = 0;

  constructor(
    private readonly clock: Clock,
    private readonly send: (msg: SyncMessage, atMs?: number) => void,
    private readonly toPerfMs: (audioTime: number) => number,
    opts?: SyncMasterOptions,
  ) {
    this.timer = opts?.timer ?? defaultTickTimer();
    this.nowMs = opts?.nowMs ?? (() => performance.now());
    this.flush = opts?.flush;
    this.readMeter = opts?.meter;
  }

  /**
   * Re-announce the time signature (meter.md REQ-18). Called when the local
   * meter changes, so a peer that is already following does not keep numbering
   * bars by the meter it joined with. A no-op while nothing can hear it.
   */
  announceMeter(): void {
    const m = this.readMeter?.();
    if (m) this.send({ type: 'meter', beats: m.beats, unit: m.unit });
  }

  enable(): void {
    if (this.unsubs.length) return;
    this.unsubs.push(
      this.clock.onStart(this.onLocalStart),
      this.clock.onStop(this.onLocalStop),
      this.clock.onTick(this.onTick),
    );
    if (this.clock.playing) {
      this.announceTo(this.send); // mid-play enable: join without restarting slaves
    } else {
      this.sendTempo();           // announce current tempo on enable
      this.startIdle();           // warm slaves with idle clock while stopped
    }
  }

  disable(): void {
    if (!this.unsubs.length) return;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.stopIdle();
    // Don't leave slaves free-running silently after the role goes away.
    if (this.clock.playing) this.send({ type: 'stop' });
  }

  /**
   * Announce the current transport state to one `send` sink — used by the
   * controller when a transport link opens mid-session so the newcomer joins
   * in phase without a bar-0 restart of the others (midi-clock-sync REQ-10/15).
   */
  announceTo(send: (msg: SyncMessage, atMs?: number) => void): void {
    const bpm = this.currentBpm();
    send({ type: 'tempo', bpm });
    this.lastSentBpm = bpm;
    // Before the position: a peer resolves `songposition` into a BAR through its
    // own bar length, so it has to know the meter first or it lands on the bar
    // its OWN meter implies (meter.md REQ-18).
    const m = this.readMeter?.();
    if (m) send({ type: 'meter', beats: m.beats, unit: m.unit });
    if (this.clock.playing) {
      send({ type: 'songposition', beat: this.clock.step & SONG_POSITION_MASK });
      send({ type: 'continue' });
    }
  }

  private onLocalStart = (): void => {
    this.stopIdle();
    this.flush?.(); // drop the queued idle-pulse tail so it can't trail 'start' (REQ-18)
    this.send({ type: 'start' }); // slaves realign to bar 0 (v1 behaviour)
    this.sendTempo();
  };

  private onLocalStop = (): void => {
    this.flush?.(); // drop the queued run-pulse tail so it can't trail 'stop' (REQ-18)
    this.send({ type: 'stop' });
    this.startIdle(); // keep warming slaves while stopped
  };

  private onTick = (step: number, when: number): void => {
    if ((step & 1) === 1) return; // odd 16ths may be swung; covered by the even tick
    const pulseS = this.clock.sixteenthDuration() / 6;
    for (let i = 0; i < 12; i++) {
      this.send({ type: 'pulse' }, this.toPerfMs(when + i * pulseS));
    }
    // Tempo moves (Tape Stop ramp, live BPM knob) ride the even-tick grid.
    const bpm = this.currentBpm();
    if (this.lastSentBpm === null || Math.abs(bpm - this.lastSentBpm) >= TEMPO_SEND_MIN_DELTA) {
      this.sendTempo(bpm);
    }
  };

  private sendTempo(bpm = this.currentBpm()): void {
    this.send({ type: 'tempo', bpm });
    this.lastSentBpm = bpm;
  }

  private currentBpm(): number {
    return 15 / this.clock.sixteenthDuration(); // 60 / (16thDur * 4)
  }

  // ---- Idle clock (while enabled + stopped) ----

  private startIdle(): void {
    if (this.idleRunning) return;
    this.idleRunning = true;
    const now = this.nowMs();
    this.idleLastScheduledMs = now;
    this.lastHeartbeatMs = now;
    this.timer.start(this.idleTick, IDLE_WAKE_MS);
  }

  private stopIdle(): void {
    if (!this.idleRunning) return;
    this.idleRunning = false;
    this.timer.stop();
  }

  private idleTick = (): void => {
    const now = this.nowMs();
    const pulseMs = (this.clock.sixteenthDuration() / 6) * 1000;
    const horizon = now + IDLE_HORIZON_MS;
    let next = this.idleLastScheduledMs + pulseMs;
    // Fell behind (tab throttling) — resync to now rather than spew a backlog.
    if (next < now) next = now;
    for (; next <= horizon; next += pulseMs) {
      this.send({ type: 'pulse' }, next);
      this.idleLastScheduledMs = next;
    }
    if (now - this.lastHeartbeatMs >= TEMPO_HEARTBEAT_MS) {
      this.sendTempo();
      this.lastHeartbeatMs = now;
    }
  };
}
