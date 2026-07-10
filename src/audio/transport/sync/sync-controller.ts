import type { Clock } from '../clock';
import type { SyncMessage, SyncStatus, SyncTransport, SyncMode, TransportId } from './sync-types';
import { readSyncMode, writeSyncMode } from '../../../state/sync-mode';
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
 */

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
  /** Read/write `websynth.midisync` (default true; tests pass false). */
  persist?: boolean;
}

export class SyncController {
  private _mode: SyncMode;
  private readonly transports = new Map<TransportId, TransportEntry>();
  private master: SyncMaster | null = null;
  private slave: SyncSlave | null = null;
  private slaveUnsub: (() => void) | null = null;
  private readonly statusListeners = new Set<(s: SyncStatus) => void>();
  private readonly persist: boolean;

  constructor(private readonly clock: Clock, private readonly opts: SyncControllerOptions) {
    this.persist = opts.persist ?? true;
    this._mode = this.persist ? readSyncMode() : 'off';
    this.applyMode();
    // Play-state is part of the status line; repaint on transport edges.
    clock.onStart(() => this.emitStatus());
    clock.onStop(() => this.emitStatus());
  }

  get mode(): SyncMode {
    return this._mode;
  }

  setMode(m: SyncMode): void {
    if (m === this._mode) return;
    this._mode = m;
    this.applyMode();
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
    this.emitStatus();
  }

  get status(): SyncStatus {
    return {
      mode: this._mode,
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

  private onIncoming(msg: SyncMessage, receivedAtMs: number): void {
    if (this._mode !== 'slave') return; // the gate
    this.slave?.handleMessage(msg, receivedAtMs);
  }

  /**
   * A transport's port counts changed. If its outputs came up (0 → >0) while
   * we are master, announce the current state to *that transport only* so a
   * newly-linked peer joins in phase without restarting the others (REQ-10/15).
   */
  private onPortsChange(id: TransportId): void {
    const entry = this.transports.get(id);
    if (entry) {
      const outs = entry.t.ports().outs;
      const wasZero = entry.lastOuts === 0;
      entry.lastOuts = outs;
      if (this._mode === 'master' && this.master && wasZero && outs > 0) {
        this.master.announceTo((msg, atMs) => entry.t.send(msg, atMs));
      }
    }
    this.emitStatus();
  }

  private applyMode(): void {
    this.master?.disable();
    this.master = null;
    this.slave?.disable(); // restores clock.setBpm(localBpm())
    this.slaveUnsub?.();
    this.slave = null;
    this.slaveUnsub = null;

    if (this._mode === 'master') {
      this.master = new SyncMaster(
        this.clock,
        (msg, atMs) => this.broadcast(msg, atMs),
        this.opts.toPerfMs,
        // Fan the start/stop flush out to every transport that can cancel
        // scheduled sends (REQ-18); transports without flush are untouched.
        { flush: () => { for (const { t } of this.transports.values()) t.flush?.(); } },
      );
      this.master.enable();
    } else if (this._mode === 'slave') {
      this.slave = new SyncSlave(this.clock, {
        localBpm: this.opts.localBpm,
        toAudioTime: this.opts.toAudioTime,
      });
      this.slave.enable();
      this.slaveUnsub = this.slave.onChange(() => this.emitStatus());
    }
  }

  private emitStatus(): void {
    const s = this.status;
    for (const l of this.statusListeners) l(s);
  }
}
