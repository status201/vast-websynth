import type { Clock } from '../clock';
import type { SyncMessage, SyncStatus, SyncTransport, SyncMode, TransportId } from './sync-types';
import { readSyncMode, writeSyncMode } from '../../../state/sync-mode';
import { type TickTimer, TimeoutTimer } from '../tick-timer';
import { SyncMaster } from './sync-master';
import { SyncSlave } from './sync-slave';

/**
 * Owns the sync mode (off | master | slave) and the role lifecycle. This is
 * the single gate (REQ-7): incoming messages are dropped unless slaved, and
 * broadcasting exists only while mastered — so two cross-wired instances can
 * never feed back, and Android USB loopback is ignored.
 *
 * v2: **multi-transport** (midi-clock-sync REQ-15). `addTransport(id, t)` keeps
 * a `Map` keyed by `TransportId` (MIDI + WiFi coexist; a same-id add replaces).
 * Broadcasting fans out to every transport; incoming from any is gated the same
 * way. When a transport's outputs go 0 → >0 while master, the controller
 * announces the current transport state to **that transport only** (a broadcast
 * would restart already-locked slaves at bar 0 — REQ-10). Until any transport
 * is added, mode switching works but is inert and `status.links` is empty.
 *
 * v4: **selection vs. running role** (REQ-19..21). `mode` is the persisted
 * *preference*; `activeMode` is what actually runs, and it needs a live link —
 * pull the cable or close the DataChannel and a slave releases the transport
 * instead of freezing the BPM knob at a vanished master's tempo. Ports alone
 * are too weak a signal (a virtual MIDI cable outlives the app behind it), so a
 * slave also needs a message within `LINK_IDLE_MS`, watchdog-polled. Incoming
 * messages stay gated on the *selection* — receiving one is what re-arms the
 * role, so gating them on `activeMode` would deadlock.
 */

/** No sync message for this long ⇒ the slave's link is dead (REQ-20). Well past
 *  the master's 100 ms idle pulses and 2 s tempo heartbeat (REQ-11/12). */
const LINK_IDLE_MS = 3000;
/** Liveness poll cadence while `mode === 'slave'`. */
const WATCHDOG_WAKE_MS = 500;

interface TransportEntry {
  t: SyncTransport;
  unsubs: Array<() => void>;
  lastOuts: number;
}

export interface SyncControllerOptions {
  /** AudioContext seconds -> performance.now()-domain ms. */
  toPerfMs: (audioTime: number) => number;
  /** performance.now()-domain ms -> AudioContext seconds. */
  toAudioTime: (perfMs: number) => number;
  /** The BPM knob's bus value — the slave's restore target. */
  localBpm: () => number;
  /**
   * v4 (REQ-21): write the BPM knob. Used once, when the link drops *while
   * playing*, to adopt the followed tempo so the handoff is jump-free and the
   * knob tells the truth. Omitted in tests that don't exercise the handoff.
   */
  setLocalBpm?: (bpm: number) => void;
  /** The song's time signature, announced to peers (meter.md REQ-18). */
  meter?: () => { beats: number; unit: number };
  /** Adopt a peer's time signature while slaved (meter.md REQ-18). */
  setMeter?: (beats: number, unit: number) => void;
  /** Read/write `websynth.midisync` (default true; tests pass false). */
  persist?: boolean;
  /** performance.now() (injectable for tests). */
  nowMs?: () => number;
  /**
   * Link-liveness poll source. A main-thread `TimeoutTimer` by default: this
   * only decides when to *release* a dead link, so sub-second precision and
   * background-tab throttling are both irrelevant — no second Worker.
   */
  watchdogTimer?: TickTimer;
}

export class SyncController {
  private _mode: SyncMode;
  private _activeMode: SyncMode = 'off';
  private readonly transports = new Map<TransportId, TransportEntry>();
  private master: SyncMaster | null = null;
  private slave: SyncSlave | null = null;
  private slaveUnsub: (() => void) | null = null;
  private readonly statusListeners = new Set<(s: SyncStatus) => void>();
  private readonly persist: boolean;
  private readonly nowMs: () => number;
  private readonly watchdog: TickTimer;
  private lastMessageAtMs = -Infinity;

