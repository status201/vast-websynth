import { isAndroid } from '../platform/android';
import { createSilentLoop } from './silent-loop';

/**
 * Media Session keep-alive — Android only. See `specs/features/media-session.md`.
 *
 * Chrome/Android protects a page it recognises as a **media player**: audio
 * focus, a notification, and exemption from the CPU/renderer throttling a
 * backgrounded page otherwise gets. A page that makes sound purely through Web
 * Audio is not one — there is no media element, so no media session — so with
 * the screen off the renderer is throttled, the audio callback misses its
 * deadlines and the output crackles (reported on a Pixel 8a; a Samsung tablet
 * with different power management never reaches it).
 *
 * So: a silent looping `<audio>` element creates the session, and
 * `navigator.mediaSession` turns it into a real player with a name, artwork and
 * working controls. The element is **detached** (unlike the iOS one, which is
 * routed through the context to change the *context's* category) — a detached
 * element keeps the session alive even while the context is suspended, which is
 * precisely when it must persist.
 *
 * Everything here is best-effort: a browser that refuses playback or an action
 * handler must never cost the synth its audio, so nothing throws out.
 */

/** What the OS's transport controls drive (see media-session.md REQ-4). */
export interface MediaSessionHandlers {
  /** Notification "play": resume the context and start the transport. */
  play(): void;
  /** Notification "pause": panic — stop the transport, silence every voice. */
  pause(): void;
  /** Notification "stop": same as pause. */
  stop(): void;
}

/** On-device diagnostics, surfaced by the Debug panel (see `debug-panel.md`). */
export interface MediaSessionDiagnostics {
  /** True on Android with the API present — i.e. whether this is engaged at all. */
  active: boolean;
  /** Loop lifecycle: 'n/a' | 'idle' | 'starting' | 'playing' | 'blocked: <name>'. */
  status: string;
  /** The session's `playbackState`, or 'n/a'. */
  playbackState: string;
  /** How many action handlers the browser accepted (3 when all took). */
  handlers: number;
  /** Keep-alive element `paused` state, or null before it is built. */
  paused: boolean | null;
  /** Keep-alive element `currentTime` (advances while playing), or null. */
  currentTime: number | null;
}

const TITLE = 'VAST G1-J8';
const ARTIST = 'Vast Audio Synthesis Technology';

export class MediaSessionKeepAlive {
  /** Resolved once: Android with a Media Session API gets the keep-alive. */
  readonly active =
    isAndroid() && typeof navigator !== 'undefined' && !!navigator.mediaSession;

  private el: HTMLAudioElement | null = null;
  private status: string = this.active ? 'idle' : 'n/a';
  private handlers = 0;

  constructor(private readonly actions: MediaSessionHandlers) {}

  /**
   * Start the keep-alive: play the silent loop (which is what creates the
   * session) and describe the player to the OS. Must be called from within a
   * user gesture, alongside `AudioContext.resume()`. No-op off Android; safe to
   * call repeatedly — the element and the handlers are set up once.
   */
  unlock(): void {
    if (!this.active) return;
    if (!this.el) {
      // Detached: no context passed. See the class comment.
      this.el = createSilentLoop().el;
      this.describe();
      this.bindActions();
    }
    this.play();
    this.setState('playing');
  }

  /** Replay the loop if the OS paused it (foreground return). No-op before unlock. */
  rearm(): void {
    if (!this.active || !this.el) return;
    this.play();
  }

  get diagnostics(): MediaSessionDiagnostics {
    return {
      active: this.active,
      status: this.status,
      playbackState: this.active ? (navigator.mediaSession?.playbackState ?? 'n/a') : 'n/a',
      handlers: this.handlers,
      paused: this.el ? this.el.paused : null,
      currentTime: this.el ? this.el.currentTime : null,
    };
  }

  /** Play the keep-alive loop, recording the outcome for the Debug panel. */
  private play(): void {
    if (!this.el) return;
    this.status = 'starting';
    this.el.play()
      .then(() => { this.status = 'playing'; })
      .catch((e: unknown) => { this.status = 'blocked: ' + ((e as { name?: string })?.name ?? 'err'); });
  }

  /** Name the player in the notification / lock screen. */
  private describe(): void {
    // MediaMetadata is absent in jsdom and older browsers; a missing
    // notification must not cost us the session, let alone the audio.
    if (typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession!.metadata = new MediaMetadata({
        title: TITLE,
        artist: ARTIST,
        artwork: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
    } catch { /* metadata is decoration — never fatal */ }
  }

  /**
   * Wire the OS transport controls. `pause` in particular is not optional: with
   * no handler, Android's pause button pauses our own keep-alive element and
   * takes the session with it.
   */
  private bindActions(): void {
    const bind = (action: MediaSessionAction, fn: () => void): void => {
      try {
        navigator.mediaSession!.setActionHandler(action, fn);
        this.handlers++;
      } catch { /* an action this browser does not support — skip it */ }
    };
    bind('play', () => { this.actions.play(); this.setState('playing'); });
    bind('pause', () => { this.actions.pause(); this.setState('paused'); });
    bind('stop', () => { this.actions.stop(); this.setState('paused'); });
  }

  /**
   * Report the *audio session's* state, not the transport's (REQ-5): this is an
   * instrument, so the keyboard makes sound with the transport stopped —
   * 'paused' would be a lie, and Android treats a paused session as a candidate
   * for teardown, which is the failure this class exists to prevent.
   */
  private setState(state: MediaSessionPlaybackState): void {
    try {
      navigator.mediaSession!.playbackState = state;
    } catch { /* older implementations expose the object but not the setter */ }
  }
}
