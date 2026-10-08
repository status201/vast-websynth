import { describe, it, expect } from 'vitest';
import { audioBufferView, audioBufferToCaptured } from '../../../src/audio/recorder/audio-buffer';
import { clipChannels, encodeClipWav } from '../../../src/audio/recorder/encode';
import { makeStubBuffer } from '../mock-audio-context';

// project-export.md REQ-a-mono-clip-exports-as-mono / sample-persistence.md
// REQ-clips-persist-in-indexeddb: the export and the clip store encode from an
// uncopied view, so a one-channel buffer is recognised as mono by identity.
describe('audioBufferView', () => {
  it("reads a mono buffer's channel uncopied, as both left and right", () => {
    const buf = makeStubBuffer(64, 48000, 1);
    const v = audioBufferView(buf);
    expect(v.left).toBe(buf.getChannelData(0));
    expect(v.right).toBe(v.left);
    expect(v.sampleRate).toBe(48000);
    expect(clipChannels(v.left, v.right)).toHaveLength(1);
  });

  it('reads both channels of a stereo buffer uncopied', () => {
    const buf = makeStubBuffer(64, 48000, 2);
    const v = audioBufferView(buf);
    expect(v.left).toBe(buf.getChannelData(0));
    expect(v.right).toBe(buf.getChannelData(1));
  });

  it('leaves audioBufferToCaptured copying — editors write to what it returns', () => {
    const buf = makeStubBuffer(64, 48000, 1);
    const c = audioBufferToCaptured(buf);
    expect(c.left).not.toBe(buf.getChannelData(0));
    expect(c.right).not.toBe(c.left);
  });
});

describe('encodeClipWav', () => {
  it('writes a mono view as a one-channel WAV', async () => {
    const buf = makeStubBuffer(100, 44100, 1);
    const { left, right, sampleRate } = audioBufferView(buf);
    const blob = encodeClipWav(left, right, sampleRate);
    expect(new DataView(await blob.arrayBuffer()).getUint16(22, true)).toBe(1);
    expect(blob.size).toBe(44 + 100 * 2);
  });
});
