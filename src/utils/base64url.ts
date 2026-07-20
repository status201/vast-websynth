// URL-safe base64 (RFC 4648 §5) for binary payloads that travel in a URL hash
// or a QR blob: `+/` → `-_`, padding stripped. Shared by the song share links
// (state/song-link.ts) and the WebRTC signalling blobs (audio/webrtc-signaling.ts).

/** Keep String.fromCharCode argument counts sane (no spread on large arrays). */
const CHUNK = 0x8000;

/** Bytes → URL-safe base64, unpadded. */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL-safe base64 (padded or not) → bytes. Throws on malformed input. */
export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded); // throws on malformed input — caller surfaces it
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
