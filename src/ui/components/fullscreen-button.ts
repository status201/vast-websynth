import { createButton, setButtonIcon } from './button';
import { HEADER_ICONS } from './header-icons';
import tourStyles from '../styles/tour.module.css';

/**
 * Header fullscreen toggle (specs/features/pwa-install.md REQ-manifest-and-button-drive-fullscreen).
 *
 * Returns `null` when the Fullscreen API is unavailable (iPhone Safari) —
 * the caller simply doesn't render the button. "Fullscreen" is the element
 * kind (`fullscreenElement`) **or** the window kind (`display-mode:
 * fullscreen` — an installed app the manifest launched fullscreen, or F11),
 * which the element never sees. State syncs at creation and on every signal
 * either kind sends, and request/exit rejections are swallowed: fullscreen is
 * a nicety, never an error surface.
 */
export function createFullscreenButton(doc: Document = document): HTMLButtonElement | null {
  if (!doc.fullscreenEnabled) return null;

  // Absent in jsdom and old engines — then only the element kind counts.
  const displayMode = doc.defaultView?.matchMedia?.('(display-mode: fullscreen)');
  const isFullscreen = (): boolean => !!doc.fullscreenElement || !!displayMode?.matches;

  const exitWindowFullscreen = async (): Promise<void> => {
    // Window-level fullscreen has no element for script to exit; entering
    // element fullscreen and leaving it again drops the window kind too
    // (the two taps Android needed, as one).
    await doc.documentElement.requestFullscreen();
    await doc.exitFullscreen();
  };

  const btn = createButton({
    label: 'Toggle fullscreen',
    icon: HEADER_ICONS.expand,
    title: 'Toggle fullscreen',
    testId: 'fullscreen',
    onClick: () => {
      if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {});
      else if (displayMode?.matches) void exitWindowFullscreen().catch(() => {});
      else void doc.documentElement.requestFullscreen().catch(() => {});
    },
  });

  let shown: boolean | null = null;
  const sync = (): void => {
    const on = isFullscreen();
    if (on === shown) return;
    shown = on;
    btn.classList.toggle('on', on);
    // Light the button orange while fullscreen is engaged — the same active
    // treatment the ⓘ info-badges button gets while the badges are showing.
    btn.classList.toggle(tourStyles.toggleActive!, on);
    btn.setAttribute('aria-pressed', String(on));
    setButtonIcon(btn, on ? HEADER_ICONS.compress : HEADER_ICONS.expand);
  };

  sync();
  doc.addEventListener('fullscreenchange', sync);
  displayMode?.addEventListener?.('change', sync);
  // Fallback for an engine that doesn't fire the query's `change` on F11 —
  // the window always resizes then, and an unchanged sync writes nothing.
  doc.defaultView?.addEventListener('resize', sync);

  return btn;
}
