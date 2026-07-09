import type { SyncMode } from '../../../state/sync-mode';

export type { SyncMode };

/**
 * The transport-sync wire vocabulary — semantic MIDI System Real-Time
 * messages, deliberately *not* raw bytes: all timing math (pulse generation,
 * tempo estimation, phase correction) lives in the transport-agnostic core,
 * and a transport is a dumb message↔wire mapper. A future WebRTC DataChannel
 * transport sends the same four variants as JSON (24 PPQN at 240 BPM is
 * 96 msgs/s — trivial for a DataChannel).
 */
export type SyncMessage =
  | { type: 'start' }     // 0xFA
  | { type: 'continue' }  // 0xFB — v1: treated as start (no song-position support)
  | { type: 'stop' }      // 0xFC
  | { type: 'pulse' };    // 0xF8, 24 PPQN

/**
 * A wire for sync messages. Timestamps on both sides are in the
 * `performance.now()` domain — exactly what `MIDIOutput.send(data, timestamp)`
 * takes and what `MIDIMessageEvent.timeStamp` delivers.
 */
export interface SyncTransport {
  /** Send a message, optionally scheduled at `atMs` (performance.now() domain). */
  send(msg: SyncMessage, atMs?: number): void;
  /** Subscribe to incoming messages. Returns an unsubscribe function. */
  onMessage(cb: (msg: SyncMessage, receivedAtMs: number) => void): () => void;
  ports(): { ins: number; outs: number };
  onPortsChange(cb: () => void): () => void;
}

export interface SyncStatus {
  mode: SyncMode;
  /** null = no transport attached (no Web MIDI / permission denied). */
  ports: { ins: number; outs: number } | null;
  playing: boolean;
  /** The tempo the slave is following; null unless slaved and locked. */
  followedBpm: number | null;
  /** Slave only: playing but no pulse for over a second (free-running). */
  stalled: boolean;
}
