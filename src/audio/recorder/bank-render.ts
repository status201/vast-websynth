import type { Clock } from '../transport/clock';
import type { CapturedAudio, RecorderNode } from './node';
import { DEFAULT_BAR_TICKS } from '../../state/meter';
import { crop, fadeIn, fadeOut } from './buffer-dsp';

/** Passes played per render: bar 1 primes delay/reverb/release tails, bar 2 is
 *  kept — so the tail is baked into the loop's start and it wraps seamlessly. */
export const RENDER_BARS = 2;
/** Grace period after the final bar so the worklet captures the scheduled
 *  look-ahead audio before we read the buffer (mirrors exportSong's TAIL_MS). */
export const RENDER_TAIL_MS = 350;
/** Anti-click fade at each crop boundary (~128 samples at 44.1 kHz). */
export const RENDER_FADE_MS = 3;

/**
 * Map the render window (the *second* bar) into the captured stream —
 * render-to-sampler REQ-1/REQ-2/REQ-3. Pure.
 *
 * `step0Time` is the scheduled (sample-accurate) audio time of step 0;
 * `firstFrame` the absolute frame index of the capture's first sample
 * (audio-export REQ-6). Swing never moves bar boundaries (the clock's grid
 * accumulator is unswung), so the bar length is exact regardless of swing.
 */
export function bankCropRange(
  step0Time: number,
  sixteenthS: number,
  sampleRate: number,
  firstFrame: number,
  barTicks: number = DEFAULT_BAR_TICKS,
): { start: number; end: number } {
  const barSamples = Math.round(barTicks * sixteenthS * sampleRate);
  const start = Math.round(step0Time * sampleRate) - firstFrame + barSamples;
  return { start, end: start + barSamples };
}

/**
 * Renders the sequencer's current (edit) bank through the live synth + FX
 * chain into an exactly-one-bar buffer: arm the tap, restart the transport,
 * play the bank twice, crop bar 2 by frame arithmetic.
 *
 * The controller owns only transport + capture. Engine-state juggling
 * (force seq enabled/audible, disable the seq chain lane — REQ-5) lives in the
 * injected `prepare()` closure, which returns its own restore function; it is
 * always restored, success or failure. `blocked()` refuses a render while the
 * song recorder is capturing (both restart the clock).
 */
export class BankRenderController {
  private rendering = false;
  private unsubTick: (() => void) | null = null;
  private readonly stateListeners = new Set<(rendering: boolean) => void>();
  /** Bar length in 16th ticks (meter.md REQ-7) — a rendered bar must be the
   *  song's bar, not always 16 steps. The Engine pushes changes here. */
  private barTicks = DEFAULT_BAR_TICKS;

  setBarTicks(ticks: number): void {
    this.barTicks = Number.isFinite(ticks) ? Math.max(1, Math.round(ticks)) : DEFAULT_BAR_TICKS;
  }

  constructor(
    private readonly clock: Clock,
    private readonly node: RecorderNode,
    private readonly prepare: () => () => void,
    private readonly blocked: () => boolean = () => false,
  ) {}

  isRendering(): boolean { return this.rendering; }

  onState(fn: (rendering: boolean) => void): () => void {
    this.stateListeners.add(fn);
    return () => { this.stateListeners.delete(fn); };
  }

  private notify(): void {
    for (const l of this.stateListeners) l(this.rendering);
  }

  async render(): Promise<CapturedAudio> {
    if (this.rendering) throw new Error('a bank render is already in flight');
    if (this.blocked()) throw new Error('the song recorder is capturing');
    this.rendering = true;
    this.notify();
    const restore = this.prepare();
    try {
      return await new Promise<CapturedAudio>((resolve, reject) => {
        let step0Time = -1;
        let sixteenthS = 0;
        const stopAtStep = RENDER_BARS * this.barTicks;
        this.clock.stop();
        this.node.start(); // arm before audio so the pre-roll is captured
        this.unsubTick = this.clock.onTick((step, when) => {
          if (step === 0 && step0Time < 0) {
            // Step 0 is even → unswung: `when` is the exact bar-grid origin.
            step0Time = when;
            sixteenthS = this.clock.sixteenthDuration();
          }
          if (step >= stopAtStep) {
            if (this.unsubTick) { this.unsubTick(); this.unsubTick = null; }
            this.clock.stop();
            window.setTimeout(() => {
              // `finish` awaits the recorder's flush (audio-export.md REQ-6b),
              // so it settles the promise rather than returning into it.
              this.finish(step0Time, sixteenthS).then(resolve, reject);
            }, RENDER_TAIL_MS);
          }
        });
        // Explicit 0: the crop is frame arithmetic off the absolute `step === 0`,
        // and a plain start() now resumes from the user's cue (transport.md REQ-7).
        this.clock.start(0);
      });
    } finally {
      if (this.unsubTick) { this.unsubTick(); this.unsubTick = null; }
      restore();
      this.rendering = false;
      this.notify();
    }
  }

  private async finish(step0Time: number, sixteenthS: number): Promise<CapturedAudio> {
    const captured = await this.node.stop();
    const firstFrame = this.node.firstFrame;
    if (step0Time < 0 || firstFrame === null) throw new Error('bank render captured no audio');
    const { start, end } = bankCropRange(
      step0Time, sixteenthS, captured.sampleRate, firstFrame, this.barTicks,
    );
    const have = Math.min(captured.left.length, captured.right.length);
    if (start < 0 || end > have) throw new Error('bank render missed the bar window');
    return fadeOut(fadeIn(crop(captured, start, end), RENDER_FADE_MS), RENDER_FADE_MS);
  }
}
