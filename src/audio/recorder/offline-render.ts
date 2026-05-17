/**
 * Effects that need real DSP, rendered through an OfflineAudioContext (so
 * they're deterministic and AudioContext-lifecycle-free). Low/Hi-pass use a
 * BiquadFilter; Octave Up/Down use `playbackRate` (a simple resample — it
 * changes both pitch AND duration, which is the fun/cheap behaviour for a
 * sampler toy, not a formant-preserving shifter).
 */
import type { CapturedAudio } from './node';
import { capturedToAudioBuffer } from './audio-buffer';

export type RenderEffect =
  | { kind: 'lowpass'; freq: number }
  | { kind: 'highpass'; freq: number }
  | { kind: 'octaveUp' }
  | { kind: 'octaveDown' };

export async function renderEffect(a: CapturedAudio, fx: RenderEffect): Promise<CapturedAudio> {
  const srcLen = Math.min(a.left.length, a.right.length);
  if (srcLen === 0) return { left: a.left.slice(), right: a.right.slice(), sampleRate: a.sampleRate };

  const rate = fx.kind === 'octaveUp' ? 2 : fx.kind === 'octaveDown' ? 0.5 : 1;
  const outLen = Math.max(1, Math.ceil(srcLen / rate));
  const oac = new OfflineAudioContext(2, outLen, a.sampleRate);

  const src = oac.createBufferSource();
  src.buffer = capturedToAudioBuffer(oac, a);
  src.playbackRate.value = rate;

  let node: AudioNode = src;
  if (fx.kind === 'lowpass' || fx.kind === 'highpass') {
    const biquad = oac.createBiquadFilter();
    biquad.type = fx.kind;
    biquad.frequency.value = fx.freq;
    biquad.Q.value = 0.707;
    src.connect(biquad);
    node = biquad;
  }
  node.connect(oac.destination);
  src.start();

  const out = await oac.startRendering();
  const left = out.getChannelData(0).slice();
  const right = (out.numberOfChannels > 1 ? out.getChannelData(1) : out.getChannelData(0)).slice();
  return { left, right, sampleRate: a.sampleRate };
}
