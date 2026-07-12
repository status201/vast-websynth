// @vitest-environment node
//
// Node has real Compression Streams, so this suite pins the deflate-raw
// payload path (jsdom only reaches the 'j:' fallback).
import { describe, it, expect } from 'vitest';
import { encodeSongPayload, decodeSongPayload } from '../../src/state/song-link';
import { hasCompression } from '../../src/utils/compression';

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
