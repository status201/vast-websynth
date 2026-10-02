/**
 * Serverless WebRTC signaling codec (pure — no RTC, no DOM beyond the platform
 * text/compression/base64 globals). Turns an SDP + its kind into a compact,
 * copy-pasteable / QR-friendly blob and back (webrtc-sync.md REQ-pairing-is-serverless-and-non-trickle).
 *
 * Blob format: `WS2.<codec>.<base64url payload>`
 *   codec 'c' — payload is `deflate-raw`-compressed JSON (`CompressionStream`,
 *               feature-detected on `globalThis`; a deflated SDP is ~500–900
 *               chars, well within a scannable QR code).
 *   codec 'r' — payload is raw UTF-8 JSON (fallback where `CompressionStream`
 *               is unavailable — e.g. jsdom).
 * `decodeSignal` handles both, so a 'c' blob still decodes wherever
 * `DecompressionStream` exists. The JSON is `{ k: kind, s: sdp }`.
 */

import { hasCompression, deflateRaw, inflateRaw } from '../../../utils/compression';
import { toBase64Url, fromBase64Url } from '../../../utils/base64url';
import { MAX_SIGNAL_BYTES } from '../../../state/limits';

const PREFIX = 'WS2.';

export type SignalKind = 'offer' | 'answer';

export interface DecodedSignal {
  kind: SignalKind;
  sdp: string;
}

/** Thrown for any malformed / unparseable blob; the pair modal shows it inline. */
export class SignalDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalDecodeError';
  }
}

export async function encodeSignal(kind: SignalKind, sdp: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ k: kind, s: sdp }));
  if (hasCompression()) {
    return PREFIX + 'c.' + toBase64Url(await deflateRaw(bytes));
  }
  return PREFIX + 'r.' + toBase64Url(bytes);
}

export async function decodeSignal(blob: string): Promise<DecodedSignal> {
  if (typeof blob !== 'string' || !blob.startsWith(PREFIX)) {
    throw new SignalDecodeError('Not a sync link (missing WS2 prefix).');
  }
  const rest = blob.slice(PREFIX.length).trim();
  const dot = rest.indexOf('.');
  const codec = dot < 0 ? '' : rest.slice(0, dot);
  if (codec !== 'c' && codec !== 'r') {
    throw new SignalDecodeError('Unknown sync-link codec.');
  }
  let bytes: Uint8Array;
  try {
    const raw = fromBase64Url(rest.slice(dot + 1));
    // Capped: a blob can arrive from a scanned QR — i.e. from whoever printed
    // the code — so it is untrusted input like any other (untrusted-input.md
    // REQ-bounds-in-the-validator-sizes-in-the-codec). A real deflated SDP is ~700 bytes; the cap is orders above that.
    if (raw.length > MAX_SIGNAL_BYTES) {
      throw new SignalDecodeError('That sync link is too large to be a pairing code.');
    }
    bytes = codec === 'c' ? await inflateRaw(raw, MAX_SIGNAL_BYTES) : raw;
  } catch {
    throw new SignalDecodeError('Corrupt sync link (bad payload).');
  }
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SignalDecodeError('Corrupt sync link (bad JSON).');
  }
  const rec = obj as { k?: unknown; s?: unknown };
  if (!rec || (rec.k !== 'offer' && rec.k !== 'answer') || typeof rec.s !== 'string') {
    throw new SignalDecodeError('Corrupt sync link (unexpected shape).');
  }
  if (!looksLikeSdp(rec.s)) throw new SignalDecodeError('Corrupt sync link (not a pairing description).');
  return { kind: rec.k, sdp: rec.s };
}

/**
 * A cheap shape check before the SDP reaches `setRemoteDescription`
 * (untrusted-input.md REQ-a-pairing-sdp-is-shape-checked). The browser's parser
 * is the hardened thing; this only refuses what is plainly not an SDP, so a
 * hostile code fails here with our message instead of deep inside WebRTC. An
 * SDP opens with `v=0`, is printable ASCII in `x=` lines separated by CRLF
 * (a bare LF is tolerated: some stacks send it), and the envelope already
 * bounds its size (`MAX_SIGNAL_BYTES`).
 */
export function looksLikeSdp(sdp: string): boolean {
  if (!sdp.startsWith('v=0')) return false;
  for (const line of sdp.split('\n')) {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (l === '') continue;
    if (!/^[a-z]=[\x20-\x7e]*$/.test(l)) return false;
  }
  return true;
}

// ---- platform helpers ----
// (deflate/inflate live in utils/compression.ts — shared with the zip codec)
