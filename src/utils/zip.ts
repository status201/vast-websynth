/**
 * Minimal dependency-free ZIP codec (ADR-003: no runtime deps) for the
 * project-export bundle (project-export.md REQ-2). Deliberately small:
 *
 * Writer — local headers + central directory + EOCD. UTF-8 names (bit 11),
 * a fixed DOS timestamp so output is deterministic. `.json` entries are
 * deflated (method 8, via the platform `CompressionStream`) when available;
 * everything else is stored (method 0 — MP3 is incompressible, WAV gains
 * little).
 *
 * Reader — robust against hand-re-zipped archives: finds the EOCD by backward
 * scan (tolerates trailing bytes/comments), trusts the *central directory*
 * sizes/CRC/offsets (sidesteps streaming-zipper data descriptors), and reads
 * each local header's own name/extra lengths to locate the data. Accepts
 * methods 0 + 8, skips `…/` directory entries, CRC-verifies every entry, and
 * throws a typed `ZipError` on zip64, unknown methods, bad CRC or truncation.
 */
import { hasCompression, deflateRaw, inflateRaw, InflateLimitError } from './compression';
import { MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_BYTES, MAX_ZIP_TOTAL_BYTES } from '../state/limits';

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Thrown for any malformed / unsupported archive (mirrors SignalDecodeError). */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

// ---- CRC-32 (IEEE, table-based) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---- shared constants ----

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800;
// 2020-01-01 00:00:00 as DOS date/time — fixed so zipWrite is deterministic.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---- writer ----

/** Deflate `.json` entries when the platform can; store everything else. */
async function encodeEntryData(name: string, data: Uint8Array): Promise<{ method: number; bytes: Uint8Array }> {
  if (name.toLowerCase().endsWith('.json') && hasCompression()) {
    return { method: METHOD_DEFLATE, bytes: await deflateRaw(data) };
  }
  return { method: METHOD_STORE, bytes: data };
}

export async function zipWrite(entries: ZipEntry[]): Promise<Uint8Array> {
  interface Prepared {
    nameBytes: Uint8Array;
    method: number;
    crc: number;
    compressed: Uint8Array;
    size: number;
    offset: number;
  }
  const prepared: Prepared[] = [];
  let offset = 0;
  const parts: Uint8Array[] = [];

  for (const e of entries) {
    const nameBytes = encoder.encode(e.name);
    const { method, bytes } = await encodeEntryData(e.name, e.data);
    const p: Prepared = {
      nameBytes,
      method,
      crc: crc32(e.data),
      compressed: bytes,
      size: e.data.length,
      offset,
    };
    prepared.push(p);

    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, SIG_LOCAL, true);
    v.setUint16(4, 20, true);              // version needed
    v.setUint16(6, FLAG_UTF8, true);
    v.setUint16(8, method, true);
    v.setUint16(10, DOS_TIME, true);
    v.setUint16(12, DOS_DATE, true);
    v.setUint32(14, p.crc, true);
    v.setUint32(18, bytes.length, true);   // compressed size
    v.setUint32(22, p.size, true);         // uncompressed size
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);              // extra length
    header.set(nameBytes, 30);
    parts.push(header, bytes);
    offset += header.length + bytes.length;
  }

  const centralStart = offset;
  for (const p of prepared) {
    const rec = new Uint8Array(46 + p.nameBytes.length);
    const v = new DataView(rec.buffer);
    v.setUint32(0, SIG_CENTRAL, true);
    v.setUint16(4, 20, true);              // version made by
    v.setUint16(6, 20, true);              // version needed
    v.setUint16(8, FLAG_UTF8, true);
    v.setUint16(10, p.method, true);
    v.setUint16(12, DOS_TIME, true);
    v.setUint16(14, DOS_DATE, true);
    v.setUint32(16, p.crc, true);
    v.setUint32(20, p.compressed.length, true);
    v.setUint32(24, p.size, true);
    v.setUint16(28, p.nameBytes.length, true);
    // extra/comment/disk/attrs all zero
    v.setUint32(42, p.offset, true);
    rec.set(p.nameBytes, 46);
    parts.push(rec);
    offset += rec.length;
  }

  const eocd = new Uint8Array(22);
  const v = new DataView(eocd.buffer);
  v.setUint32(0, SIG_EOCD, true);
  v.setUint16(8, prepared.length, true);   // entries on this disk
  v.setUint16(10, prepared.length, true);  // entries total
  v.setUint32(12, offset - centralStart, true); // central dir size
  v.setUint32(16, centralStart, true);          // central dir offset
  parts.push(eocd);

  const out = new Uint8Array(offset + 22);
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
}