  constructor(private readonly clock: Clock, private readonly opts: SyncControllerOptions) {
    this.persist = opts.persist ?? true;
    this.nowMs = opts.nowMs ?? (() => performance.now());
    this.watchdog = opts.watchdogTimer ?? new TimeoutTimer();
    this._mode = this.persist ? readSyncMode() : 'off';
    this.applyActiveRole();
    this.syncWatchdog();
    // Play-state is part of the status line; repaint on transport edges. Both
    // edges also re-derive the role: `clock.playing` defers a silence-based
    // release (REQ-6/REQ-20), so stopping frees a stalled slave at once
    // instead of leaving it latched until the next watchdog wake.
    clock.onStart(() => { this.applyActiveRole(); this.emitStatus(); });
    clock.onStop(() => { this.applyActiveRole(); this.emitStatus(); });
  }

  /** The persisted *selection* — remembered across disconnects and reloads. */
  get mode(): SyncMode {
    return this._mode;
  }

  /**
   * The role **actually running** (REQ-19): `'off'` whenever the selection is
   * armed but nothing is connected. Every "are we slaved?" gate reads this.
   */
  get activeMode(): SyncMode {
    return this._activeMode;
  }

  setMode(m: SyncMode): void {
    if (m === this._mode) return;
    this._mode = m;
    // Explicit: a deliberate exit snaps the tempo back to the knob (REQ-4),
    // unlike an automatic release, which adopts the followed tempo (REQ-21).
    this.applyActiveRole(true);
    this.syncWatchdog();
    if (this.persist) writeSyncMode(m);
    this.emitStatus();
  }

  /**
   * Add (or replace) a transport under `id`. Late-called: `initMIDI` adds
   * `'midi'` post-gesture, `Engine.init` adds `'wifi'`. Replacing an id
   * unsubscribes the old wire first.
   */
  addTransport(id: TransportId, t: SyncTransport): void {
    const prev = this.transports.get(id);
    if (prev) for (const u of prev.unsubs) u();
    const entry: TransportEntry = { t, unsubs: [], lastOuts: t.ports().outs };
    entry.unsubs.push(
      t.onMessage((msg, at) => this.onIncoming(msg, at)),
      t.onPortsChange(() => this.onPortsChange(id)),
    );
    this.transports.set(id, entry);
    this.applyActiveRole(); // a late-added wire can arm the selected role
    this.emitStatus();
  }

  get status(): SyncStatus {
    return {
      mode: this._mode,
      activeMode: this._activeMode,
      links: [...this.transports.entries()].map(([id, e]) => {
        const p = e.t.ports();
        return { id, ins: p.ins, outs: p.outs };
      }),
      playing: this.clock.playing,
      followedBpm: this.slave ? this.slave.followedBpm : null,
      stalled: this.slave ? this.slave.stalled : false,
    };
  }

