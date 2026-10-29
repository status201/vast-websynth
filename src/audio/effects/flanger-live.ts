import { clamp01 } from '../../utils/math';
import { RAMP_SMOOTH } from '../param-utils';
import { bindTempoLocked } from '../tempo-bind';
import type { ParamBus } from '../../state/params';

/**
 * The flanger's DSP side (flanger.md), imported the first time a flanger is
 * switched on, so none of it is in the entry chunk
 * (REQ-the-flanger-loads-on-first-use). `Flanger` (flanger.ts) is the shell
 * the chain holds from boot.
 */

/**
 * The sweep's constants, mirrored from public/worklets/flanger.js for the tests
 * (REQ-the-flanger-sweeps-in-pitch). The worklet is the authority;
 * `tests/audio/flanger-worklet.test.ts` measures it against these.
 */
export const FLANGER_MIN_DELAY_S = 0.00025;
export const FLANGER_SPAN_OCTAVES = 4.5;
export const FLANGER_MAX_FEEDBACK = 0.9;

/** One load per context, shared by the synth and sampler flangers. */
const modules = new WeakMap<BaseAudioContext, Promise<void>>();

/**
 * Load the worklet module once per context. A failure is forgotten, so a later
 * switch-on tries again rather than staying dead for the session.
 */
export function loadFlangerModule(ctx: BaseAudioContext): Promise<void> {
  let p = modules.get(ctx);
  if (!p) {
    // Through a `then`, so a context without `audioWorklet` rejects instead of throwing.
    p = Promise.resolve().then(() => ctx.audioWorklet.addModule('/worklets/flanger.js'));
    p.catch(() => modules.delete(ctx));
    modules.set(ctx, p);
  }
  return p;
}

/** What the shell keeps of a spliced flanger: enough to quiesce its loop. */
export interface FlangerLive {
  readonly feedback: AudioParam;
  /** Hold (`true`) or release the feedback knob for a drain; returns the knob's value. */
  hold(on: boolean): number;
}

/**
 * Splice the worklet between `span.processedIn` and `span.processedOut`, and
 * bind its params. The shell un-bypasses only after this resolves
 * (REQ-an-unloaded-flanger-stays-bypassed). Each bus subscription fires at once
 * with the current value, so the node starts on the knobs as they stand and
 * nothing had to be cached.
 */
export async function spliceFlanger(
  ctx: BaseAudioContext,
  span: { readonly processedIn: AudioNode; readonly processedOut: AudioNode },
  bus: ParamBus,
  prefix: string,
): Promise<FlangerLive> {
  await loadFlangerModule(ctx);
  // `outputChannelCount` is left unset, so the output follows the input: mono
  // on the synth bus, stereo on the sampler's (REQ-the-flanger-is-a-worklet-delay-line).
  const node = new AudioWorkletNode(ctx, 'flanger', { numberOfInputs: 1, numberOfOutputs: 1 });
  const rate = node.parameters.get('rate')!;
  const depth = node.parameters.get('depth')!;
  const feedback = node.parameters.get('feedback')!;
  span.processedIn.connect(node);
  node.connect(span.processedOut);

  /** The first write lands at once; later ones ramp like any effect's knob. */
  const writer = (p: AudioParam) => {
    let first = true;
    return (v: number): void => {
      if (first) p.setValueAtTime(v, ctx.currentTime);
      else p.setTargetAtTime(v, ctx.currentTime, RAMP_SMOOTH);
      first = false;
    };
  };
  const setRate = writer(rate);
  const setDepth = writer(depth);
  const setFeedback = writer(feedback);
  let fb = 0;
  let held = false;
  bindTempoLocked(bus, `${prefix}.rate`, `${prefix}.sync`, 'freq', setRate);
  bus.subscribe(`${prefix}.depth`, (x) => setDepth(clamp01(x)));
  bus.subscribe(`${prefix}.feedback`, (x) => {
    // Recorded even while held, so the release lands on the current knob.
    fb = Math.max(0, Math.min(FLANGER_MAX_FEEDBACK, x));
    if (!held) setFeedback(fb);
  });
  return {
    feedback,
    hold(on) { held = on; return fb; },
  };
}