// ---- reader ----

/** Backward-scan for the EOCD signature (tolerates trailing bytes/comments). */
function findEocd(view: DataView): number {
  // EOCD is 22 bytes + up to a 65535-byte comment.
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  throw new ZipError('Not a zip file (no end-of-central-directory record).');
}

export async function zipRead(bytes: Uint8Array): Promise<ZipEntry[]> {
  if (bytes.length < 22) throw new ZipError('Not a zip file (too short).');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || centralOffset === 0xffffffff) {
    throw new ZipError('Zip64 archives are not supported.');
  }
  if (centralOffset >= bytes.length) throw new ZipError('Corrupt zip (central directory out of range).');
  // A zip is untrusted input (untrusted-input.md REQ-2): refuse an absurd entry
  // count before walking it, so the loop below can never be the attack.
  if (count > MAX_ZIP_ENTRIES) {
    throw new ZipError(`Zip has ${count} entries — the limit is ${MAX_ZIP_ENTRIES}.`);
  }

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  let pos = centralOffset;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > eocd || view.getUint32(pos, true) !== SIG_CENTRAL) {
      throw new ZipError('Corrupt zip (bad central directory record).');
    }
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('Zip64 entries are not supported.');
    }
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry

    // Pre-flight budget: the central directory already declares the uncompressed
    // size, so an oversized entry is refused BEFORE it is inflated. (The inflate
    // is capped too — a lying header must not buy a bomb — but checking the
    // declaration first turns the common case into a cheap refusal.)
    if (size > MAX_ZIP_ENTRY_BYTES) {
      throw new ZipError(`Zip entry "${name}" declares ${size} bytes — the limit is ${MAX_ZIP_ENTRY_BYTES}.`);
    }
    if (totalBytes + size > MAX_ZIP_TOTAL_BYTES) {
      throw new ZipError(`Zip contents exceed the ${MAX_ZIP_TOTAL_BYTES} byte total limit.`);
    }

    // The local header's own name/extra lengths may differ from the central
    // record's — read them to locate the data.
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new ZipError(`Corrupt zip (bad local header for "${name}").`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compressedSize > bytes.length) {
      throw new ZipError(`Corrupt zip (truncated data for "${name}").`);
    }
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === METHOD_STORE) {
      data = compressed;
    } else if (method === METHOD_DEFLATE) {
      if (!hasCompression()) {
        throw new ZipError('This browser cannot inflate compressed zip entries (no DecompressionStream).');
      }
      try {
        data = await inflateRaw(compressed, MAX_ZIP_ENTRY_BYTES);
      } catch (e) {
        // Separate the two failures: a bomb is not a corrupt file, and telling
        // the user "corrupt" for an oversized entry would send them fixing the
        // wrong thing.
        if (e instanceof InflateLimitError) {
          throw new ZipError(`Zip entry "${name}" expands past the ${MAX_ZIP_ENTRY_BYTES} byte limit.`);
        }
        throw new ZipError(`Corrupt zip (bad deflate stream for "${name}").`);
      }
    } else {
      throw new ZipError(`Unsupported compression method ${method} for "${name}".`);
    }
    if (data.length !== size || crc32(data) !== crc) {
      throw new ZipError(`Corrupt zip (CRC mismatch for "${name}").`);
    }
    totalBytes += data.length;
    entries.push({ name, data });
  }
  return entries;
}
