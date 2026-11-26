// Retake the README screenshots from the running app.
//
// Drives the dev server in Playwright's bundled Chromium (headless, so no
// scrollbars) at 1920×1080, DPR 1. Run manually and commit the output:
//
//   node scripts/readme-screenshots.mjs [--demo <name>] [--bar <n>] [--url <app url>]
//                                       [--only <shot,shot>]
//
// --only takes shot names (hero, machines, eq, pastel, motion, help) and retakes just
// those, so adding one shot does not churn every committed PNG.
//
// Outputs (public/), each 1920×1080. Every shot pins its theme: the app's
// default look follows the system (Auto), and a retake must not change look
// because a default did (ui-themes.md).
//   vast-websynth.png               Classic: the demo playing, pattern row folded,
//                                   scope on Wave caught at a full swing, keys lit
//                                   by the notes
//   vast-websynth-drum-machine.png  Vibrant: stopped at --bar, Drum Machine tab,
//                                   with the Transport (widened to the whole song),
//                                   Live FX and XY pad windows open
//   vast-websynth-song-tab.png      Race: the same, on the Song tab
//   vast-websynth-eq-scope.png      Dark at 67% UI scale: the demo playing,
//                                   machines folded, the scope at its full height
//                                   on Spectrum, and the EQUALIZER unfolded on its
//                                   Sequencer tab
//   vast-websynth-theme-pastel.png  Pastel: Bunk playing, FX open, the Sequencer
//                                   tab following the playhead
//   vast-websynth-motion-machine.png Light: Gankogui stopped at bar 1, FX folded,
//                                   the Motion tab with its XY pad and A/B lanes
//   vast-websynth-help-badges.png   Race: Bunk stopped, FX folded, the Sequencer
//                                   tab, info badges on and AMP ENV's help open
//
// Framing is judged by eye — look at every shot before committing it.

import { statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startDevServer, bootApp } from './lib/bench-app.mjs';
import { flag } from './lib/cli.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = root + 'public/';
const PORT = 5191;

const DEMO = flag('demo', 'Nocturne');
/** The Pastel and help shots load their own demo: busy on every lane. */
const THEME_DEMO = 'Bunk';
/** The Motion shot's demo: its bar-1 bank fills the XY pad and two lanes. */
const MOTION_DEMO = 'Gankogui';
const ONLY = flag('only', null)?.split(',');
const wanted = (name) => !ONLY || ONLY.includes(name);
const BAR = Number(flag('bar', '9'));

const VIEWPORT = { width: 1920, height: 1080 };
/** Where the machine panel's bottom edge sits in the two scrolled shots. */
const PANEL_BOTTOM_Y = 1068;
/** Top-left of each floating window in the two scrolled shots. The XY pad is
 *  placed by its right edge, so it hugs the panel's right side at any width.
 *  TRANSPORT is widened until its bar strip shows the whole song, and LIVE FX
 *  then follows its right edge, so a longer or shorter demo reflows the row. */
const WINDOWS = [
  { testId: 'transport-window', left: 36, top: 202, fitStrip: true },
  { testId: 'livefx-window', after: 'transport-window', gap: 8, top: 205 },
  { testId: 'xypad-window', right: 1885, top: 155 },
];

// ------------------------------------------------------------- dev server

const urlFlag = flag('url', null);
const server = urlFlag ? null : await startDevServer({ root, port: PORT, tag: 'readme-screenshots' });
const url = urlFlag ?? server.url;

// ------------------------------------------------------------------ steps

/** A booted page with the demo loaded, the pattern row open on the Song tab.
 *  `prefs` are extra workspace entries seeded into storage before boot; the
 *  theme is Dark unless they say otherwise. */
