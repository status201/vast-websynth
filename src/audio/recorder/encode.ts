/**
 * Pure audio-encoding helpers — NO AudioContext / DOM dependency (except the
 * standalone `triggerDownload`), so the WAV path is unit-testable under
 * vitest+jsdom. WAV is dependency-free; MP3 uses the vendored lamejs, pulled in
 * by a dynamic import so its 153 kB stay off the boot path (audio-export.md
 * REQ-the-mp3-encoder-loads-lazily — that is why `encodeMp3` is async and `encodeWav` is not).
 */

/** lamejs supports these PCM sample rates; others fall back to WAV. */
const MP3_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);

/** CBR bitrate for every MP3 encode — LAME's "high quality" sweet spot (≈ -V2). */
const MP3_KBPS = 192;

/**
 * One float sample as a 16-bit PCM value: clamped to -1..1, then scaled
 * asymmetrically (-1 -> -32768, 1 -> 32767) so both extremes are reachable. The
 * one rule the WAV writer and the MP3 encoder's input share; the Int16 storage
 * truncates toward zero, exactly as the two hand-written copies did.
 */
export function pcm16(sample: number): number {
  const s = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return s < 0 ? s * 0x8000 : s * 0x7fff;
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

/** One or two channels — all a WAV or MP3 here ever holds. A tuple, so an empty
 * list (no length to size the file by) or a third channel cannot be passed. */
export type PcmChannels = [Float32Array] | [Float32Array, Float32Array];

/**
 * The channels a sampler clip actually has (project-export.md
 * REQ-a-mono-clip-exports-as-mono): just `left` when the two are
 * sample-for-sample identical, both otherwise. Decided from the samples, not a
 * channel count — a mono sample can arrive as a two-channel buffer with
 * identical halves, and writing it as stereo doubles it for nothing. The same
 * array twice (an uncopied mono buffer, `audioBufferView`) costs no pass at all.
 */
export function clipChannels(left: Float32Array, right: Float32Array): PcmChannels {
  if (left === right) return [left];
  if (left.length !== right.length) return [left, right];
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return [left, right];
  }
  return [left];
}

/** Interleaved 16-bit PCM WAV of one or more channels (shortest channel wins). */
export function encodeWavChannels(channels: PcmChannels, sampleRate: number): Blob {
  const n = channels.length;
  const numSamples = Math.min(...channels.map((c) => c.length));
  const buf = new ArrayBuffer(44 + numSamples * n * 2);
  const view = new DataView(buf);
  writeWavHeader(view, numSamples, sampleRate, n);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < n; c++) {
      view.setInt16(off, pcm16(channels[c]![i]!), true);
      off += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Interleaved stereo 16-bit PCM WAV. */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Blob {
  return encodeWavChannels([left, right], sampleRate);
}

function floatToInt16Array(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = pcm16(samples[i]!);
  return out;
}

/**
 * MP3 (MP3_KBPS CBR) of one or two channels. Falls back to WAV (with a warning,
 * same channels) if the sample rate is one lamejs cannot handle — we never
 * resample. The fallback returns before the import, so an unsupported rate
 * never fetches the encoder chunk.
 */
export async function encodeMp3Channels(channels: PcmChannels, sampleRate: number): Promise<Blob> {
  if (!MP3_RATES.has(sampleRate)) {
    console.warn(`encodeMp3: sample rate ${sampleRate} unsupported by lamejs — exporting WAV instead.`);
    return encodeWavChannels(channels, sampleRate);
  }
  const { Mp3Encoder } = await import('../../vendor/lamejs');
  const pcm = channels.map(floatToInt16Array);
  const l16 = pcm[0]!;
  const r16 = pcm[1]; // absent: a one-channel encoder
  const enc = new Mp3Encoder(r16 ? 2 : 1, sampleRate, MP3_KBPS);
  const numSamples = Math.min(...pcm.map((c) => c.length));
  const block = 1152;
  const parts: Int8Array[] = [];
  for (let i = 0; i < numSamples; i += block) {
    const ls = l16.subarray(i, Math.min(i + block, numSamples));
    const chunk = r16
      ? enc.encodeBuffer(ls, r16.subarray(i, Math.min(i + block, numSamples)))
      : enc.encodeBuffer(ls);
    if (chunk.length > 0) parts.push(chunk);
  }
  const tail = enc.flush();
  if (tail.length > 0) parts.push(tail);
  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
}

/** Stereo MP3 — see `encodeMp3Channels`. */
export async function encodeMp3(left: Float32Array, right: Float32Array, sampleRate: number): Promise<Blob> {
  return encodeMp3Channels([left, right], sampleRate);
}

/**
 * A sampler clip as WAV / MP3: one channel when its two are identical
 * (project-export.md REQ-a-mono-clip-exports-as-mono,
 * sample-persistence.md REQ-clips-persist-in-indexeddb). The one place that rule
 * is applied — the project export and the clip store both come through here.
 * Recorder takes do not: they keep the stereo `encodeWav` / `encodeMp3`.
 */
export function encodeClipWav(left: Float32Array, right: Float32Array, sampleRate: number): Blob {
  return encodeWavChannels(clipChannels(left, right), sampleRate);
}

export function encodeClipMp3(left: Float32Array, right: Float32Array, sampleRate: number): Promise<Blob> {
  return encodeMp3Channels(clipChannels(left, right), sampleRate);
}

