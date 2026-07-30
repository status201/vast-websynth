/**
 * Shared `deflate-raw` helpers over the platform Compression/Decompression
 * Streams — feature-detected on `globalThis` (absent under jsdom), so callers
 * must guard with `hasCompression()` or provide a raw fallback. Extracted from
 * `audio/webrtc-signaling.ts` so non-audio modules (the zip codec) can reuse
 * them without depending on a signaling module.
 */

interface CompressionCtor { new (format: string): GenericTransformStream }

export function hasCompression(): boolean {
  return typeof (globalThis as { CompressionStream?: unknown }).CompressionStream !== 'undefined'
    && typeof (globalThis as { DecompressionStream?: unknown }).DecompressionStream !== 'undefined';
}

export function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as unknown as { CompressionStream: CompressionCtor }).CompressionStream;
  return streamThrough(new Ctor('deflate-raw'), bytes);
}

/**
 * Inflate, refusing to produce more than `maxBytes` (untrusted-input.md REQ-2).
 *
 * The cap is enforced **inside** the read loop, not by measuring the result:
 * deflate's ratio tops out around 1032:1, so an address-bar-sized payload can
 * expand to gigabytes, and a check that runs after the fact has already spent
 * the memory it was meant to protect. Omit `maxBytes` only for data we produced
 * ourselves.
 */
export function inflateRaw(bytes: Uint8Array, maxBytes?: number): Promise<Uint8Array> {
  const Ctor = (globalThis as unknown as { DecompressionStream: CompressionCtor }).DecompressionStream;
  return streamThrough(new Ctor('deflate-raw'), bytes, maxBytes);
}

/** Thrown when a decompression exceeds its budget. Distinct so callers can re-word it. */
export class InflateLimitError extends Error {
  constructor(limit: number) {
    super(`Compressed data expands past the ${limit} byte limit.`);
    this.name = 'InflateLimitError';
  }
}

async function streamThrough(
  transform: GenericTransformStream,
  bytes: Uint8Array,
  maxBytes?: number,
): Promise<Uint8Array> {
  // Drive the transform via its reader/writer directly — avoids Blob.stream()
  // and Response, neither reliable under jsdom. The write/close promises are
  // deliberately floating, but they must swallow rejections: on corrupt input
  // (e.g. a bad share-link payload) the transform errors BOTH sides, and the
  // reader below already surfaces that error — an uncaught writer rejection
  // would crash the process as an unhandled rejection.
  const writer = transform.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    total += chunk.length;
    if (maxBytes !== undefined && total > maxBytes) {
      // Drop what we have and stop pulling — the point of the cap is that the
      // rest of the bomb is never decompressed, let alone retained.
      chunks.length = 0;
      await reader.cancel().catch(() => {});
      throw new InflateLimitError(maxBytes);
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