  onStatus(cb: (s: SyncStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => { this.statusListeners.delete(cb); };
  }

  private broadcast(msg: SyncMessage, atMs?: number): void {
    for (const { t } of this.transports.values()) t.send(msg, atMs);
  }

  /**
   * Tell every peer where the playhead now is (REQ-23). Called after a **local**
   * seek: slaves count pulses from their own start, so without this they stay
   * exactly the jump distance behind for the rest of the session.
   *
   * `announceTo` sends `songposition` + `continue` — deliberately not `start`,
   * which REQ-3 makes a slave honour by restarting at bar 0, the one thing a
   * mid-song jump must not do. A no-op in any role but a running master.
   */
  announcePosition(): void {
    if (this._activeMode !== 'master') return;
    this.master?.announceTo((msg, atMs) => this.broadcast(msg, atMs));
  }

  /**
   * Tell every peer the time signature changed (meter.md REQ-18). Without it a
   * peer keeps numbering bars by whatever meter it joined with, so the same
   * Song Position lands them on different bars. A no-op in any role but master.
   */
  announceMeter(): void {
    if (this._activeMode !== 'master') return;
    this.master?.announceMeter();
  }

  /**
   * The gate stays on the **selection** (REQ-7/REQ-20), never on `activeMode`:
   * an arriving message is exactly what proves the link is alive, so it re-arms
   * the role — and it must do so *before* being handled, or the freshly-built
   * slave would miss the very message that woke it.
   */
  private onIncoming(msg: SyncMessage, receivedAtMs: number): void {
    if (this._mode !== 'slave') return;
    this.lastMessageAtMs = this.nowMs();
    if (this.applyActiveRole()) this.emitStatus();
    this.slave?.handleMessage(msg, receivedAtMs);
  }

  /**
   * A transport's port counts changed — which may arm or release the role
   * (REQ-20). If its outputs came up (0 → >0) while we are master, announce the
   * current state to *that transport only* so a newly-linked peer joins in
   * phase without restarting the others (REQ-10/15).
   */
  private onPortsChange(id: TransportId): void {
    const entry = this.transports.get(id);
    // A role that just activated already announced to everyone via
    // `SyncMaster.enable()`; a second targeted announce would double the join.
    const activated = this.applyActiveRole();
    if (entry) {
      const outs = entry.t.ports().outs;
      const wasZero = entry.lastOuts === 0;
      entry.lastOuts = outs;
      if (!activated && this._activeMode === 'master' && this.master && wasZero && outs > 0) {
        this.master.announceTo((msg, atMs) => entry.t.send(msg, atMs));
      }
    }
    this.emitStatus();
  }

  /**
   * The role a live link currently supports (REQ-19/20). A selected mode with
   * nothing connected resolves to `'off'` — armed, but inert.
   */
  private desiredActiveRole(): SyncMode {
    if (this._mode === 'off') return 'off';
    const ports = [...this.transports.values()].map((e) => e.t.ports());
    if (this._mode === 'master') return ports.some((p) => p.outs > 0) ? 'master' : 'off';
    if (!ports.some((p) => p.ins > 0)) return 'off';
    // Ports alone are too weak: a virtual MIDI cable (loopMIDI) outlives the
    // app behind it. Demand recent traffic too — except while playing, where
    // REQ-6's stall tolerance owns the silence (a hiccup must never yank a
    // running performance's tempo); the release then lands on the next stop.
    if (this.clock.playing) return 'slave';
    return this.nowMs() - this.lastMessageAtMs < LINK_IDLE_MS ? 'slave' : 'off';
  }

  /**
   * Re-derive and apply the running role. Idempotent — safe to call from every
   * edge (mode change, port change, transport add, clock start/stop, watchdog).
   * Returns whether the role actually changed.
   *
   * `explicit` marks a deliberate `setMode` change, which keeps REQ-4's
   * snap-back to the knob tempo. An *automatic* release while playing instead
   * adopts the followed tempo (REQ-21).
   */
  private applyActiveRole(explicit = false): boolean {
    const want = this.desiredActiveRole();
    if (want === this._activeMode) return false;

    if (this.slave && !explicit && this.clock.playing) {
      // Hand the tempo over without a jump: writing the followed BPM to the
      // knob first makes `SyncSlave.disable()`'s restore a no-op, and leaves
      // the knob showing what is actually playing.
      this.opts.setLocalBpm?.(this.currentBpm());
    }
    this.master?.disable();
    this.master = null;
    this.slave?.disable(); // restores clock.setBpm(localBpm())
    this.slaveUnsub?.();
    this.slave = null;
    this.slaveUnsub = null;
    this._activeMode = want;

    if (want === 'master') {
      this.master = new SyncMaster(
        this.clock,
        (msg, atMs) => this.broadcast(msg, atMs),
        this.opts.toPerfMs,
        // Fan the start/stop flush out to every transport that can cancel
        // scheduled sends (REQ-18); transports without flush are untouched.
        {
          flush: () => { for (const { t } of this.transports.values()) t.flush?.(); },
          ...(this.opts.meter ? { meter: this.opts.meter } : {}),
        },
      );
      this.master.enable();
    } else if (want === 'slave') {
      this.slave = new SyncSlave(this.clock, {
        localBpm: this.opts.localBpm,
        toAudioTime: this.opts.toAudioTime,
        ...(this.opts.setMeter ? { setMeter: this.opts.setMeter } : {}),
      });
      this.slave.enable();
      this.slaveUnsub = this.slave.onChange(() => this.emitStatus());
    }
    return true;
  }

  /** The clock's tempo, in BPM (`SyncMaster.currentBpm`'s formula). */
  private currentBpm(): number {
    return 15 / this.clock.sixteenthDuration();
  }

  /** The liveness poll only needs to run while a slave link can go stale. */
  private syncWatchdog(): void {
    if (this._mode === 'slave') {
      this.watchdog.start(() => {
        if (this.applyActiveRole()) this.emitStatus();
      }, WATCHDOG_WAKE_MS);
    } else {
      this.watchdog.stop();
    }
  }

  private emitStatus(): void {
    const s = this.status;
    for (const l of this.statusListeners) l(s);
  }
}
