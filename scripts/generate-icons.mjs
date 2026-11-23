// Generate the committed PWA PNG icons and the social card from public/favicon.svg.
//
// Zero image dependencies: rasterizes the SVG in Playwright's bundled
// Chromium (already a devDependency). Run manually and commit the output:
//
//   node scripts/generate-icons.mjs
//
// Outputs (public/):
//   apple-touch-icon.png   180×180, opaque #050302 background (iOS composites
//                          transparent touch icons onto black — bake ours in)
//   icon-192.png           192×192, opaque #050302 (manifest, purpose "any")
//   icon-512.png           512×512, opaque #050302 (manifest, purpose "any")
//   icon-maskable-512.png  512×512, the icon shrunk into the maskable safe zone
//                          (the central 80% circle) on full-bleed #050302
//   og-card.svg / .png     the social preview card, the icon as its logo and its
//                          type outlined to paths (scripts/lib/og-card.mjs);
//                          2400×1260, transparent corners
//
// See specs/features/pwa-install.md (REQ-apple-touch-icon-is-opaque).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  ogCardSvg, liveText, outlinedText, ogFamily, OG_FONTS, OG_TEXTS, OG_WIDTH, OG_HEIGHT,
} from './lib/og-card.mjs';
import { loadTtf } from './lib/ttf-outline.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const svg = readFileSync(publicDir + 'favicon.svg', 'utf-8');

const BACKGROUND = '#050302'; // manifest background_color

// The icon's art reaches its 48-unit inner square's corners (of 64), so it sits
// inside the safe circle (diameter 0.8) when drawn at 0.8 / (48·√2 / 64) ≈ 0.75
// of the canvas. 0.72 leaves a hair of margin.
const MASKABLE_SCALE = 0.72;

const TARGETS = [
  { file: 'apple-touch-icon.png', size: 180, scale: 1 },
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  { file: 'icon-maskable-512.png', size: 512, scale: MASKABLE_SCALE },
];

/** Font bytes by family and weight, read once. */
function readFonts() {
  const out = {};
  for (const [family, weights] of Object.entries(OG_FONTS)) {
    out[family] = {};
    for (const [weight, path] of Object.entries(weights)) {
      try {
        out[family][weight] = readFileSync(path);
      } catch {
        throw new Error(`og-card: font not found: ${path}`);
      }
    }
  }
  return out;
}

/**
 * Lay the card's type out in Chromium as live text, then outline every glyph at
 * the origin Chromium gave it. Returns the card SVG with paths for text.
 */
async function outlineCard(browser, fonts) {
  const faces = Object.entries(fonts).flatMap(([family, weights]) =>
    Object.entries(weights).map(([weight, bytes]) =>
      `@font-face { font-family: '${ogFamily(family)}'; font-weight: ${weight};
         src: url(data:font/ttf;base64,${bytes.toString('base64')}) format('truetype'); }`));
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${faces.join('\n')}
         text { font-variant-ligatures: none; }
       </style></head><body>${ogCardSvg(svg, liveText)}</body></html>`,
    );
    const layout = await page.evaluate(async (texts) => {
      const out = {};
      for (const t of texts) {
        const spec = `${t.weight} ${t.size}px '${t.familyName}'`;
        await document.fonts.load(spec, t.text);
        if (!document.fonts.check(spec, t.text)) throw new Error(`font did not load: ${spec}`);
        const el = document.getElementById(`og-t-${t.id}`);
        const origins = [];
        for (let i = 0; i < el.getNumberOfChars(); i++) {
          const p = el.getStartPositionOfChar(i);
          origins.push([p.x, p.y]);
        }
        // The natural width, for the fit check: the same line without textLength.
        const probe = el.cloneNode(true);
        probe.removeAttribute('textLength');
        el.parentNode.appendChild(probe);
        out[t.id] = { origins, natural: probe.getComputedTextLength() };
        probe.remove();
      }
      return out;
    }, OG_TEXTS.map((t) => ({ ...t, familyName: ogFamily(t.family) })));

    const ttfs = new Map();
    const ttfOf = (t) => {
      const key = `${t.family}/${t.weight}`;
      if (!ttfs.has(key)) ttfs.set(key, loadTtf(fonts[t.family][t.weight]));
      return ttfs.get(key);
    };
    const paths = new Map();
    for (const t of OG_TEXTS) {
      const { origins, natural } = layout[t.id];
      if (t.textLength && natural > t.textLength) {
        console.warn(`og-card: '${t.text}' is ${natural.toFixed(1)} wide, squeezed into ${t.textLength}; lower its size`);
      }
      const ttf = ttfOf(t);
      const chars = [...t.text];
      if (chars.length !== origins.length) throw new Error(`og-card: '${t.text}' laid out as ${origins.length} glyphs`);
      const d = chars
        .map((ch, i) => (ch === ' ' ? '' : ttf.glyphPath(ttf.glyphOf(ch), origins[i][0], origins[i][1], t.size)))
        .join('');
      paths.set(t.id, d);
    }
    return ogCardSvg(svg, (t) => outlinedText(t, paths.get(t.id)));
  } finally {
    await page.close();
  }
}

/**
 * Throw unless `svg` parses as standalone XML. Inlined in HTML, an SVG forgives
 * what an `.svg` file opened on its own does not (a `--` inside a comment).
 */
async function assertWellFormed(browser, name, svg) {
  const page = await browser.newPage();
  try {
    const error = await page.evaluate((src) => {
      const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
      return doc.querySelector('parsererror')?.textContent ?? null;
    }, svg);
    if (error) throw new Error(`${name} is not well-formed XML: ${error.trim()}`);
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch();
try {
  await assertWellFormed(browser, 'public/favicon.svg', svg);
  const og = await outlineCard(browser, readFonts());
  await assertWellFormed(browser, 'og-card.svg', og);
  writeFileSync(publicDir + 'og-card.svg', og);
  console.log('wrote public/og-card.svg');

  for (const { file, size, scale } of TARGETS) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    const art = Math.round(size * scale);
    await page.setContent(
      `<!doctype html><html><head><style>
         html, body { margin: 0; padding: 0; background: ${BACKGROUND}; }
         body { width: ${size}px; height: ${size}px; display: grid; place-items: center; }
         svg { display: block; width: ${art}px; height: ${art}px; }
       </style></head><body>${svg}</body></html>`,
    );
    await page.screenshot({ path: publicDir + file });
    await page.close();
    console.log(`wrote public/${file} (${size}×${size})`);
  }

  const w = OG_WIDTH * 2;
  const h = OG_HEIGHT * 2;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><head><style>
       html, body { margin: 0; padding: 0; background: transparent; }
       svg { display: block; width: ${w}px; height: ${h}px; }
     </style></head><body>${og}</body></html>`,
  );
  await page.screenshot({ path: publicDir + 'og-card.png', omitBackground: true });
  await page.close();
  console.log(`wrote public/og-card.png (${w}×${h})`);
} finally {
  await browser.close();
}
