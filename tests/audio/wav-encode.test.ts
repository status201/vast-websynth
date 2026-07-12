import { describe, it, expect, vi } from 'vitest';
import {
  encodeWav,
  encodeMp3,
  writeWavHeader,
  floatToPcm16,
} from '../../src/audio/recorder/encode';

function str(view: DataView, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe('writeWavHeader', () => {
  it('writes a canonical 44-byte RIFF/WAVE 16-bit PCM header', () => {
    const v = new DataView(new ArrayBuffer(44));
    writeWavHeader(v, 100, 48000, 2);
    expect(str(v, 0, 4)).toBe('RIFF');
    expect(str(v, 8, 4)).toBe('WAVE');
    expect(str(v, 12, 4)).toBe('fmt ');
    expect(str(v, 36, 4)).toBe('data');
    expect(v.getUint16(20, true)).toBe(1);          // PCM
    expect(v.getUint16(22, true)).toBe(2);          // channels
    expect(v.getUint32(24, true)).toBe(48000);      // sample rate
    expect(v.getUint16(34, true)).toBe(16);         // bits per sample
    expect(v.getUint16(32, true)).toBe(4);          // blockAlign = 2ch * 2B
    expect(v.getUint32(28, true)).toBe(48000 * 4);  // byte rate
    expect(v.getUint32(40, true)).toBe(100 * 4);    // data length
    expect(v.getUint32(4, true)).toBe(36 + 100 * 4); // RIFF chunk size
  });
});

describe('floatToPcm16', () => {
  it('maps and clamps floats to little-endian Int16', () => {
    const v = new DataView(new ArrayBuffer(8));
    floatToPcm16(v, 0, new Float32Array([1, -1, 0, 2 /* clamps to 1 */]));
    expect(v.getInt16(0, true)).toBe(0x7fff);
    expect(v.getInt16(2, true)).toBe(-0x8000);
    expect(v.getInt16(4, true)).toBe(0);
    expect(v.getInt16(6, true)).toBe(0x7fff);
  });
});

describe('encodeWav', () => {
  it('produces a stereo audio/wav Blob of the right size', async () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([-1, 0, 1]);
    const blob = encodeWav(left, right, 44100);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 3 * 4); // header + 3 interleaved stereo frames

    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    expect(str(v, 0, 4)).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(44100);
    // first frame: L=1 → 0x7fff, R=-1 → -0x8000
    expect(v.getInt16(44, true)).toBe(0x7fff);
    expect(v.getInt16(46, true)).toBe(-0x8000);
  });
});

describe('encodeMp3', () => {
  it('falls back to WAV (with a warning) on an unsupported sample rate', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blob = encodeMp3(new Float32Array(8), new Float32Array(8), 12345);
    expect(blob.type).toBe('audio/wav');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('encodes an audio/mpeg Blob at 192 kbps CBR for a supported sample rate', async () => {
    const n = 4096;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = Math.sin(i * 0.05) * 0.5;
      right[i] = Math.sin(i * 0.07) * 0.5;
    }
    const blob = encodeMp3(left, right, 44100);
    expect(blob.type).toBe('audio/mpeg');
    expect(blob.size).toBeGreaterThan(0);

    // Pin the bitrate (audio-export.md REQ-5): find the first frame sync
    // (11 set bits), then read the bitrate index from the header's third
    // byte — MPEG-1 Layer III index 0xB = 192 kbps.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let i = 0;
    while (i < bytes.length - 4 && !(bytes[i] === 0xff && (bytes[i + 1]! & 0xe0) === 0xe0)) i++;
    expect(i).toBeLessThan(bytes.length - 4);
    expect(bytes[i + 2]! >> 4).toBe(0xb);
  });
});
