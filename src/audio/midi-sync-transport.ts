import type { SyncMessage, SyncTransport } from './transport/sync/sync-types';

/**
 * Web MIDI implementation of `SyncTransport` — a dumb byte↔message mapper.
 * All timing math lives in the transport-agnostic sync core; this class only
 * turns `SyncMessage`s into MIDI bytes and back.
 *
 * Ownership: `midi.ts` is the sole owner of the shared `MIDIAccess`
 * (`onmidimessage`/`onstatechange` are single-assignment properties — a second
 * owner would silently clobber it). It *feeds* this transport: real-time bytes
 * via `handleRealtimeByte`, Song Position (0xF2) via `handleSongPosition`, port
 * changes via `refreshPorts`.
 *
 * Sending broadcasts to **every** output (no port picker in v1); `atMs` is a
 * performance.now()-domain timestamp — `MIDIOutput.send` schedules future
 * timestamps with hardware timing, and a past/omitted one sends immediately.
 * `tempo` has **no MIDI byte** (MIDI carries tempo implicitly in pulse spacing),
 * so it is dropped on the wire — the WebRTC transport carries it (webrtc-sync.md).
 */

const MSG_FOR: Record<number, SyncMessage> = {
  0xf8: { type: 'pulse' },
  0xfa: { type: 'start' },
  0xfb: { type: 'continue' },
  0xfc: { type: 'stop' },
};

export class MidiSyncTransport implements SyncTransport {
  private readonly messageListeners = new Set<(msg: SyncMessage, receivedAtMs: number) => void>();
  private readonly portListeners = new Set<() => void>();

  constructor(private readonly access: MIDIAccess) {}

  send(msg: SyncMessage, atMs?: number): void {
    const data = encode(msg);
    if (!data) return; // 'tempo' has no MIDI representation
    this.access.outputs.forEach((out) => {
      try {
        out.send(data, atMs);
      } catch {
        /* a port can disconnect between statechange events — non-fatal */
      }
    });
  }

  onMessage(cb: (msg: SyncMessage, receivedAtMs: number) => void): () => void {
    this.messageListeners.add(cb);
    return () => { this.messageListeners.delete(cb); };
  }

  /** Fed by midi.ts with any status byte >= 0xF8. Unknown ones (clock tick
   *  request 0xF9, active sensing 0xFE, reset 0xFF) are ignored. */
  handleRealtimeByte(byte: number, timeStampMs: number): void {
    const msg = MSG_FOR[byte];
    if (!msg) return;
    this.emit(msg, timeStampMs);
  }

  /** Fed by midi.ts for a 0xF2 Song Position Pointer (System Common). `beat` is
   *  the reassembled 14-bit MIDI beat (one beat = 6 clocks = one 16th). */
  handleSongPosition(beat: number, timeStampMs: number): void {
    this.emit({ type: 'songposition', beat: beat & 0x3fff }, timeStampMs);
  }

  /** Fed by midi.ts on `statechange` — port counts feed the status line. */
  refreshPorts(): void {
    for (const l of this.portListeners) l();
  }

  ports(): { ins: number; outs: number } {
    return { ins: this.access.inputs.size, outs: this.access.outputs.size };
  }

  onPortsChange(cb: () => void): () => void {
    this.portListeners.add(cb);
    return () => { this.portListeners.delete(cb); };
  }

  private emit(msg: SyncMessage, at: number): void {
    for (const l of this.messageListeners) l(msg, at);
  }
}

/** Map a message to its MIDI byte(s), or `null` when it has no MIDI form. */
function encode(msg: SyncMessage): number[] | null {
  switch (msg.type) {
    case 'tempo': return null;
    case 'songposition': return [0xf2, msg.beat & 0x7f, (msg.beat >> 7) & 0x7f];
    case 'pulse': return [0xf8];
    case 'start': return [0xfa];
    case 'continue': return [0xfb];
    case 'stop': return [0xfc];
  }
}
