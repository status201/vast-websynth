/**
 * Open the Dropdown at (or inside) `el` if it is not open, and return `el`:
 * option buttons are built on open (dropdown.md
 * REQ-options-are-built-when-the-menu-opens), so a test that looks for an option
 * opens the menu first.
 */
export function openDd<T extends HTMLElement>(el: T): T {
  const dd = el.classList.contains('dropdown') ? el : el.querySelector<HTMLElement>('.dropdown');
  if (dd && !dd.classList.contains('open')) dd.querySelector<HTMLButtonElement>('button')!.click();
  return el;
}
