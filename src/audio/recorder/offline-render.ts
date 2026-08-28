/**
 * Effects that need real DSP, rendered through an OfflineAudioContext (so
 * they're deterministic and AudioContext-lifecycle-free). Low/Hi-pass use a
 * BiquadFilter; Octave Up/Down use `playbackRate` (a simple resample — it
 * changes both pitch AND duration, which is the fun/cheap behaviour for a
 * sampler toy, not a formant-preserving shifter).
 */
import type { CapturedAudio } from './node';
import { capturedToAudioBuffer } from './audio-buffer';
import { timeStretch, type StretchMode } from './time-stretch';
import { MAX_PITCH_SHIFT_SEMITONES } from '../../state/limits';

export type RenderEffect =
  | { kind: 'lowpass'; freq: number }
  | { kind: 'highpass'; freq: number }
  | { kind: 'octaveUp' }
  | { kind: 'octaveDown' }
  /** Varispeed by an arbitrary factor — pitch AND duration move together.
   *  `octaveUp`/`octaveDown` are this at 2 and 0.5; both are kept because their
   *  names are the contract the editor's buttons and their tests are written to. */
  | { kind: 'resample'; ratio: number };

export async function renderEffect(a: CapturedAudio, fx: RenderEffect): Promise<CapturedAudio> {
  const srcLen = Math.min(a.left.length, a.right.length);
  if (srcLen === 0) return { left: a.left.slice(), right: a.right.slice(), sampleRate: a.sampleRate };

  const rate = fx.kind === 'octaveUp' ? 2
    : fx.kind === 'octaveDown' ? 0.5
      : fx.kind === 'resample' ? fx.ratio
        : 1;
  // A non-finite or non-positive rate would make `outLen` NaN or Infinity and
  // reach the OfflineAudioContext constructor as a length (ADR-015).
  if (!Number.isFinite(rate) || rate <= 0) {
    return { left: a.left.slice(), right: a.right.slice(), sampleRate: a.sampleRate };
  }
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

/**
 * Shift pitch and keep the length (time-stretch.md REQ-8).
 *
 * Stretch by `2**(st/12)`, then resample by the reciprocal: the stretch moves the
 * clip's duration without touching its pitch, and the resample moves both back —
 * which leaves the pitch shifted and the duration where it started.
 *
 * The resample half deliberately goes through `renderEffect` rather than a
 * hand-written interpolator. Reading a buffer faster is exactly what `octaveUp`
 * already does, the platform handles the interpolation, and writing a second
 * resampler here would be a second thing to keep honest.
 *
 * Returns a copy unchanged at 0 semitones — including the case where the value is
 * non-finite — so the no-op is a code path, not a rounding coincidence.
 */
export async function renderPitchShift(
  a: CapturedAudio,
  semitones: number,
  mode: StretchMode = 'rhythmic',
): Promise<CapturedAudio> {
  const srcLen = Math.min(a.left.length, a.right.length);
  const plain = (): CapturedAudio =>
    ({ left: a.left.slice(), right: a.right.slice(), sampleRate: a.sampleRate });
  if (srcLen === 0 || !Number.isFinite(semitones)) return plain();

  const st = Math.max(-MAX_PITCH_SHIFT_SEMITONES, Math.min(MAX_PITCH_SHIFT_SEMITONES, semitones));
  if (st === 0) return plain();

  const factor = Math.pow(2, st / 12);
  // Stretch to `factor` times the length, then read back at `factor` speed. The
  // stretch target is computed from the SOURCE length so the round trip lands on
  // the original count rather than on a rounded intermediate.
  const stretched = timeStretch(a, factor, mode);
  const grew = Math.min(stretched.left.length, stretched.right.length);
  if (grew === srcLen) return plain();   // the stretch refused it; don't resample alone
  return renderEffect(stretched, { kind: 'resample', ratio: factor });
}
