import { isIOS } from '../platform/ios';
import { encodeWav } from './recorder/encode';

/**
 * iOS routes pure Web Audio as *ambient* audio, which honors the ring/silent
 * switch — the graph runs and the scope animates, but no sound reaches the
 * speaker when the switch is silent. Playing a silent HTMLMediaElement from a
 * user gesture flips the page's audio session to the *playback* category, which
 * ignores the switch (the same thing YouTube/Spotify do). Keeping the element
 * **looping** holds that category for the session's life.
 *
 * This is all a no-op off iOS, so it can be owned by the Engine unconditionally.
 * See `specs/features/ios-audio.md`.
 */

/**
 * Whether `AudioContext.resume()` should run for a given state. True for
 * `'suspended'` and the non-standard iOS `'interrupted'` (and any non-running
 * value); false for `'running'`/`'closed'`. Takes a string so the iOS-only
 * `'interrupted'` state — absent from TS's `AudioContextState` — needn't be a
 * literal here.
 */
export function shouldResumeContext(state: string): boolean {
  return state !== 'running' && state !== 'closed';
}

/** ~0.5 s of silence is plenty for a robust loop without churning the file size. */
const SILENT_SECONDS = 0.5;
const SILENT_RATE = 44100;

export class IosAudioSession {
  /** Resolved once: iOS gets the workaround, every other platform stays inert. */
  readonly active = isIOS();

  private el: HTMLAudioElement | null = null;

  /**
   * Switch the audio session to *playback* by playing the silent loop. Must be
   * called from within a user gesture (the "Tap to start" handler). No-op off
   * iOS; never throws (play rejection is swallowed).
   */
  unlock(): void {
    if (!this.active) return;
    this.ensureElement();
    void this.el!.play().catch(() => { /* gesture lost / autoplay block — retried on next gesture */ });
  }

  /** Re-establish the session after an interruption (Siri/call/app-switch). */
  rearm(): void {
    if (!this.active || !this.el) return;
    void this.el.play().catch(() => { /* will retry on the next visibility/state change or gesture */ });
  }

  /** Build the single silent, looping `<audio>` element on first use. */
  private ensureElement(): void {
    if (this.el) return;
    const samples = new Float32Array(Math.round(SILENT_SECONDS * SILENT_RATE));
    const blob = encodeWav(samples, samples, SILENT_RATE);
    const el = new Audio();
    el.src = URL.createObjectURL(blob);
    el.loop = true;
    // `playsInline` is not on the TS `HTMLMediaElement` surface; set the attribute.
    el.setAttribute('playsinline', '');
    el.preload = 'auto';
    this.el = el;
  }
}
