/**
 * The single bridge from the pure `CapturedAudio` interchange type to a Web
 * Audio `AudioBuffer` (for sampler playback / preview / offline rendering).
 * Kept out of `buffer-dsp.ts` so that module stays AudioContext-free and
 * unit-testable under jsdom.
 */
import type { CapturedAudio } from './node';

export function capturedToAudioBuffer(ctx: BaseAudioContext, a: CapturedAudio): AudioBuffer {
  const len = Math.max(1, Math.min(a.left.length, a.right.length));
  const buf = ctx.createBuffer(2, len, a.sampleRate);
  // `.set` (vs copyToChannel) sidesteps the Float32Array<ArrayBuffer> vs
  // <ArrayBufferLike> generic mismatch in the current TS DOM lib.
  buf.getChannelData(0).set(a.left.subarray(0, len));
  buf.getChannelData(1).set(a.right.subarray(0, len));
  return buf;
}

/**
 * A reversed copy of an `AudioBuffer`, **channel count preserved**
 * (sampler.md REQ-13).
 *
 * Deliberately not `buffer-dsp.ts`'s `reverse()`: that one works on
 * `CapturedAudio`, which is always stereo, so routing a slot's playback through it
 * would widen every mono clip and double its memory just to play it backwards.
 * The sampler plays whatever `decodeAudioData` handed back.
 */
export function reverseBuffer(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i]!;
  }
  return out;
}

/** Reverse bridge: an AudioBuffer (sampler slot / decoded file) → the pure
 * `CapturedAudio` interchange type, so a loaded sample can be re-edited.
 * Mono buffers duplicate channel 0 to the right (matches the recorder). */
export function audioBufferToCaptured(buf: AudioBuffer): CapturedAudio {
  const left = buf.getChannelData(0).slice();
  const right = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice();
  return { left, right, sampleRate: buf.sampleRate };
}
