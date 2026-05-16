/**
 * Inline SVG glyphs for the waveform selectors, parallel to
 * `WAVE_LABELS` (`['sine','triangle','saw','square']`) in `state/params.ts`.
 * No inline stroke/fill — colour comes from CSS `currentColor` so the
 * `.segmented button.active` gold + glow is inherited automatically.
 */
const icon = (path: string): string =>
  `<svg class="wave-icon" viewBox="0 0 28 16" aria-hidden="true">` +
  `<path d="${path}"/></svg>`;

export const WAVE_ICONS: string[] = [
  icon('M2 8 C 6 1, 10 1, 14 8 S 22 15, 26 8'),       // sine
  icon('M2 13 L8 3 L14 13 L20 3 L26 13'),             // triangle
  icon('M3 13 L13 3 L13 13 L23 3 L23 13'),            // saw
  icon('M2 13 L2 3 L9 3 L9 13 L16 13 L16 3 L23 3 L23 13 L26 13'), // square
];
