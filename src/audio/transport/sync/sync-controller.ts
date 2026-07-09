import type { Clock } from '../clock';
import type { SyncMessage, SyncStatus, SyncTransport, SyncMode } from './sync-types';
import { readSyncMode, writeSyncMode } from '../../../state/sync-mode';
import { SyncMaster } from './sync-master';
import { SyncSlave } from './sync-slave';

/**
 * Owns the sync mode (off | master | slave) and the role lifecycle. This is
 * the single gate (REQ-7): incoming messages are dropped unless slaved, and
 * broadcasting exists only while mastered — so two cross-wired instances can
 * never feed back, and Android USB loopback is ignored.
 *
 * The controller is built by `Engine.init()` *before* any transport exists;
 * `initMIDI` attaches the `MidiSyncTransport` later (post-gesture). Until
 * then, mode switching works but is inert and `status.ports` is null (REQ-9).
 * Roles send through a closure over the current transport, so they never care
 * whether one is attached.
 */

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
  private transport: SyncTransport | null = null;
  private transportUnsubs: Array<() => void> = [];
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

  /** Late-attach the wire (initMIDI, post-gesture). Replaces any previous one. */
  attachTransport(t: SyncTransport): void {
    for (const u of this.transportUnsubs) u();
    this.transport = t;
    this.transportUnsubs = [
      t.onMessage((msg, at) => this.onIncoming(msg, at)),
      t.onPortsChange(() => this.emitStatus()),
    ];
    this.emitStatus();
  }

  get status(): SyncStatus {
    return {
      mode: this._mode,
      ports: this.transport ? this.transport.ports() : null,
      playing: this.clock.playing,
      followedBpm: this.slave ? this.slave.followedBpm : null,
      stalled: this.slave ? this.slave.stalled : false,
    };
  }

  onStatus(cb: (s: SyncStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => { this.statusListeners.delete(cb); };
  }

  private onIncoming(msg: SyncMessage, receivedAtMs: number): void {
    if (this._mode !== 'slave') return; // the gate
    this.slave?.handleMessage(msg, receivedAtMs);
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
        (msg, atMs) => this.transport?.send(msg, atMs),
        this.opts.toPerfMs,
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