async function openApp(browser, prefs = {}, demo = DEMO) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  // The bench boot, with Performance mode off, the pattern row open and the
  // Dark theme unless `prefs` say otherwise.
  await bootApp(page, url, {
    tier: 'off',
    storage: { 'websynth.ui.collapsed.pattern': '0', 'websynth.ui.theme': 'dark', ...prefs },
  });

  await page.getByTestId('tab-song').click();
  const btn = page.getByTestId(`song-demo-${demo}`);
  if (await btn.count() === 0) throw new Error(`no demo named "${demo}" (check the Song panel's Demos row)`);
  if (!(await btn.isVisible())) await page.getByTestId('song-demo-more').click();
  await btn.click();
  await page.locator(`[data-testid="demo-loaded-info"][aria-label="About ${demo}"]`)
    .waitFor({ state: 'attached', timeout: 30_000 });

  // Leave the page as a visitor would see it: the demo row folded again, and
  // no "Loaded …" toast over the keyboard.
  const more = page.getByTestId('song-demo-more');
  if (await more.count() > 0 && (await more.textContent())?.trim() === 'Less') await more.click();
  // The toast lands a beat after the song does, so wait for it rather than look.
  await page.getByTestId('toast-dismiss').click({ timeout: 5000 }).catch(() => {});
  return page;
}

/** The body is the page's scroller, not the window (see e2e page-scrollbar.spec.ts). */
const scrollTo = (page, y) => page.evaluate((top) => {
  for (const el of [document.scrollingElement, document.documentElement, document.body]) {
    if (el) el.scrollTop = Math.max(0, top);
  }
}, y);

/** Scroll so `testId`'s bottom edge lands on `viewportY`. */
async function scrollBottomTo(page, testId, viewportY) {
  const delta = await page.getByTestId(testId).evaluate((el) => el.getBoundingClientRect().bottom);
  const now = await page.evaluate(() => document.body.scrollTop || document.documentElement.scrollTop);
  await scrollTo(page, now + delta - viewportY);
}

/** Drag a floating window by its title bar so its corner lands on the target. */
async function placeWindow(page, { testId, left, right, after, gap = 0, top }) {
  const win = page.getByTestId(testId);
  await win.waitFor({ state: 'visible' });
  const box = await win.boundingBox();
  const bar = await win.locator(':scope > :first-child').boundingBox();
  if (!box || !bar) throw new Error(`${testId} has no bounding box`);
  let targetLeft = left ?? right - box.width;
  if (after) {
    const prev = await page.getByTestId(after).boundingBox();
    if (!prev) throw new Error(`${after} has no bounding box`);
    targetLeft = prev.x + prev.width + gap;
  }
  // Grab the bar's middle — clear of the − and × buttons at its ends. Each
  // window is placed as soon as it opens, before the next can cover its bar.
  const x = bar.x + bar.width / 2;
  const y = bar.y + bar.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + targetLeft - box.x, y + top - box.y, { steps: 8 });
  await page.mouse.up();
}

/**
 * Widen a resizable window until its bar strip shows every bar: drag its grip
 * well past the end, and the grip's live bounds clamp it to exactly "controls +
 * whole strip" (transport-window.md REQ-the-window-width-is-resizable). The
 * width is remembered in this page's storage only — a fresh browser context.
 */
async function fitStrip(page, testId) {
  const grip = await page.getByTestId(`${testId}-resize`).boundingBox();
  if (!grip) throw new Error(`${testId} has no resize grip`);
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 800, y, { steps: 8 });
  await page.mouse.up();
}

/** With the transport playing: let the spectrum fill in, then catch a chord —
 *  wait until three or more keys are lit by the playing notes (keyboard.ts
 *  marks them `.seq`), so the scope shows a full band rather than one bass note. */
async function catchChord(page) {
  await page.waitForTimeout(4000);
  await page.waitForFunction(
    () => [...document.querySelectorAll('.seq')].filter((el) => /key/i.test(el.className)).length >= 3,
    null, { timeout: 30_000, polling: 50 },
  ).catch(() => console.warn('readme-screenshots: no chord within 30 s — shooting anyway'));
}

/** How full a Wave trace looks *in a screenshot*: decoded in the page, since
 *  Node has no PNG decoder here. The trace's vertical extent per 24px block,
 *  averaged, as a fraction of the scope's height. The trace colour is read from
 *  the page's theme token (ui-themes.md), so the judge works in whatever theme
 *  the shot pins. */
