// Generate the committed PWA PNG icons from public/favicon.svg.
//
// Zero image dependencies: rasterizes the SVG in Playwright's bundled
// Chromium (already a devDependency). Run manually and commit the output:
//
//   node scripts/generate-icons.mjs
//
// Outputs (public/):
//   apple-touch-icon.png  180×180, opaque #050302 background (iOS composites
//                         transparent touch icons onto black — bake ours in)
//   icon-192.png          192×192, opaque #050302 (manifest, purpose "any")
//   icon-512.png          512×512, opaque #050302 (manifest, purpose "any")
//
// See specs/features/pwa-install.md (REQ-3).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const svg = readFileSync(publicDir + 'favicon.svg', 'utf-8');

const TARGETS = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
];

const BACKGROUND = '#050302'; // manifest background_color

const browser = await chromium.launch();
try {
  for (const { file, size } of TARGETS) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><html><head><style>
         html, body { margin: 0; padding: 0; background: ${BACKGROUND}; }
         svg { display: block; width: ${size}px; height: ${size}px; }
       </style></head><body>${svg}</body></html>`,
    );
    await page.screenshot({ path: publicDir + file });
    await page.close();
    console.log(`wrote public/${file} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
