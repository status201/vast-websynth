import { createButton, setButtonIcon } from './button';
import { HEADER_ICONS } from './header-icons';

/**
 * Header fullscreen toggle (specs/features/pwa-install.md REQ-2).
 *
 * Returns `null` when the Fullscreen API is unavailable (iPhone Safari) —
 * the caller simply doesn't render the button. State follows the real
 * `fullscreenchange` event (covers Escape and F11 exits, not just clicks),
 * and request/exit rejections are swallowed: fullscreen is a nicety, never
 * an error surface.
 */
export function createFullscreenButton(doc: Document = document): HTMLButtonElement | null {
  if (!doc.fullscreenEnabled) return null;

  const btn = createButton({
    label: 'Toggle fullscreen',
    icon: HEADER_ICONS.expand,
    title: 'Toggle fullscreen',
    testId: 'fullscreen',
    onClick: () => {
      if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {});
      else void doc.documentElement.requestFullscreen().catch(() => {});
    },
  });

  doc.addEventListener('fullscreenchange', () => {
    const on = !!doc.fullscreenElement;
    btn.classList.toggle('on', on);
    setButtonIcon(btn, on ? HEADER_ICONS.compress : HEADER_ICONS.expand);
  });

  return btn;
}
