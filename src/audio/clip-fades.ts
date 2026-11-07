// A clip's two edges, owned here so the sampler (transport/sampler-machine.ts)
// and the editor's preview read one definition.

/** Click-free cut: ramp the per-hit gain to 0 over CHOKE_FADE, stop just after. */
export const CHOKE_FADE = 0.005;
/** When a choked source is stopped: past its `CHOKE_FADE`, with margin for the render burst. */
export const CHOKE_STOP = 0.03;
/**
 * Attack ramp on a slot's per-hit gain (sampler.md REQ-a-slot-starts-from-zero).
 *
 * User audio is exactly the material we cannot assume anything about: a sample
 * whose first frame is not near zero used to start on a full-scale step, which is
 * a click on every hit. 0.5 ms is ~24 samples at 48 kHz — Web Audio ramps are
 * sample-accurate, so this is not rounded up to a render block. Enough to turn a
 * step into a slope, far too short to soften a transient: a chop's own attack is
 * orders of magnitude longer.
 */
export const SAMPLER_ATTACK = 0.0005;

/**
 * A clip's edges, the sampler's own (sample-recorder.md
 * REQ-the-preview-fades-like-the-slot): in over `SAMPLER_ATTACK`, out over
 * `CHOKE_FADE` finishing as the buffer runs out (sampler.md
 * REQ-a-slot-starts-from-zero, REQ-a-slot-ends-at-zero). For the editor's preview,
 * which plays a buffer source outside the sampler and so got neither.
 *
 * Schedules the shape on `gain` for a clip of `dur` seconds starting at `t`, and
 * returns the level it reaches at any time — computed, not read back, because
 * `AudioParam.value` is not current under automation on Gecko.
 */
export function clipFades(gain: AudioParam, t: number, dur: number): (at: number) => number {
  const len = Math.max(0, dur);
  const atk = Math.min(SAMPLER_ATTACK, len / 2);
  const end = t + len;
  const fadeFrom = Math.max(t + atk, end - CHOKE_FADE);
  gain.setValueAtTime(0, t);
  gain.linearRampToValueAtTime(1, t + atk);
  gain.setValueAtTime(1, fadeFrom);
  gain.linearRampToValueAtTime(0, end);
  return (at) => {
    if (at <= t || at >= end) return 0;
    if (at < t + atk) return (at - t) / atk;
    if (at < fadeFrom) return 1;
    return (end - at) / (end - fadeFrom);
  };
}

/** A Stop mid-clip: from `level` at `at` down to 0 over `CHOKE_FADE`. Returns when it is silent. */
export function fadeOutAt(gain: AudioParam, at: number, level: number): number {
  gain.cancelScheduledValues(at);
  gain.setValueAtTime(level, at);
  gain.linearRampToValueAtTime(0, at + CHOKE_FADE);
  return at + CHOKE_FADE;
}
