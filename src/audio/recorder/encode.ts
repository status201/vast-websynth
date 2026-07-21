/**
 * Pure audio-encoding helpers — NO AudioContext / DOM dependency (except the
 * standalone `triggerDownload`), so the WAV path is unit-testable under
 * vitest+jsdom. WAV is dependency-free; MP3 uses the vendored lamejs, pulled in
 * by a dynamic import so its 153 kB stay off the boot path (audio-export.md
 * REQ-7 — that is why `encodeMp3` is async and `encodeWav` is not).
 */

/** lamejs supports these PCM sample rates; others fall back to WAV. */
const MP3_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);

/** CBR bitrate for every MP3 encode — LAME's "high quality" sweet spot (≈ -V2). */
const MP3_KBPS = 192;

function clampSample(s: number): number {
  return s < -1 ? -1 : s > 1 ? 1 : s;
}

/** Write `samples` as little-endian 16-bit PCM starting at byte `offset`. */
export function floatToPcm16(view: DataView, offset: number, samples: Float32Array): void {
  for (let i = 0; i < samples.length; i++) {
    const s = clampSample(samples[i]!);
    view.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

function writeStr(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/** Canonical 44-byte RIFF/WAVE header for 16-bit PCM. */
export function writeWavHeader(
  view: DataView,
  numSamples: number,
  sampleRate: number,
  channels: number,
): void {
  const blockAlign = channels * 2;
  const dataLen = numSamples * blockAlign;
  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(view, 36, 'data');
  view.setUint32(40, dataLen, true);
}

/** Interleaved stereo 16-bit PCM WAV. */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Blob {
  const numSamples = Math.min(left.length, right.length);
  const buf = new ArrayBuffer(44 + numSamples * 4);
  const view = new DataView(buf);
  writeWavHeader(view, numSamples, sampleRate, 2);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const l = clampSample(left[i]!);
    const r = clampSample(right[i]!);
    view.setInt16(off, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    view.setInt16(off + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    off += 4;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function floatToInt16Array(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = clampSample(samples[i]!);
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Stereo MP3 (MP3_KBPS CBR). Falls back to WAV (with a warning) if the sample
 * rate is one lamejs cannot handle — we never resample. The fallback returns
 * before the import, so an unsupported rate never fetches the encoder chunk.
 */
export async function encodeMp3(left: Float32Array, right: Float32Array, sampleRate: number): Promise<Blob> {
  if (!MP3_RATES.has(sampleRate)) {
    console.warn(`encodeMp3: sample rate ${sampleRate} unsupported by lamejs — exporting WAV instead.`);
    return encodeWav(left, right, sampleRate);
  }
  const { Mp3Encoder } = await import('../../vendor/lamejs');
  const enc = new Mp3Encoder(2, sampleRate, MP3_KBPS);
  const l16 = floatToInt16Array(left);
  const r16 = floatToInt16Array(right);
  const numSamples = Math.min(l16.length, r16.length);
  const block = 1152;
  const parts: Int8Array[] = [];
  for (let i = 0; i < numSamples; i += block) {
    const ls = l16.subarray(i, i + block);
    const rs = r16.subarray(i, i + block);
    const chunk = enc.encodeBuffer(ls, rs);
    if (chunk.length > 0) parts.push(chunk);
  }
  const tail = enc.flush();
  if (tail.length > 0) parts.push(tail);
  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
}

/** Browser download (mirrors Song.download). */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
