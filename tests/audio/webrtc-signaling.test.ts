import { describe, it, expect } from 'vitest';
import {
  encodeSignal,
  decodeSignal,
  SignalDecodeError,
} from '../../src/audio/webrtc-signaling';

const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=sctp-port:5000',
  'a=candidate:1 1 udp 2113937151 192.168.1.5 54321 typ host',
].join('\r\n');

/** Run `fn` with CompressionStream/DecompressionStream removed (jsdom-like). */
async function withoutCompression<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const cs = g.CompressionStream;
  const ds = g.DecompressionStream;
  g.CompressionStream = undefined;
  g.DecompressionStream = undefined;
  try {
    return await fn();
  } finally {
    g.CompressionStream = cs;
    g.DecompressionStream = ds;
  }
}

describe('webrtc-signaling', () => {
  it('round-trips through the deflate codec when available (c)', async () => {
    const blob = await encodeSignal('offer', SDP);
    expect(blob.startsWith('WS2.c.')).toBe(true);
    const decoded = await decodeSignal(blob);
    expect(decoded).toEqual({ kind: 'offer', sdp: SDP });
  });

  it('round-trips through the raw fallback when compression is absent (r)', async () => {
    const blob = await withoutCompression(() => encodeSignal('answer', SDP));
    expect(blob.startsWith('WS2.r.')).toBe(true);
    // Decode works with or without the compression globals (raw payload).
    const decoded = await decodeSignal(blob);
    expect(decoded).toEqual({ kind: 'answer', sdp: SDP });
  });

  it('a deflate blob still decodes where DecompressionStream exists', async () => {
    const blob = await encodeSignal('offer', SDP);
    expect(await decodeSignal(blob)).toEqual({ kind: 'offer', sdp: SDP });
  });

  it('rejects a non-WS2 blob', async () => {
    await expect(decodeSignal('hello world')).rejects.toBeInstanceOf(SignalDecodeError);
  });

  it('rejects an unknown codec', async () => {
    await expect(decodeSignal('WS2.x.YWJj')).rejects.toBeInstanceOf(SignalDecodeError);
  });

  it('rejects a corrupt payload', async () => {
    await expect(decodeSignal('WS2.r.!!!not-base64!!!')).rejects.toBeInstanceOf(SignalDecodeError);
  });

  it('rejects a well-formed blob with the wrong shape', async () => {
    // Valid base64url of raw JSON that is missing the sdp field.
    const bad = 'WS2.r.' + Buffer.from(JSON.stringify({ k: 'offer' })).toString('base64url');
    await expect(decodeSignal(bad)).rejects.toBeInstanceOf(SignalDecodeError);
  });
});
