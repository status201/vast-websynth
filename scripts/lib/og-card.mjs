// The social preview card (public/og-card.svg → og-card.png), built around the
// app icon so the two can never drift: the card nests public/favicon.svg as its
// logo. Written and rasterized by scripts/generate-icons.mjs.
//
// Every line of type is outlined to paths, so the committed SVG renders the same
// everywhere and needs no font. The lines are data (OG_TEXTS); the generator
// lays each out in Chromium as live text (kerning, textLength spacing), reads
// back where every glyph landed, and draws the glyphs there from the font files
// (scripts/lib/ttf-outline.mjs). Faces: Barlow, a static DIN-style face close
// to the Race theme's Bahnschrift (OFL, committed under scripts/fonts/barlow/),
// and Courier New Bold for the model badge, as in the header (read from the
// Windows font folder).

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const COL = 624; // the right column's left edge: its ink ends as far from the card's right edge as the logo starts from the left
const W = 500; // the right column's width: every line is fitted to it
const BADGE_Y = 272;
const BADGE_W = 236;
const BADGE_H = 74;
const BADGE_MID = BADGE_Y + BADGE_H / 2;
const PRODUCT_SIZE = 44; // WEBSYNTH, beside the badge

const barlow = (file) => fileURLToPath(new URL(`../fonts/barlow/${file}`, import.meta.url));
const winFonts = join(process.env.WINDIR ?? 'C:/Windows', 'Fonts');

/** Font files by family and weight. */
export const OG_FONTS = {
  barlow: {
    300: barlow('Barlow-Light.ttf'),
    400: barlow('Barlow-Regular.ttf'),
    600: barlow('Barlow-SemiBold.ttf'),
    700: barlow('Barlow-Bold.ttf'),
  },
  courier: { 700: join(winFonts, 'courbd.ttf') },
};

/** The card's lines of type. */
export const OG_TEXTS = [
  // the name, tracked like the header's .brandName
  { id: 'name', text: 'VAST', x: COL - 6, y: 236, family: 'barlow', weight: 700, size: 188,
    textLength: W + 6, fill: '#f4cd5e', filter: 'og-glowGold' },
  // model badge (its box is drawn by ogCardSvg)
  { id: 'model', text: 'G1-J8', x: COL + 118, y: 324, anchor: 'middle', family: 'courier', weight: 700,
    size: 46, letterSpacing: 5, fill: '#e8742e', filter: 'og-glowOrange' },
  // the product name, filling the rest of the badge row; caps centred on the box
  // (Barlow's cap height is 0.7 em, so the baseline sits 0.35 em below the middle)
  { id: 'product', text: 'WEBSYNTH', x: COL + BADGE_W + 24, y: BADGE_MID + 0.35 * PRODUCT_SIZE,
    family: 'barlow', weight: 600, size: PRODUCT_SIZE, textLength: W - BADGE_W - 24, fill: '#e8d8b6' },
  { id: 'tagline', text: 'VAST AUDIO SYNTHESIS TECHNOLOGY', x: COL, y: 404, family: 'barlow', weight: 400,
    size: 27, textLength: W, fill: '#b8a27a' },
  // what's inside
  { id: 'features', text: 'SYNTH · DRUMS · SAMPLER · SEQUENCER', x: COL, y: 484, family: 'barlow', weight: 600,
    size: 25, textLength: W, fill: '#e8742e' },
  // the pitch
  { id: 'pitch', text: 'Free in-browser polyphonic synthesizer', x: COL, y: 548, family: 'barlow', weight: 300,
    size: 29.5, textLength: W, fill: '#e8d8b6' },
];

/** The CSS family name a layout pass registers `family` under. */
export const ogFamily = (family) => `og-${family}`;

/** A line as live SVG text, for the layout pass. */
export function liveText(t) {
  const attrs = [
    `id="og-t-${t.id}"`, `x="${t.x}"`, `y="${t.y}"`,
    `font-family="${ogFamily(t.family)}"`, `font-weight="${t.weight}"`, `font-size="${t.size}"`,
    t.anchor ? `text-anchor="${t.anchor}"` : '',
    t.letterSpacing ? `letter-spacing="${t.letterSpacing}"` : '',
    t.textLength ? `textLength="${t.textLength}" lengthAdjust="spacing"` : '',
  ].filter(Boolean);
  return `<text ${attrs.join(' ')}>${xmlEscape(t.text)}</text>`;
}

/** A line as one outlined path, from path data the generator built. */
export function outlinedText(t, d) {
  const filter = t.filter ? ` filter="url(#${t.filter})"` : '';
  return `<path aria-label="${xmlEscape(t.text)}" fill="${t.fill}"${filter}\n        d="${d}"/>`;
}