async function judgeSwing(page, png, scope) {
  return page.evaluate(async ({ b64, scope }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = (r) => ctx.getImageData(Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height));

    // Resolve the trace token through a probe.
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    probe.style.color = 'var(--screen-trace)';
    const traceRgb = getComputedStyle(probe).color.match(/rgba?\(([^)]+)\)/)[1].split(',').slice(0, 3).map(Number);
    probe.remove();
    const trace = (d, i) => Math.hypot(d[i] - traceRgb[0], d[i + 1] - traceRgb[1], d[i + 2] - traceRgb[2]) < 70;
    const s = px(scope);
    let sum = 0;
    let n = 0;
    for (let x0 = 0; x0 + 24 <= s.width; x0 += 24) {
      let lo = s.height;
      let hi = -1;
      for (let x = x0; x < x0 + 24; x += 2) {
        for (let y = 0; y < s.height; y++) {
          if (trace(s.data, (y * s.width + x) * 4)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
        }
      }
      if (hi >= 0) { sum += (hi - lo) / s.height; n++; }
    }
    return n ? sum / n : 0;
  }, { b64: png.toString('base64'), scope });
}

/** Keys the playing notes light (keyboard.ts marks them `.seq`). */
const litKeys = (page) => page.evaluate(
  () => [...document.querySelectorAll('.seq')].filter((el) => /key/i.test(el.className)).length,
);

/**
 * Shoot the playing hero until the Wave trace in the *image* swings across the
 * scope with a key lit — a full trace lasts only a few hundred ms, and the scope
 * redraws every frame, so a check before the screenshot proves nothing about
 * it. Nocturne's swing is ~0.13 median and reaches 0.5 a few times a minute.
 * A key counts as lit in the take when it is lit both before and after the
 * screenshot (a note lasts far longer than one), read from the DOM: judging it
 * from the image's colours mistook the black keys' drop shadow for a lit key.
 * Two lit keys and a full swing rarely coincide in Nocturne, so one is enough.
 * Keeps the best qualifying take if none reaches `minSwing` in time.
 */
async function shootWave(page, file, { minSwing = 0.5, timeoutMs = 120_000 } = {}) {
  const scope = await page.getByTestId('scope-canvas').boundingBox();
  if (!scope) throw new Error('scope has no bounding box');
  const deadline = Date.now() + timeoutMs;
  let best = null;
  while (Date.now() < deadline) {
    const before = await litKeys(page);
    const png = await page.screenshot();
    if (before === 0 || await litKeys(page) === 0) continue;
    const swing = await judgeSwing(page, png, scope);
    if (!best || swing > best.swing) best = { png, swing };
    if (best.swing >= minSwing) break;
  }
  if (!best) throw new Error('no take with lit keys');
  if (best.swing < minSwing) console.warn(`readme-screenshots: best wave swing ${best.swing.toFixed(2)} < ${minSwing}`);
  writeFileSync(publicDir + file, best.png);
  console.log(`wrote public/${file} (${best.png.length} bytes, swing ${best.swing.toFixed(2)})`);
}

async function shoot(page, file) {
  // Two frames, so the last click's paint is on screen.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: publicDir + file });
  console.log(`wrote public/${file} (${statSync(publicDir + file).size} bytes)`);
}

// ------------------------------------------------------------------ shots

