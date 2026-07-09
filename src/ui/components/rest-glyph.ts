/**
 * Inline SVG for a musical rest, the single source of the rest glyph used by the
 * Song-tab arrangement chip / add-button and the machine-tab rest overlay
 * (arrangement-rest.md). Modeled on `wave-icons.ts`: no inline colour — the
 * strokes use `currentColor` so the surrounding text/accent colour is inherited.
 * A stylised quarter rest (the iconic zigzag + tail) reads as "rest" far more
 * clearly than a whole-rest bar out of staff context.
 */
export function restIcon(): string {
  return (
    `<svg class="rest-glyph" viewBox="0 0 24 24" aria-hidden="true" ` +
    `fill="none" stroke="currentColor" stroke-width="2.4" ` +
    `stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M8 3 L15 9 L9.5 11 L15.5 17"/>` +
    `<path d="M15.5 17 c-3.4 -1.3 -5.7 1.2 -3.1 3.3"/>` +
    `</svg>`
  );
}
