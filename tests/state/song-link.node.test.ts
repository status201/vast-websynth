// @vitest-environment node
//
// Node has real Compression Streams, so this suite pins the deflate-raw
// payload path (jsdom only reaches the 'j:' fallback).
import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { encodeSongPayload, decodeSongPayload } from '../../src/state/song-link';
import { hasCompression, inflateRaw, InflateLimitError } from '../../src/utils/compression';
import { MAX_SONG_JSON_BYTES } from '../../src/state/limits';

describe('song-link payloads (node → real deflate)', () => {
  it('node has Compression Streams', () => {
    expect(hasCompression()).toBe(true);
  });

  it('round-trips JSON through deflate-raw + base64url', async () => {
    const json = JSON.stringify({
      format: 'websynth-song-author', version: 1, name: 'Ünïcödé ✨',
      seq: [['A2', null, 'C3']], drums: [{ kick: [0, 4, 8, 12] }],
    });
    const payload = await encodeSongPayload(json);
    expect(payload.startsWith('j:')).toBe(false);
    expect(payload).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(await decodeSongPayload(payload)).toBe(json);
  });

  it('compression actually shrinks a repetitive song payload', async () => {
    const json = JSON.stringify({ steps: Array(500).fill({ on: false, note: 60 }) });
    const payload = await encodeSongPayload(json);
    expect(payload.length).toBeLessThan(json.length / 4);
  });

  it('decodes the j: fallback form too (cross-environment links)', async () => {
    const json = '{"a":1}';
    const b64 = Buffer.from(json, 'utf8').toString('base64url');
    expect(await decodeSongPayload('j:' + b64)).toBe(json);
  });

  it('rejects a corrupted deflate payload', async () => {
    await expect(decodeSongPayload('AAAAAAAA')).rejects.toThrow();
  });
});

// untrusted-input.md REQ-2 / song-share-link.md REQ-8. deflate tops out around
// 1032:1, so an address-bar-sized hash can inflate to gigabytes — and the cap is
// only a cap if it fires DURING the read, before the memory is spent.
describe('song-link payload cap (deflate bomb)', () => {
  it('refuses a payload that inflates past MAX_SONG_JSON_BYTES', async () => {
    // A run of zeros: ~9 MB in, a few KB of base64url out — a share link.
    const bomb = new Uint8Array(MAX_SONG_JSON_BYTES + 1024);
    const payload = Buffer.from(deflateRawSync(bomb)).toString('base64url');
    expect(payload.length).toBeLessThan(64 * 1024); // it really does fit in a URL
    await expect(decodeSongPayload(payload)).rejects.toThrow(/limit/i);
  });

  it('refuses an oversized uncompressed j: payload too', async () => {
    const big = 'x'.repeat(MAX_SONG_JSON_BYTES + 1);
    const b64 = Buffer.from(big, 'utf8').toString('base64url');
    await expect(decodeSongPayload('j:' + b64)).rejects.toThrow(/limit/i);
  });

  it('still decodes a payload just under the cap (boundary)', async () => {
    const json = JSON.stringify({ pad: 'y'.repeat(1024) });
    expect(await decodeSongPayload(await encodeSongPayload(json))).toBe(json);
  });
});

describe('inflateRaw cap', () => {
  it('throws InflateLimitError and keeps nothing', async () => {
    const compressed = new Uint8Array(deflateRawSync(new Uint8Array(1_000_000)));
    await expect(inflateRaw(compressed, 1024)).rejects.toBeInstanceOf(InflateLimitError);
  });

  it('passes data through untouched when it fits', async () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    const compressed = new Uint8Array(deflateRawSync(raw));
    expect(await inflateRaw(compressed, 1024)).toEqual(raw);
  });
});
