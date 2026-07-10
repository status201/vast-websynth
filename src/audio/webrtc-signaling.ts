/**
 * Serverless WebRTC signaling codec (pure — no RTC, no DOM beyond the platform
 * text/compression/base64 globals). Turns an SDP + its kind into a compact,
 * copy-pasteable / QR-friendly blob and back (webrtc-sync.md REQ-5).
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
    return PREFIX + 'c.' + base64urlEncode(await deflate(bytes));
  }
  return PREFIX + 'r.' + base64urlEncode(bytes);
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
    const raw = base64urlDecode(rest.slice(dot + 1));
    bytes = codec === 'c' ? await inflate(raw) : raw;
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
  return { kind: rec.k, sdp: rec.s };
}

// ---- platform helpers ----

interface CompressionCtor { new (format: string): GenericTransformStream }

function hasCompression(): boolean {
  return typeof (globalThis as { CompressionStream?: unknown }).CompressionStream !== 'undefined'
    && typeof (globalThis as { DecompressionStream?: unknown }).DecompressionStream !== 'undefined';
}

function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as unknown as { CompressionStream: CompressionCtor }).CompressionStream;
  return streamThrough(new Ctor('deflate-raw'), bytes);
}

function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as unknown as { DecompressionStream: CompressionCtor }).DecompressionStream;
  return streamThrough(new Ctor('deflate-raw'), bytes);
}

async function streamThrough(transform: GenericTransformStream, bytes: Uint8Array): Promise<Uint8Array> {
  // Drive the transform via its reader/writer directly — avoids Blob.stream()
  // and Response, neither reliable under jsdom.
  const writer = transform.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
    total += (value as Uint8Array).length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
