/**
 * The two rules every `position: fixed` menu on `dropdown.module.css` shares
 * (dropdown.md REQ-every-fixed-menu-shares-one-anchor-and-dismiss). Written out
 * four times before, and two of the copies let Escape through to Panic.
 */

/**
 * What a fixed `.menu`'s `min-width: 100%` becomes. For a fixed box that 100%
 * is the viewport, so it must always be answered: `'toggle'` pins it to the
 * toggle's width, `'content'` releases it to the menu's own.
 */
export type MenuWidth = 'toggle' | 'content';

/** Anchor a fixed menu under its toggle, flipped above near the bottom edge. */
export function anchorMenu(toggle: HTMLElement, menu: HTMLElement, width: MenuWidth): void {
  const r = toggle.getBoundingClientRect();
  const s = menu.style;
  s.minWidth = width === 'toggle' ? `${r.width}px` : '0px';
  s.left = `${r.left}px`;
  const mh = menu.offsetHeight; // measurable: the caller has already shown it
  const flipUp = r.bottom + 6 + mh > window.innerHeight && r.top - 6 - mh > 0;
  s.top = `${flipUp ? r.top - 6 - mh : r.bottom + 6}px`;
}

/**
 * Close an open menu on an outside click or on Escape. The Escape is consumed:
 * on the window it is Panic, and closing a menu must not stop the song
 * (dropdown.md REQ-the-menu-closes-on-outside-click). A closed menu lets both through.
 *
 * `inside` names triggers that live outside `root` but are part of the control
 * (the FX slot's title). A click on one is not an outside click, so the trigger
 * need not stop its click to keep its own menu open, and other menus still
 * hear it and close.
 */
export function dismissMenu(
  root: HTMLElement,
  isOpen: () => boolean,
  close: () => void,
  inside: readonly HTMLElement[] = [],
): void {
  document.addEventListener('click', (e) => {
    const t = e.target as Node;
    if (isOpen() && !root.contains(t) && !inside.some((el) => el.contains(t))) close();
  });
  document.addEventListener('keydown', (e) => {
    if (!isOpen() || e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  });
}
