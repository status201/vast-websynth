import { encodeWav } from './recorder/encode';

/**
 * The silent, looping `<audio>` element both platform audio workarounds are
 * built on — extracted so there is one copy of it (see
 * `specs/features/media-session.md` REQ-7).
 *
 * The two callers want the same element for different reasons, and differ in
 * exactly one thing — whether it is routed through the AudioContext:
 *
 *  - **iOS** (`ios-audio-session.ts`) routes it, because feeding a media element
 *    *through* the context is what makes the context itself media-backed and
 *    lifts it off the ring/silent-switch-respecting ambient category.
 *  - **Android** (`media-session.ts`) leaves it detached: there the point is to
 *    give the *page* a media session the OS recognises, and a detached element
 *    keeps that session alive even while the context is suspended.
 */

/** ~0.5 s of silence is plenty for a robust loop without churning the file size. */
const SILENT_SECONDS = 0.5;
const SILENT_RATE = 44100;

export interface SilentLoop {
  el: HTMLAudioElement;
  /** The routing node, or `null` when the element was left detached. */
  src: MediaElementAudioSourceNode | null;
}

/**
 * Build (but do not play) one silent looping element. Pass a context to route it
 * through that context's destination; omit it to leave the element detached.
 * Never throws — a refused `createMediaElementSource` leaves `src` null.
 */
export function createSilentLoop(ctx?: AudioContext): SilentLoop {
  const samples = new Float32Array(Math.round(SILENT_SECONDS * SILENT_RATE));
  const blob = encodeWav(samples, samples, SILENT_RATE);
  const el = new Audio();
  el.src = URL.createObjectURL(blob);
  el.loop = true;
  // `playsInline` is not on the TS `HTMLMediaElement` surface; set the attribute.
  el.setAttribute('playsinline', '');
  el.preload = 'auto';
  if (!ctx) return { el, src: null };
  try {
    const src = ctx.createMediaElementSource(el);
    src.connect(ctx.destination);
    return { el, src };
  } catch {
    // createMediaElementSource throws if called twice on an element — ignore.
    return { el, src: null };
  }
}
