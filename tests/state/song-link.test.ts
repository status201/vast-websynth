// The 'j:' fallback path is pinned by stubbing Compression Streams away
// (newer jsdom/Vitest environments DO expose them); the real deflate
// round-trip runs in song-link.node.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseSongLink,
  encodeSongPayload,
  decodeSongPayload,
  buildShareUrl,
} from '../../src/state/song-link';
import { hasCompression } from '../../src/utils/compression';

describe('parseSongLink', () => {
  it('recognises #song= payloads', () => {
    expect(parseSongLink('#song=abc-_123')).toEqual({ kind: 'data', payload: 'abc-_123' });
    expect(parseSongLink('song=j:eyJ9')).toEqual({ kind: 'data', payload: 'j:eyJ9' });
  });

  it('recognises #songUrl= https URLs only (v3)', () => {
    expect(parseSongLink('#songUrl=https://example.com/x.websynth.json'))
      .toEqual({ kind: 'url', url: 'https://example.com/x.websynth.json' });
    expect(parseSongLink('#songUrl=HTTPS://example.com/x.json'))
      .toEqual({ kind: 'url', url: 'HTTPS://example.com/x.json' });
  });

  // untrusted-input.md REQ-7: plain http was the LAN-probe shape — a link could
  // make the visitor's browser GET their own router at page load.
  it('refuses every non-https #songUrl= scheme (v3, regression)', () => {
    for (const url of [
      'http://localhost:5173/demo.zip',
      'http://192.168.1.1/admin/reboot',
      'javascript:alert(1)',
      'ftp://example.com/x.json',
      'file:///etc/passwd',
      'data:application/json,{}',
      '//evil.example/song.json',          // protocol-relative
      ' https://example.com/x.json',       // leading space must not sneak past ^
    ]) {
      expect(parseSongLink(`#songUrl=${encodeURIComponent(url)}`), url).toBeNull();
    }
  });

  it('returns null for empty/unrelated hashes', () => {
    expect(parseSongLink('')).toBeNull();
    expect(parseSongLink('#')).toBeNull();
    expect(parseSongLink('#other=1')).toBeNull();
    expect(parseSongLink('#song=')).toBeNull();
  });
});

describe('encode/decode payload without Compression Streams (j: fallback)', () => {
  beforeEach(() => {
    vi.stubGlobal('CompressionStream', undefined);
    vi.stubGlobal('DecompressionStream', undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the stub removes Compression Streams (the path this suite pins)', () => {
    expect(hasCompression()).toBe(false);
  });

  it('round-trips JSON through the j: fallback', async () => {
    const json = JSON.stringify({ format: 'websynth-song-author', version: 1, name: 'Léon ✨' });
    const payload = await encodeSongPayload(json);
    expect(payload.startsWith('j:')).toBe(true);
    // URL-safe: no +, /, =, and nothing that needs percent-encoding.
    expect(payload.slice(2)).toMatch(/^[A-Za-z0-9\-_]*$/);
    expect(await decodeSongPayload(payload)).toBe(json);
  });

  it('round-trips a large payload (chunked conversion)', async () => {
    const json = JSON.stringify({ pad: 'x'.repeat(300_000) });
    expect(await decodeSongPayload(await encodeSongPayload(json))).toBe(json);
  });

  it('a compressed payload without Compression Streams throws a readable error', async () => {
    await expect(decodeSongPayload('3q2-7w')).rejects.toThrow(/decompress/);
  });

  it('malformed base64url rejects rather than returning garbage silently', async () => {
    await expect(decodeSongPayload('j:!!!')).rejects.toThrow();
  });
});

describe('encode/decode payload with the environment as-is', () => {
  it('a j:-prefixed payload always decodes, even where compression exists', async () => {
    const json = '{"a":1}';
    const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await decodeSongPayload('j:' + b64)).toBe(json);
  });

  it('encode → decode round-trips whichever path the platform takes', async () => {
    const json = JSON.stringify({ name: 'roundtrip', pad: 'y'.repeat(10_000) });
    expect(await decodeSongPayload(await encodeSongPayload(json))).toBe(json);
  });
});

describe('buildShareUrl', () => {
  it('appends the payload as a hash param', () => {
    expect(buildShareUrl('https://synth.example', 'j:eyJ9'))
      .toBe('https://synth.example/#song=j:eyJ9');
  });

  it('the built URL parses back to the same payload', () => {
    const url = new URL(buildShareUrl('https://synth.example', 'abc-_'));
    expect(parseSongLink(url.hash)).toEqual({ kind: 'data', payload: 'abc-_' });
  });
});
