/**
 * The Rickroll easter egg (rickroll-easter-egg.md). Play the opening of the
 * "Never gonna give you up" hook on the instrument and it offers to play the
 * song. Hidden on purpose: nothing in the UI or the help points at it.
 *
 * It only ever *offers* (REQ-a-match-offers-never-loads). The load goes through
 * the demo button's own door, so the Undo toast comes with it.
 */
import type { ParamBus } from '../../state/params';
import { createTuneMatcher, HOOK_INTERVALS, HOOK_MAX_GAP_MS } from '../../state/tune-matcher';
import { showToast, isToastShowing } from '../components/toast';

/** The demo the egg plays. A name, so a rename of the file disarms it (REQ-the-egg-is-inert-without-its-demo). */
export const EGG_DEMO = 'Rickroll';

export interface EasterEggDeps {
  bus: ParamBus;
  /** `SongPanel.loadDemo`: the demo button's door. */
  loadDemo: (name: string) => Promise<void>;
  /** `SongPanel.loadedDemo`. */
  loadedDemo: () => string | null;
  isPlaying: () => boolean;
  /** `bridge.toggleTransport`; only ever called while stopped. */
  startTransport: () => void;
  demoNames: () => string[];
  now?: () => number;
}

/** Install the egg. Returns an uninstall (for tests). */
export function installEasterEgg(deps: EasterEggDeps): () => void {
  const now = deps.now ?? (() => performance.now());
  const matcher = createTuneMatcher(HOOK_INTERVALS, HOOK_MAX_GAP_MS);
  // An offer closed without Play it silences the egg until reload
  // (REQ-an-offer-not-taken-silences-the-egg). Module state, never persisted.
  let silenced = false;

  const offer = (): void => {
    let taken = false;
    showToast({
      message: 'Never gonna give you up…',
      actionLabel: 'Play it',
      testId: 'easter-egg-toast',
      onAction: () => {
        taken = true;
        void play();
      },
    }).onDismiss(() => {
      if (!taken) silenced = true;
    });
  };

  // REQ-the-offer-plays-through-the-demo-door: the shared loader, then Play only
  // if the demo really landed (a cancelled shadow question or a failed fetch
  // leaves something else loaded) and the transport is stopped. A running
  // transport already sits on bar 1 after the load.
  const play = async (): Promise<void> => {
    await deps.loadDemo(EGG_DEMO);
    if (deps.loadedDemo() === EGG_DEMO && !deps.isPlaying()) deps.startTransport();
  };

  // REQ-only-human-notes-count: the bus note channel carries only the keyboard,
  // QWERTY and MIDI in; the sequencer and the arp never feed it.
  return deps.bus.onNote((on, note) => {
    if (!on || silenced) return;
    if (!matcher.feed(note, now())) return;
    if (!deps.demoNames().includes(EGG_DEMO)) return;   // REQ-the-egg-is-inert-without-its-demo
    if (deps.loadedDemo() === EGG_DEMO) return;          // REQ-the-egg-is-quiet-over-its-own-song
    if (isToastShowing()) return;                        // REQ-the-egg-never-takes-a-toast
    offer();
  });
}
