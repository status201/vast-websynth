import type { SyncMode } from '../../../state/sync-mode';

export type { SyncMode };

/** A transport wire identity — the controller keys its transports by this so
 *  MIDI and WiFi coexist (a same-id add replaces). See midi-clock-sync v2. */
export type TransportId = 'midi' | 'wifi';

/**
 * The transport-sync wire vocabulary — semantic MIDI System messages,
 * deliberately *not* raw bytes: all timing math (pulse generation, tempo
 * estimation, phase correction) lives in the transport-agnostic core, and a
 * transport is a dumb message↔wire mapper. The WebRTC DataChannel transport
 * (webrtc-sync.md) sends the same variants as JSON; the MIDI transport maps
 * each to a byte where one exists (`tempo` has none — MIDI carries tempo
 * implicitly in pulse spacing — so `MidiSyncTransport.send` drops it).
 */
export type SyncMessage =
  | { type: 'start' }                    // 0xFA — (re)start from step 0
  | { type: 'continue' }                 // 0xFB — resume from the last song position
  | { type: 'stop' }                     // 0xFC
  | { type: 'pulse' }                    // 0xF8, 24 PPQN
  | { type: 'tempo'; bpm: number }       // v2: explicit tempo (no MIDI byte)
  | { type: 'songposition'; beat: number }; // 0xF2 — MIDI beat = 6 clocks = one 16th

/**
 * A wire for sync messages. Timestamps on both sides are in the
 * `performance.now()` domain — exactly what `MIDIOutput.send(data, timestamp)`
 * takes and what `MIDIMessageEvent.timeStamp` delivers. A WebRTC transport
 * converts the sender's `performance.now()` into the receiver's domain (via a
 * clock-offset estimator) before invoking `onMessage`, so the sync core's math
 * is identical whichever transport delivers.
 */
export interface SyncTransport {
  /** Send a message, optionally scheduled at `atMs` (performance.now() domain). */
  send(msg: SyncMessage, atMs?: number): void;
  /**
   * Best-effort cancel of scheduled-but-unsent messages (midi-clock-sync
   * REQ-18). A transport that queues future-timestamped sends (Web MIDI)
   * implements it so the master can drop a stale pulse tail before a
   * start/stop; a transport that sends immediately (WebRTC) omits it.
   */
  flush?(): void;
  /** Subscribe to incoming messages. Returns an unsubscribe function. */
  onMessage(cb: (msg: SyncMessage, receivedAtMs: number) => void): () => void;
  ports(): { ins: number; outs: number };
  onPortsChange(cb: () => void): () => void;
}

/** Per-transport link summary for the status line. */
export interface SyncLink {
  id: TransportId;
  ins: number;
  outs: number;
}

export interface SyncStatus {
  /** The user's persisted selection — what the Sync section paints as active. */
  mode: SyncMode;
  /**
   * v4: the role **actually running** (midi-clock-sync REQ-19). `'off'` while
   * the selection is *armed* but nothing is connected, so every "are we
   * slaved?" consumer reads this instead of `mode` and a pulled cable hands
   * the tempo back.
   */
  activeMode: SyncMode;
  /**
   * One entry per added transport (v2: replaces the single `ports`). Empty when
   * no transport is added yet (no Web MIDI / permission denied and no WiFi).
   */
  links: SyncLink[];
  playing: boolean;
  /** The tempo the slave is following; null unless slaved and locked. */
  followedBpm: number | null;
  /** Slave only: playing but no pulse for over a second (free-running). */
  stalled: boolean;
}
