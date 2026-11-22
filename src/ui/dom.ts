/**
 * The one-line element factory the UI's hand-built surfaces share
 * (shared-helpers.md): a tag, an optional class string and optional *text*.
 * Text goes in as `textContent`, never markup, so a caller can hand it a song
 * or preset name without escaping anything. CSS-free on purpose — importing it
 * pulls in no stylesheet.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
