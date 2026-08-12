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

  let backdrop: HTMLElement | null = null;
  let refreshDebug: (() => void) | null = null;
  let disposeDebug: (() => void) | null = null;
  let closeTimer: number | undefined;
  let refreshTimer: number | undefined;

  // A dialog stacked on top (the factory-reset confirm) owns Escape: its own
  // capture listener registered later would be starved by this one's
  // stopImmediatePropagation, so yield while any other backdrop is visible.
  const dialogOnTop = (): boolean =>
    [...document.querySelectorAll(`.${Modal.backdropClass}`)]
      .some((el) => el !== backdrop && !el.classList.contains('hidden'));

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
  const onState = () => refreshDebug?.();

  function close(): void {
    if (!backdrop) return;
    window.removeEventListener('keydown', onKey, true);
    engine.ctx.removeEventListener('statechange', onState);
    window.clearInterval(refreshTimer);
    // A test tone still ringing must not outlive the panel (debug-panel REQ-9).
    disposeDebug?.();
    backdrop.classList.add('hidden');
    const el = backdrop;
    closeTimer = window.setTimeout(() => el.remove(), 200);
  }

  async function open(): Promise<void> {
    window.clearTimeout(closeTimer);
    // Awaited before anything is appended, so the modal never renders a
    // half-built card (the ai-prompt.ts precedent). The `backdrop` check sits
    // *after* the await deliberately: two fast clicks both reach here, and
    // checking beforehand would let each build its own card.
    const { buildModal } = await import('./about-modal');
    if (!backdrop) {
      const built = buildModal(close, engine, deps);
      backdrop = built.backdrop;
      refreshDebug = built.refreshDebug;
      disposeDebug = built.disposeDebug;
    }
    document.body.appendChild(backdrop);
    // Force reflow so the opacity transition runs from the .hidden state.
    void backdrop.offsetWidth;
    backdrop.classList.remove('hidden');
    refreshDebug?.();
    window.addEventListener('keydown', onKey, true);
    engine.ctx.addEventListener('statechange', onState);
    // Poll while open so values that change without an event (e.g. the silent
    // loop's currentTime advancing) visibly tick. Cleared in close(), and a
    // no-op whenever the Debug section is collapsed.
    refreshTimer = window.setInterval(() => refreshDebug?.(), 500);
  }

  return btn;
}
