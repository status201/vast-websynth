import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { zipWrite, zipRead, crc32, ZipError, type ZipEntry } from '../../src/utils/zip';
import { hasCompression } from '../../src/utils/compression';

const enc = new TextEncoder();

function bytesOf(s: string): Uint8Array {
  return enc.encode(s);
}

/** All 256 byte values — catches sign/encoding slips in the store path. */
function fullRange(): Uint8Array {
  return new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
}

describe('crc32', () => {
  it('matches the standard test vectors', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(bytesOf('123456789'))).toBe(0xcbf43926);
  });
});

describe('zipWrite / zipRead round-trip', () => {
  it('round-trips stored entries: empty, UTF-8 name, full byte range', async () => {
    const entries: ZipEntry[] = [
      { name: 'empty.bin', data: new Uint8Array(0) },
      { name: 'samples/0-ünïcode 音.wav', data: fullRange() },
      { name: 'samples/3-kick.mp3', data: bytesOf('not really mp3') },
    ];
    const zip = await zipWrite(entries);
    const back = await zipRead(zip);
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    for (let i = 0; i < entries.length; i++) {
      expect(Array.from(back[i]!.data)).toEqual(Array.from(entries[i]!.data));
    }
  });

  it('produces deterministic output for stored entries', async () => {
    const entries: ZipEntry[] = [{ name: 'a.wav', data: fullRange() }];
    const a = await zipWrite(entries);
    const b = await zipWrite(entries);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('tolerates trailing garbage after the EOCD (hand-re-zipped archives)', async () => {
    const zip = await zipWrite([{ name: 'a.bin', data: bytesOf('payload') }]);
    const padded = new Uint8Array(zip.length + 40);
    padded.set(zip, 0);
    padded.fill(0x41, zip.length); // 'A' * 40 pretend-comment
    const back = await zipRead(padded);
    expect(back).toHaveLength(1);
    expect(new TextDecoder().decode(back[0]!.data)).toBe('payload');
  });

  it('returns duplicate names as-is (caller decides)', async () => {
    const zip = await zipWrite([
      { name: 'x.bin', data: bytesOf('one') },
      { name: 'x.bin', data: bytesOf('two') },
    ]);
    const back = await zipRead(zip);
    expect(back.map((e) => new TextDecoder().decode(e.data))).toEqual(['one', 'two']);
  });

  it('reads a subarray view (non-zero byteOffset) correctly', async () => {
    const zip = await zipWrite([{ name: 'a.bin', data: bytesOf('offset-safe') }]);
    const shifted = new Uint8Array(zip.length + 7);
    shifted.set(zip, 7);
    const back = await zipRead(shifted.subarray(7));
    expect(new TextDecoder().decode(back[0]!.data)).toBe('offset-safe');
  });
});

describe('zipRead error paths', () => {
  it('rejects garbage and truncated archives with ZipError', async () => {
    await expect(zipRead(bytesOf('PK not a zip'))).rejects.toBeInstanceOf(ZipError);
    const zip = await zipWrite([{ name: 'a.bin', data: fullRange() }]);
    await expect(zipRead(zip.subarray(0, 10))).rejects.toBeInstanceOf(ZipError);
    await expect(zipRead(new Uint8Array(0))).rejects.toBeInstanceOf(ZipError);
  });

  it('rejects a corrupted (bad-CRC) entry', async () => {
    const zip = await zipWrite([{ name: 'a.bin', data: bytesOf('checksummed') }]);
    const corrupted = zip.slice();
    // Local header is 30 bytes + 5-byte name; flip a data byte right after it.
    corrupted[30 + 'a.bin'.length]! ^= 0xff;
    await expect(zipRead(corrupted)).rejects.toThrow(/CRC mismatch/);
  });

  it('rejects an unknown compression method', async () => {
    const zip = await zipWrite([{ name: 'a.bin', data: bytesOf('stored') }]);
    const patched = zip.slice();
    // Method lives at central-record offset +10; find the central dir via EOCD.
    const view = new DataView(patched.buffer);
    const centralOffset = view.getUint32(patched.length - 22 + 16, true);
    view.setUint16(centralOffset + 10, 99, true);
    await expect(zipRead(patched)).rejects.toThrow(/method 99/);
  });

  it('rejects a zip64 EOCD (entry count 0xffff)', async () => {
    const zip = await zipWrite([{ name: 'a.bin', data: bytesOf('x') }]);
    const patched = zip.slice();
    const view = new DataView(patched.buffer);
    view.setUint16(patched.length - 22 + 10, 0xffff, true);
    await expect(zipRead(patched)).rejects.toThrow(/Zip64/);
  });
});

describe.runIf(hasCompression())('deflate (method 8)', () => {
  it('deflates .json entries and round-trips them', async () => {
    const json = JSON.stringify({ format: 'websynth-song', pad: 'x'.repeat(400) });
    const zip = await zipWrite([{ name: 'song.json', data: bytesOf(json) }]);
    // Local-header method field (offset 8) says deflate, and the payload shrank.
    expect(new DataView(zip.buffer).getUint16(8, true)).toBe(8);
    expect(zip.length).toBeLessThan(json.length);
    const back = await zipRead(zip);
    expect(new TextDecoder().decode(back[0]!.data)).toBe(json);
  });

  it('reads a method-8 fixture built by an independent writer (node:zlib)', async () => {
    // Hand-assemble a one-entry zip whose data was deflated by node:zlib —
    // proves the reader against a non-zipWrite producer.
    const name = bytesOf('song.json');
    const raw = bytesOf('{"hello":"zip"}');
    const compressed = new Uint8Array(deflateRawSync(raw));
    const crc = crc32(raw);

    const local = new Uint8Array(30 + name.length);
    let v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(8, 8, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, compressed.length, true);
    v.setUint32(22, raw.length, true);
    v.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    v = new DataView(central.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint16(10, 8, true);
    v.setUint32(16, crc, true);
    v.setUint32(20, compressed.length, true);
    v.setUint32(24, raw.length, true);
    v.setUint16(28, name.length, true);
    v.setUint32(42, 0, true); // local header offset
    central.set(name, 46);

    const centralStart = local.length + compressed.length;
    const eocd = new Uint8Array(22);
    v = new DataView(eocd.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, 1, true);
    v.setUint16(10, 1, true);
    v.setUint32(12, central.length, true);
    v.setUint32(16, centralStart, true);

    const zip = new Uint8Array(centralStart + central.length + 22);
    zip.set(local, 0);
    zip.set(compressed, local.length);
    zip.set(central, centralStart);
    zip.set(eocd, centralStart + central.length);

    const back = await zipRead(zip);
    expect(back).toHaveLength(1);
    expect(back[0]!.name).toBe('song.json');
    expect(new TextDecoder().decode(back[0]!.data)).toBe('{"hello":"zip"}');
  });
});
