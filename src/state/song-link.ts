/**
 * Shareable song links (specs/features/song-share-link.md): a song rides the
 * URL **hash** — `#song=<payload>` embeds the song itself (deflate-raw +
 * base64url), `#songUrl=<https url>` points at a hosted song/project file.
 * Both are untrusted (untrusted-input.md): the payload is size-capped here, and
 * the fetch is https-only, consent-gated and hardened by the boot hook in
 * `main.ts`.
 * Hash-based so payloads stay out of server logs and static hosts need no
 * route handling. Pure: no DOM beyond TextEncoder/TextDecoder + btoa/atob,
 * so it is unit-testable under jsdom and bundleable for Node (the MCP server
 * builds share links with node:zlib instead — same wire format).
 */
import { deflateRaw, inflateRaw, hasCompression } from '../utils/compression';
import { toBase64Url, fromBase64Url } from '../utils/base64url';
import { MAX_SONG_JSON_BYTES } from './limits';

export type SongLink =
  | { kind: 'data'; payload: string }
  | { kind: 'url'; url: string };

/**
 * Marker for the compression-free fallback payload (plain base64url of the
 * UTF-8 JSON). Unambiguous: base64url never contains ':'.
 */
const JSON_PREFIX = 'j:';

/** Recognise a share link in a location hash; null when the hash carries none. */
export function parseSongLink(hash: string): SongLink | null {
  if (!hash) return null;
  const qs = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const payload = qs.get('song');
  if (payload) return { kind: 'data', payload };
  const url = qs.get('songUrl');
  // `https:` ONLY (untrusted-input.md REQ-7). The original `https?` test also
  // accepted plain http, which made `#songUrl=http://192.168.1.1/…` a zero-click
  // probe of the visitor's own LAN from their browser. Everything else —
  // `javascript:`, `file://`, a protocol-relative `//host` — fails this too.
  if (url && /^https:\/\//i.test(url)) return { kind: 'url', url };
  return null;
}

/**
 * Encode song JSON into a URL-safe payload: deflate-raw → base64url, or the
 * `'j:'` + base64url(utf8) fallback where Compression Streams are missing.
 */
export async function encodeSongPayload(json: string): Promise<string> {
  const bytes = new TextEncoder().encode(json);
  if (!hasCompression()) return JSON_PREFIX + toBase64Url(bytes);
  return toBase64Url(await deflateRaw(bytes));
}

/**
 * Invert {@link encodeSongPayload}. Throws on an undecodable payload, and on one
 * that expands past `MAX_SONG_JSON_BYTES` — deflate reaches ~1032:1, so a hash
 * that fits in an address bar can otherwise inflate to gigabytes
 * (untrusted-input.md REQ-2). The uncompressed `'j:'` form is bounded by the URL
 * itself, but is checked too so both branches carry the same guarantee.
 */
export async function decodeSongPayload(payload: string): Promise<string> {
  if (payload.startsWith(JSON_PREFIX)) {
    const bytes = fromBase64Url(payload.slice(JSON_PREFIX.length));
    if (bytes.length > MAX_SONG_JSON_BYTES) {
      throw new Error(`This song link is larger than the ${MAX_SONG_JSON_BYTES} byte limit.`);
    }
    return new TextDecoder().decode(bytes);
  }
  if (!hasCompression()) {
    throw new Error('This browser cannot decompress the song link.');
  }
  return new TextDecoder().decode(
    await inflateRaw(fromBase64Url(payload), MAX_SONG_JSON_BYTES),
  );
}

/** `<origin>/#song=<payload>` — base64url payloads never need percent-encoding. */
export function buildShareUrl(origin: string, payload: string): string {
  return `${origin}/#song=${payload}`;
}
