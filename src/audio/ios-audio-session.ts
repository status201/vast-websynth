import { isIOS } from '../platform/ios';
import { encodeWav } from './recorder/encode';

/**
 * iOS routes pure Web Audio as *ambient* audio, which honors the ring/silent
 * switch — the graph runs and the scope animates, but no sound reaches the
 * speaker when the switch is silent. Feeding a silent, looping HTMLMediaElement
 * **through the AudioContext** (`createMediaElementSource → destination`) from a
 * user gesture makes the context itself *media-backed*, which lifts it off the
 * ambient category (a *detached* element only elevates the page session — that
 * fixed iPad, which has no mute switch, but not a muted iPhone). Keeping the
 * element **looping** holds that category for the session's life.
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

/** On-device diagnostics, surfaced by the Debug panel (see `debug-panel.md`). */
export interface IosAudioDiagnostics {
  /** True on iOS — i.e. whether the workaround is engaged at all. */
  active: boolean;
  /** Unlock lifecycle: 'n/a' (off iOS) | 'idle' | 'starting' | 'playing' | 'blocked: <name>'. */
  status: string;
  /** Whether the silent element is routed through the context (media-backed). */
  routed: boolean;
  /** Silent element `paused` state, or null before it is built. */
  paused: boolean | null;
  /** Silent element `currentTime` (advances while playing), or null before built. */
  currentTime: number | null;
  /** Whether `navigator.audioSession.type = 'playback'` was set (Safari 17+). */
  audioSessionSet: boolean;
}

/** ~0.5 s of silence is plenty for a robust loop without churning the file size. */
const SILENT_SECONDS = 0.5;
const SILENT_RATE = 44100;

export class IosAudioSession {
  /** Resolved once: iOS gets the workaround, every other platform stays inert. */
  readonly active = isIOS();

  private el: HTMLAudioElement | null = null;
  private srcNode: MediaElementAudioSourceNode | null = null;
  private status: string = this.active ? 'idle' : 'n/a';
  private audioSessionSet = false;

  constructor(private readonly ctx: AudioContext) {}

  /**
   * Switch the audio session to *playback* by playing the (context-routed) silent
   * loop. Must be called from within a user gesture (the "Tap to start" handler).
   * No-op off iOS; never throws (play rejection is swallowed into `status`).
   */
  unlock(): void {
    // Audio Session API (Safari 17+): declare the session as *playback* so the
    // synth stays audible with the ring/silent switch on silent. Additive to —
    // never a replacement for — the silent-loop workaround below (Safari <17
    // still needs it). Feature-detected rather than iOS-gated: the API is
    // Safari-only anyway and harmless wherever it appears.
    // See pwa-install.md REQ-4.
    if (typeof navigator !== 'undefined' && navigator.audioSession) {
      try {
        navigator.audioSession.type = 'playback';
        this.audioSessionSet = true;
      } catch { /* older Safari exposes the object but not the setter */ }
    }
    if (!this.active) return;
    this.ensureElement();
    this.play();
  }

  /** Re-establish the session after an interruption (Siri/call/app-switch). */
  rearm(): void {
    if (!this.active || !this.el) return;
    this.play();
  }

  get diagnostics(): IosAudioDiagnostics {
    return {
      active: this.active,
      status: this.status,
      routed: this.srcNode !== null,
      paused: this.el ? this.el.paused : null,
      currentTime: this.el ? this.el.currentTime : null,
      audioSessionSet: this.audioSessionSet,
    };
  }

  /** Play the silent loop, recording the outcome for the Debug panel. */
  private play(): void {
    if (!this.el) return;
    this.status = 'starting';
    this.el.play()
      .then(() => { this.status = 'playing'; })
      .catch((e: unknown) => { this.status = 'blocked: ' + ((e as { name?: string })?.name ?? 'err'); });
  }

  /** Build the single silent, looping `<audio>` element and route it through the context. */
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
    // Route the element THROUGH the context so the context itself becomes
    // media-backed — this (not a detached element) is what lifts a muted iPhone
    // off the silent-switch-respecting ambient category.
    try {
      this.srcNode = this.ctx.createMediaElementSource(el);
      this.srcNode.connect(this.ctx.destination);
    } catch {
      // createMediaElementSource throws if called twice on an element — ignore.
    }
  }
}
