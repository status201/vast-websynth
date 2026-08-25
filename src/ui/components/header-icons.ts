/**
 * Inline SVG glyphs for the header's utility icon buttons
 * (specs/features/responsive-header.md REQ-5). Modeled on `wave-icons.ts`:
 * no inline colour — stroke/fill come from CSS `currentColor`
 * (`switch.module.css` styles `svg.hdr-icon`), so state classes like the
 * Perf button's tier colours tint the glyph automatically. Solid shapes
 * (the ⓘ dot, the ? dot) opt out of the stroke style via `class="fill"`.
 */
import { INFO_SHAPE } from './ui-icons';

const icon = (inner: string): string =>
  `<svg class="hdr-icon" viewBox="0 0 16 16" aria-hidden="true">${inner}</svg>`;

export const HEADER_ICONS = {
  /** Floppy disk — Save preset. */
  save: icon(
    '<path d="M3 2 H10.5 L13 4.5 V13 A1 1 0 0 1 12 14 H4 A1 1 0 0 1 3 13 Z"/>' +
    '<path d="M5.5 2 V5.5 H10 V2"/>' +
    '<path d="M5 14 V9.5 H11 V14"/>',
  ),
  /** Gauge / speedometer — Performance settings. */
  perf: icon(
    '<path d="M2.5 11.5 A6 6 0 1 1 13.5 11.5"/>' +
    '<path d="M8 11 L11.2 6.2"/>' +
    '<circle class="fill" cx="8" cy="11" r="1.2"/>',
  ),
  /**
   * ⓘ — the info-badges toggle. Same glyph the badges themselves draw, and
   * while they are showing it takes their colours too: `tour.module.css` fills
   * `.disc` with the accent and inks `.stem`/`.dot` in `--bg-deep`
   * (onboarding.md REQ-8b). The part classes are inert until then — no colour
   * is declared here, as for every other glyph.
   */
  info: icon(INFO_SHAPE),
  /** ? in a circle — Help & About. */
  help: icon(
    '<circle cx="8" cy="8" r="6"/>' +
    '<path d="M6.3 6.6 A1.8 1.8 0 1 1 8.6 8.4 C8.1 8.7 8 9 8 9.6"/>' +
    '<circle class="fill" cx="8" cy="11.4" r="1"/>',
  ),
  /** Expand corners — enter fullscreen. */
  expand: icon(
    '<path d="M6 2 H2 V6"/><path d="M10 2 H14 V6"/>' +
    '<path d="M14 10 V14 H10"/><path d="M2 10 V14 H6"/>',
  ),
  /** Compress corners — exit fullscreen. */
  compress: icon(
    '<path d="M2 6 H6 V2"/><path d="M14 6 H10 V2"/>' +
    '<path d="M10 14 V10 H14"/><path d="M6 14 V10 H2"/>',
  ),
} as const;
