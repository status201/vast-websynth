/**
 * Minimal, dependency-free ZIP writer — shared by `release.mjs` (the `dist/`
 * artifact) and `pack-mcp.mjs` (the MCP server bundle).
 *
 * Extracted from release.mjs when a second caller appeared. There is exactly one
 * zip implementation in this repo and this is it: a second one would be a second
 * chance to get the central directory subtly wrong, which is the kind of bug that
 * only shows up in somebody else's unzip tool.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

// CRC32 — table-based, so we don't depend on zlib.crc32 (newer Node only).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Recursively list files under dir, returning paths relative to `dir` (posix). */
export function listFiles(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = `${dir}/${entry.name}`;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(abs, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Pack a Date into DOS date + time words (used by the ZIP local header). */
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * Build a ZIP archive (Buffer) of every file under `srcDir`, with each entry
 * named `<topPrefix>/<relative path>`. Dependency-free: deflate via node:zlib,
 * CRC32 in JS. Implements the minimal local-header + central-directory + EOCD
 * structure (no Zip64 — fine for a web build).
 */
export function zipDir(srcDir, topPrefix) {
  const files = listFiles(srcDir).sort();
  const local = [];
  const central = [];
  let offset = 0;

  for (const rel of files) {
    const name = `${topPrefix}/${rel}`;
    const nameBuf = Buffer.from(name, 'utf8');
    const data = readFileSync(`${srcDir}/${rel}`);
    const crc = crc32(data);
    const compressed = deflateRawSync(data);
    const { time, date } = dosDateTime(statSync(`${srcDir}/${rel}`).mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // general purpose flags
    localHeader.writeUInt16LE(8, 8); // method: deflate
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    local.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central dir header signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(8, 10); // method: deflate
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    central.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central dir size
  eocd.writeUInt32LE(offset, 16); // central dir offset

  return Buffer.concat([...local, centralBuf, eocd]);
}
