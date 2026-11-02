// Retake the README screenshots from the running app.
//
// Drives the dev server in Playwright's bundled Chromium (headless, so no
// scrollbars) at 1920×1080, DPR 1. Run manually and commit the output:
//
//   node scripts/readme-screenshots.mjs [--demo <name>] [--bar <n>] [--url <app url>]
//
// Outputs (public/), each 1920×1080:
//   vast-websynth.png               the demo playing, pattern row folded, scope on
//                                   Spectrum, keys lit by the notes
//   vast-websynth-drum-machine.png  stopped at --bar, Drum Machine tab, with the
//                                   Transport (widened to the whole song), Live FX
//                                   and XY pad windows open
//   vast-websynth-song-tab.png      the same, on the Song tab
//   vast-websynth-eq-scope.png      the demo playing, machines folded, the scope
//                                   at its full height on Spectrum, and the
//                                   EQUALIZER unfolded on its Sequencer tab
//
// Framing is judged by eye — look at all three before committing them.

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = root + 'public/';
const PORT = 5191;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const DEMO = flag('demo', 'Nocturne');
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

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

let server = null;
// Kill once, from wherever we leave. An orphaned vite holds node_modules' native
// rolldown binding open (see audio-bench.mjs).
const stopServer = () => {
  const s = server;
  server = null;
  if (s) s.kill();
};
process.on('exit', stopServer);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopServer();
    process.exit(130);
  });
}

let url = flag('url', null);
if (!url) {
  url = `http://localhost:${PORT}/`;
  const viteBin = `${root}node_modules/vite/bin/vite.js`;
  if (!existsSync(viteBin)) {
    console.error(`readme-screenshots: ${viteBin} is missing — run \`npm install\` first.`);
    process.exit(1);
  }
  server = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  console.log(`readme-screenshots: starting vite on ${url}`);
  await waitForServer(url);
}

// ------------------------------------------------------------------ steps

/** A booted page with the demo loaded, the pattern row open on the Song tab.
 *  `prefs` are extra workspace entries seeded into storage before boot. */
async function openApp(browser, prefs = {}) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await page.addInitScript((extra) => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1');
      localStorage.setItem('websynth.perf', 'off');
      localStorage.setItem('websynth.hint.emptyplay', '1');
      localStorage.setItem('websynth.ui.collapsed.pattern', '0');
      for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
    } catch { /* ignore */ }
  }, prefs);
  await page.goto(url);

  // Whichever start gate this browser gets (audio-lifecycle.md REQ-the-gesture-is-required-only-when-required).
  await page.waitForFunction(() =>
    Boolean(document.querySelector('.start-btn'))
    || window.__synth?.engine.ctx.state === 'running');
  const start = page.getByRole('button', { name: 'Tap to start' });
  if (await start.count() > 0) {
    await start.click();
    await start.waitFor({ state: 'hidden' });
  }
  await page.waitForFunction(() => window.__synth?.engine.ctx.state === 'running');

  await page.getByTestId('tab-song').click();
  const btn = page.getByTestId(`song-demo-${DEMO}`);
  if (await btn.count() === 0) throw new Error(`no demo named "${DEMO}" (check the Song panel's Demos row)`);
  if (!(await btn.isVisible())) await page.getByTestId('song-demo-more').click();
  await btn.click();
  await page.locator(`[data-testid="demo-loaded-info"][aria-label="About ${DEMO}"]`)
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
  // 1 — the hero: playing, at the top, pattern row folded, scope on Spectrum.
  {
    const page = await openApp(browser);
    await page.locator('[data-testid="pattern-row"] [aria-label="Collapse panel"]').first().click();
    await page.getByTestId('scope-toggle').click();
    await page.getByTestId('transport-play').click();
    await catchChord(page);
    await scrollTo(page, 0);
    await shoot(page, 'vast-websynth.png');
    await page.close();
  }

  // 2 + 3 — stopped at BAR, the three windows open, scrolled to the machine panel.
  {
    const page = await openApp(browser);
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

    for (const [tab, file] of [['drums', 'vast-websynth-drum-machine.png'], ['song', 'vast-websynth-song-tab.png']]) {
      await page.getByTestId(`tab-${tab}`).click();
      await scrollBottomTo(page, 'pattern-row', PANEL_BOTTOM_Y);
      await shoot(page, file);
    }
    await page.close();
  }

  // 4 — the analysis pair: playing, machines folded, the scope at its ceiling
  // (src/state/scope-height.ts SCOPE_H_MAX, seeded as the stored preference)
  // on Spectrum, and the EQUALIZER unfolded on its Sequencer tab, scrolled so
  // the keyboard's bottom edge sits where the machine panel's does above.
  {
    const page = await openApp(browser, {
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
} finally {
  await browser.close();
  stopServer();
}