const [transportWin, liveFxWin, xyWin] = WINDOWS;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  // 1 — the hero: playing, at the top, pattern row folded, scope on Wave (its
  // default) — shot 4 shows the Spectrum, so between them both views are seen.
  if (wanted('hero')) {
    const page = await openApp(browser, { 'websynth.ui.theme': 'classic' });
    await page.locator('[data-testid="pattern-row"] [aria-label="Collapse panel"]').first().click();
    await page.getByTestId('transport-play').click();
    await page.waitForTimeout(4000);
    await scrollTo(page, 0);
    await shootWave(page, 'vast-websynth.png');
    await page.close();
  }

  // 2 + 3 — stopped at BAR, the three windows open, scrolled to the machine
  // panel. Each in its own theme, so each gets its own page.
  const MACHINE_SHOTS = [
    { tab: 'drums', theme: 'vibrant', file: 'vast-websynth-drum-machine.png' },
    { tab: 'song', theme: 'race', file: 'vast-websynth-song-tab.png' },
  ];
  for (const m of wanted('machines') ? MACHINE_SHOTS : []) {
    const page = await openApp(browser, { 'websynth.ui.theme': m.theme });
    await page.getByTestId('transport-open').click();
    await placeWindow(page, transportWin);
    if (transportWin.fitStrip) await fitStrip(page, transportWin.testId);
    const cell = page.locator('[data-testid^="transportw-scrub-"]').filter({ hasText: new RegExp(`^${BAR}$`) });
    if (await cell.count() === 0) throw new Error(`the song has no bar ${BAR}`);
    await cell.first().click();
    await page.getByTestId('livefx-open').click();
    await placeWindow(page, liveFxWin);
    await page.getByTestId('perf-xypad').click();
    await placeWindow(page, xyWin);

    await page.getByTestId(`tab-${m.tab}`).click();
    await scrollBottomTo(page, 'pattern-row', PANEL_BOTTOM_Y);
    await shoot(page, m.file);
    await page.close();
  }

  // 4 — the analysis pair: playing, machines folded, the scope at its ceiling
  // (src/state/scope-height.ts SCOPE_H_MAX, seeded as the stored preference)
  // on Spectrum, and the EQUALIZER unfolded on its Sequencer tab, scrolled so
  // the keyboard's bottom edge sits where the machine panel's does above. At
  // 67% UI scale (ui-scale.md, seeded as the stored preference) the whole rack
  // fits the frame and the wider keyboard fills its foot.
  if (wanted('eq')) {
    const page = await openApp(browser, {
      'websynth.ui.scale': '67',
      'websynth.ui.scope.height': '260',
      'websynth.ui.collapsed.eq': '0',
    });
    await page.locator('[data-testid="pattern-row"] [aria-label="Collapse panel"]').first().click();
    await page.getByTestId('tab-eq-seq').click();
    await page.getByTestId('scope-toggle').click();
    await page.getByTestId('transport-play').click();
    await catchChord(page);
    await scrollBottomTo(page, 'keyboard', PANEL_BOTTOM_Y);
    await shoot(page, 'vast-websynth-eq-scope.png');
    await page.close();
  }

  // 5 + 6 — Pastel and the Motion tab (ui-themes.md), scrolled so the machine
  // panel's bottom edge sits where it does in shots 2 and 3. Pastel: Bunk
  // playing, the Sequencer tab following the playhead (FOLLOW is on by
  // default), the FX row open above its painted sections. Motion, in Light:
  // Gankogui as loaded — stopped at bar 1 — on the Motion tab with FX folded, so
  // the lanes get the room; bar 1's bank fills the XY pad and both A and B lanes.
  const THEME_SHOTS = [
    { name: 'pastel', theme: 'pastel', demo: THEME_DEMO, tab: 'seq', fxFolded: false, play: true, file: 'vast-websynth-theme-pastel.png' },
    { name: 'motion', theme: 'light', demo: MOTION_DEMO, tab: 'motion', fxFolded: true, play: false, file: 'vast-websynth-motion-machine.png' },
  ];
  for (const t of THEME_SHOTS) {
    if (!wanted(t.name)) continue;
    const page = await openApp(browser, {
      'websynth.ui.theme': t.theme,
      'websynth.ui.collapsed.fx': t.fxFolded ? '1' : '0',
    }, t.demo);
    await page.getByTestId(`tab-${t.tab}`).click();
    if (t.play) {
      await page.getByTestId('transport-play').click();
      // Into the song, past the intro bars, so every lane is playing.
      await page.waitForTimeout(6000);
    }
    await scrollBottomTo(page, 'pattern-row', PANEL_BOTTOM_Y);
    await shoot(page, t.file);
    await page.close();
  }

  // 7 — help (onboarding.md): Race, Bunk loaded and stopped, FX folded, the
  // Sequencer tab, at the top; the info badges on and AMP ENV's opened, so its
  // help modal with the live envelope graph sits over the dimmed badges.
  if (wanted('help')) {
    const page = await openApp(browser, {
      'websynth.ui.theme': 'race',
      'websynth.ui.collapsed.fx': '1',
    }, THEME_DEMO);
    await page.getByTestId('tab-seq').click();
    await scrollTo(page, 0);
    await page.getByTestId('info-badges').click();
    await page.getByTestId('info-badge-ampenv').click();
    await page.getByRole('dialog', { name: 'Amp Envelope (ADSR)' }).waitFor({ state: 'visible' });
    // Let the modal's entrance settle before the frame is taken.
    await page.waitForTimeout(500);
    await shoot(page, 'vast-websynth-help-badges.png');
    await page.close();
  }
} finally {
  await browser.close();
  server?.stop();
}