/** `s` safe as XML text or a double-quoted attribute value. */
const xmlEscape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The inner markup of an `<svg>` document, minus its comments. Stripped to a
 * fixed point, since one pass can splice a new `<!--` out of the pieces it
 * leaves (`<!<!---->--`); one still left is unterminated, and that throws.
 */
function innerOf(svg) {
  let s = svg.replace(/\r\n/g, '\n');
  for (let prev = ''; s !== prev; ) {
    prev = s;
    s = s.replace(/<!--[\s\S]*?-->\n?/g, '');
  }
  if (s.includes('<!--')) throw new Error('og-card: unterminated <!-- comment in the icon SVG');
  return s.slice(s.indexOf('>', s.indexOf('<svg')) + 1, s.lastIndexOf('</svg>')).trim();
}

/**
 * The og-card SVG document, with `iconSvg` (public/favicon.svg) as its logo and
 * each of OG_TEXTS drawn by `drawText(t)`.
 */
export function ogCardSvg(iconSvg, drawText) {
  const icon = innerOf(iconSvg).replace(/\n/g, '\n      ');
  const text = (id) => drawText(OG_TEXTS.find((t) => t.id === id));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}" width="${OG_WIDTH * 2}" height="${OG_HEIGHT * 2}">
  <!-- Generated by scripts/generate-icons.mjs from scripts/lib/og-card.mjs and
       public/favicon.svg. Edit those, not this file. -->
  <defs>
    <!-- warm panel vignette (the app's Classic panel and background colours) -->
    <radialGradient id="og-panel" cx="38%" cy="32%" r="85%">
      <stop offset="0%" stop-color="#2c2620"/>
      <stop offset="48%" stop-color="#1a1612"/>
      <stop offset="100%" stop-color="#0b0805"/>
    </radialGradient>
    <linearGradient id="og-wood" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#2a1808"/>
      <stop offset="35%" stop-color="#6b3e1f"/>
      <stop offset="70%" stop-color="#3a2010"/>
      <stop offset="100%" stop-color="#2a1808"/>
    </linearGradient>
    <radialGradient id="og-pool" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(232,116,46,0.22)"/>
      <stop offset="100%" stop-color="rgba(232,116,46,0)"/>
    </radialGradient>
    <filter id="og-glowGold" x="-10%" y="-30%" width="120%" height="160%">
      <feGaussianBlur stdDeviation="5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="og-glowOrange" x="-20%" y="-40%" width="140%" height="180%">
      <feGaussianBlur stdDeviation="3" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="og-shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity="0.65"/>
    </filter>
    <clipPath id="og-panelClip">
      <rect x="4" y="4" width="1192" height="622" rx="38"/>
    </clipPath>
  </defs>

  <!-- panel (rounded corners stay transparent) -->
  <g clip-path="url(#og-panelClip)">
    <rect x="4" y="4" width="1192" height="622" fill="url(#og-panel)"/>
    <!-- wood side cheeks -->
    <rect x="4" y="4" width="34" height="622" fill="url(#og-wood)" opacity="0.9"/>
    <rect x="1162" y="4" width="34" height="622" fill="url(#og-wood)" opacity="0.9"/>
  </g>
  <rect x="4" y="4" width="1192" height="622" rx="38" fill="none" stroke="#5d4628" stroke-width="5"/>
  <rect x="11" y="11" width="1178" height="608" rx="31" fill="none" stroke="rgba(244,205,94,0.10)" stroke-width="2"/>

  <!-- ============ LOGO (left): public/favicon.svg at 7.5x ============ -->
  <ellipse cx="315" cy="315" rx="300" ry="300" fill="url(#og-pool)"/>
  <g filter="url(#og-shadow)">
    <svg x="75" y="75" width="480" height="480" viewBox="0 0 64 64">
      ${icon}
    </svg>
  </g>

  <!-- ============ WORDMARK (right) ============ -->
  <!-- the name -->
  ${text('name')}

  <!-- model badge -->
  <rect x="${COL}" y="${BADGE_Y}" width="${BADGE_W}" height="${BADGE_H}" rx="8" fill="rgba(5,3,2,0.55)"
        stroke="rgba(232,116,46,0.55)" stroke-width="2.5"/>
  ${text('model')}
  ${text('product')}

  <!-- tagline -->
  ${text('tagline')}

  <line x1="${COL}" y1="436" x2="${COL + W}" y2="436" stroke="rgba(244,205,94,0.18)" stroke-width="2"/>

  <!-- what's inside -->
  ${text('features')}

  <!-- the pitch -->
  ${text('pitch')}
</svg>
`;
}
