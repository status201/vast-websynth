// The header's "?" button and the open/close lifecycle of the About modal
// behind it. Since v15 this is the app's single help door (onboarding.md
// REQ-20) — the ⓘ button beside it does one thing only, toggle the badges.
// Hence the ? glyph: the tour and the shortcut list are help, not credits.
//
// This module is the *only* part of About on the boot path. The card itself is
// ~39 kB that most visitors never open, so `open` imports it on the click
// (runtime-performance.md REQ-1). Keeping the factory here rather than in
// `about-modal.ts` is the point: importing a factory eagerly to reach a lazy
// body would put the body back in the entry chunk. The Debug section's
// late-bound row sources live in `state/debug-sources.ts` for the same reason.
import { Modal } from './modal';
import { createButton } from './button';
import { HEADER_ICONS } from './header-icons';
import { showLazyLoadFailure } from './lazy-load-toast';
import type { StudioApi } from '../studio-api';

/** What the modal needs from the onboarding layer, injected so About never
 *  imports it (onboarding.md REQ-20, the same rule the tour's `TourCtx` follows).
 *  Declared here rather than in `about-modal.ts` so that module can take it
 *  type-only — a value import back would close a cycle at runtime. */
export interface AboutDeps {
  startTour: () => void;
}

export function createAboutButton(engine: StudioApi, deps: AboutDeps): HTMLButtonElement {
  // `open` is a hoisted function declaration, so wiring it here is safe.
  const btn = createButton({
    label: 'Help & About',
    icon: HEADER_ICONS.help,
    title: 'Help & About',
    testId: 'about-button',
    onClick: () => void open(),
  });

  // The card, built on the first open and reused after — one reference rather
  // than a parallel `let` per hook it hands back.
  let card: ReturnType<typeof import('./about-modal').buildModal> | null = null;
  let closeTimer: number | undefined;
  let refreshTimer: number | undefined;

  // A dialog stacked on top (the factory-reset confirm) owns Escape: its own
  // capture listener registered later would be starved by this one's
  // stopImmediatePropagation, so yield while any other backdrop is visible.
  const dialogOnTop = (): boolean =>
    [...document.querySelectorAll(`.${Modal.backdropClass}`)]
      .some((el) => el !== card?.backdrop && !el.classList.contains('hidden'));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !dialogOnTop()) {
      // Beat the global Escape→panic handler in shortcuts.ts.
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  };

  // Keep the live Debug readout current only while the modal is open — and,
  // inside it, only while the section is expanded (the hook is a gated tick).
  const onState = () => card?.refreshDebug();

  function close(): void {
    if (!card) return;
    window.removeEventListener('keydown', onKey, true);
    engine.ctx.removeEventListener('statechange', onState);
    window.clearInterval(refreshTimer);
    // A test tone still ringing must not outlive the panel (debug-panel REQ-9).
    card.disposeDebug();
    card.backdrop.classList.add('hidden');
    const el = card.backdrop;
    closeTimer = window.setTimeout(() => el.remove(), 200);
  }

  async function open(): Promise<void> {
    window.clearTimeout(closeTimer);
    // Awaited before anything is appended, so the modal never renders a
    // half-built card (the ai-prompt.ts precedent). The `card` check sits
    // *after* the await deliberately: two fast clicks both reach here, and
    // checking beforehand would let each build its own card.
    //
    // The catch is REQ-24: this is the app's single help door, so a rejected
    // import must say so rather than leave the ? button looking dead. `main.ts`
    // warms this chunk on idle to keep the case rare offline (pwa-install.md
    // REQ-6), but a first visit that lost the network before idle has nothing
    // cached — hence the retry, which is a real one since nothing is memoized.
    let buildModal: typeof import('./about-modal').buildModal;
    try {
      ({ buildModal } = await import('./about-modal'));
    } catch {
      showLazyLoadFailure('Help & About', () => void open());
      return;
    }
    card ??= buildModal(close, engine, deps);
    const { backdrop } = card;
    document.body.appendChild(backdrop);
    // Force reflow so the opacity transition runs from the .hidden state.
    void backdrop.offsetWidth;
    backdrop.classList.remove('hidden');
    card.refreshDebug();
    // What this device holds offline — once per open, never at boot and never
    // in the poll below: it reads the cache (play-offline.md REQ-4).
    card.refreshOffline();
    window.addEventListener('keydown', onKey, true);
    engine.ctx.addEventListener('statechange', onState);
    // Poll while open so values that change without an event (e.g. the silent
    // loop's currentTime advancing) visibly tick. Cleared in close(), and a
    // no-op whenever the Debug section is collapsed.
    refreshTimer = window.setInterval(() => card?.refreshDebug(), 500);
  }

  return btn;
}
