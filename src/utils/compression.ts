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

export function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
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
