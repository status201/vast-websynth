/**
 * Shareable song links (specs/features/song-share-link.md): a song rides the
 * URL **hash** — `#song=<payload>` embeds the song itself (deflate-raw +
 * base64url), `#songUrl=<https url>` points at a hosted song/project file.
 * Hash-based so payloads stay out of server logs and static hosts need no
 * route handling. Pure: no DOM beyond TextEncoder/TextDecoder + btoa/atob,
 * so it is unit-testable under jsdom and bundleable for Node (the MCP server
 * builds share links with node:zlib instead — same wire format).
 */
import { deflateRaw, inflateRaw, hasCompression } from '../utils/compression';
import { toBase64Url, fromBase64Url } from '../utils/base64url';

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
  if (url && /^https?:\/\//i.test(url)) return { kind: 'url', url };
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

/** Invert {@link encodeSongPayload}. Throws on an undecodable payload. */
export async function decodeSongPayload(payload: string): Promise<string> {
  if (payload.startsWith(JSON_PREFIX)) {
    return new TextDecoder().decode(fromBase64Url(payload.slice(JSON_PREFIX.length)));
  }
  if (!hasCompression()) {
    throw new Error('This browser cannot decompress the song link.');
  }
  return new TextDecoder().decode(await inflateRaw(fromBase64Url(payload)));
}

/** `<origin>/#song=<payload>` — base64url payloads never need percent-encoding. */
export function buildShareUrl(origin: string, payload: string): string {
  return `${origin}/#song=${payload}`;
}
