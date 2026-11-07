export const RAMP_FAST = 0.005;
export const RAMP_MEDIUM = 0.01;
/**
 * The insert effects' smoothing constant. Slower than `RAMP_MEDIUM` because an
 * effect's controls (delay time, feedback, drive, LFO rate, filter Q) are swept
 * by hand and audibly zipper at a shorter constant.
 */
export const RAMP_SMOOTH = 0.02;
/**
 * The bypass crossfade's constant (effects.md REQ-bypass-and-mix-are-a-crossfade/REQ-toggling-an-effect-must-not-step-the-level). Longer than
 * `RAMP_SMOOTH` because a dry/wet *swap* moves far more level than any single
 * knob does — the wah's is 16-19 dB — and this was `RAMP_MEDIUM`, the shortest
 * constant here, for the biggest move in the audio layer.
 */
export const RAMP_BYPASS = 0.025;

/**
 * How long to wait after ramping a gain to 0 at `RAMP_MEDIUM` before an edit
 * that would click if heard — a rewire, an IR swap, a voice disconnect: ~4 time
 * constants, so the gain is inaudible well before the edit lands.
 */
export const MUTE_SETTLE_MS = 40;

/** Frames per render quantum — the shortest a live note's margin can be. */
const RENDER_QUANTUM_FRAMES = 128;
/** The longest live margin, whatever the device reports: past this it is latency. */
export const LIVE_MARGIN_MAX_S = 0.02;

/**
 * Where a trigger with no time of its own lands — a key, a MIDI note, a pad
 * (live-trigger-timing.md REQ-a-live-trigger-starts-ahead-of-the-render):
 * `currentTime` plus one render
 * burst. The renderer runs a device callback's worth of quanta back to back, so
 * bare `currentTime` can already be in the past by the time the event is read,
 * and an attack anchored in the past renders most of the way to peak on its
 * first sample. `baseLatency` is that burst. A realtime context that reports
 * none (Gecko says `0`) gets the ceiling, since 10 ms was measured too short
 * there (REQ-the-margin-follows-the-device); an offline context, with no burst
 * to outrun, gets one quantum. Only a realtime context has `getOutputTimestamp`.
 */
export function liveStartTime(ctx: BaseAudioContext): number {
  const quantum = RENDER_QUANTUM_FRAMES / ctx.sampleRate;
  const rt = ctx as Partial<AudioContext>;
  const base = rt.baseLatency;
  const burst = typeof base === 'number' && Number.isFinite(base) && base > 0
    ? base
    : typeof rt.getOutputTimestamp === 'function' ? LIVE_MARGIN_MAX_S : quantum;
  return ctx.currentTime + Math.min(LIVE_MARGIN_MAX_S, Math.max(quantum, burst));
}

/**
 * Glide `param` to `value` from now, exponentially with `timeConstant` — the
 * one way a control change reaches an AudioParam without a zipper or a step.
 */
export function rampTo(
  param: AudioParam,
  value: number,
  ctx: BaseAudioContext,
  timeConstant = RAMP_FAST,
): void {
  param.setTargetAtTime(value, ctx.currentTime, timeConstant);
}

/**
 * A 0..1 "tone" knob mapped to a lowpass cutoff in Hz, exponentially across
 * 300 Hz…20 kHz. **1 is open**, i.e. a no-op (ADR-006) — which is why both the drum
 * machine's per-track tone and the sampler's per-slot tone default to it.
 *
 * Shared rather than written twice so "tone" cannot come to mean two different
 * curves on two machines — the same reason `fx-chain.ts` instantiates one delay
 * factory per chain instead of copying the delay.
 */
export function toneCutoff(tone: number): number {
  const min = 300, max = 20000;
  const t = tone < 0 ? 0 : tone > 1 ? 1 : tone;
  return min * Math.pow(max / min, t);
}
