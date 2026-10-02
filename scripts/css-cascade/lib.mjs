/**
 * Shared harness for the two cascade tools (specs/features/css-cascade-layers.md):
 * starts a server, boots the app at a viewport, drives it into a named UI state,
 * and freezes every animation so two captures of the same state are identical.
 *
 * `fingerprint.mjs` runs against `vite preview` — the shipped bundle, in the
 * shipped CSS order, which is the order that actually has to stay put.
 * `conflicts.mjs` runs against `vite dev`, where every module is its own
 * `<style data-vite-dev-id>` and a rule can be traced back to the file it came from.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chromium, firefox } from 'playwright';

/** Desktop wide, the two compact breakpoints the shell is laid out around, a tablet and a phone. */
export const VIEWPORTS = [
  { name: 'w1920', width: 1920, height: 1080 },
  { name: 'w1280', width: 1280, height: 900 },
  { name: 'w1140', width: 1140, height: 900 },
  { name: 'w900', width: 900, height: 1100 },
  { name: 'w390', width: 390, height: 844 },
];

/** Viewports the lazily-loaded dialogs are captured at — one wide, one phone. */
const MODAL_VIEWPORTS = ['w1280', 'w390'];

const tab = (id) => async (page) => {
  // The pattern row boots folded on a compact viewport; unfold it first.
  const row = page.getByTestId('pattern-row');
  if (await row.evaluate((el) => el.classList.contains('collapsed'))) {
    await row.locator('[aria-expanded]').first().click();
  }
  await page.getByTestId(`tab-${id}`).click();
};

const click = (testid) => async (page) => { await page.getByTestId(testid).click(); };

/** A header button, which below 720px sits behind the hamburger (responsive-header.md). */
const headerClick = (testid) => async (page) => {
  const btn = page.getByTestId(testid);
  if (!(await btn.isVisible())) await page.getByTestId('header-menu').click();
  await btn.click();
};

const songTab = tab('song');

/**
 * Every state is captured from a fresh page load, so no state can bleed into
 * the next. `only` limits a state to some viewports; absent means all of them.
 */
export const STATES = [
  { name: 'boot', steps: [] },
  { name: 'header-menu-open', only: ['w390'], steps: [click('header-menu')] },
  {
    name: 'fx-toggled',
    steps: [async (page) => { await page.getByTestId('fx').locator('[aria-expanded]').first().click(); }],
  },
  {
    name: 'pattern-row-toggled',
    steps: [async (page) => { await page.getByTestId('pattern-row').locator('[aria-expanded]').first().click(); }],
  },
  ...['key', 'seq', 'drums', 'sampler', 'motion', 'song'].map((id) => ({ name: `tab-${id}`, steps: [tab(id)] })),
  { name: 'scope-spectrum', steps: [click('scope-toggle'), click('scope-zones-toggle'), click('scope-channels-toggle')] },
  { name: 'eq-toggled', steps: [async (page) => { await page.getByTestId('eq-section').locator('[aria-expanded]').first().click(); }] },
  // A step machine switched on arms the Play button's green cue (play-button-blink.md).
  { name: 'play-cue', steps: [tab('seq'), async (page) => { await page.getByTestId('panel-seq').locator('[role="switch"], button').first().click(); }] },
  // Every floating window, open and minimised. Their consumers lay out the
  // window's own body, so a minimised window is exactly where one module's state
  // rule meets another's layout class (floating-window.md
  // REQ-a-collapsed-body-stays-hidden) — a state no other capture renders.
  ...[
    ['livefx', 'livefx-open', 'livefx-window'],
    ['mod', 'perf-mod', 'mod-window'],
    ['transport', 'transport-open', 'transport-window'],
    ['record', 'song-record', 'record-window'],
    ['xypad', 'perf-xypad', 'xypad-window'],
  ].flatMap(([name, opener, win]) => [
    { name: `window-${name}`, only: MODAL_VIEWPORTS, steps: [songTab, click(opener), wait(win)] },
    {
      name: `window-${name}-minimised`,
      only: MODAL_VIEWPORTS,
      steps: [songTab, click(opener), wait(win), async (page) => { await page.getByTestId(win).getByLabel('Minimise').click(); }],
    },
  ]),
  { name: 'modal-preset-manager', only: MODAL_VIEWPORTS, steps: [headerClick('preset-save'), wait('preset-manager')] },
  { name: 'modal-about', only: MODAL_VIEWPORTS, steps: [headerClick('about-button')] },
  { name: 'modal-perf', only: MODAL_VIEWPORTS, steps: [headerClick('perf-settings')] },
  { name: 'modal-export', only: MODAL_VIEWPORTS, steps: [songTab, click('song-export'), wait('export-modal')] },
  { name: 'modal-export-audio', only: MODAL_VIEWPORTS, steps: [songTab, click('song-export-audio'), wait('export-audio-modal')] },
  { name: 'modal-paste', only: MODAL_VIEWPORTS, steps: [songTab, click('song-paste'), wait('paste-modal')] },
];

function wait(testid) {
  return async (page) => { await page.getByTestId(testid).first().waitFor({ state: 'visible' }); };
}

/** The (state, viewport) pairs a full run captures. */
export function plan(filter) {
  const out = [];
  for (const state of STATES) {
    for (const vp of VIEWPORTS) {
      if (state.only && !state.only.includes(vp.name)) continue;
      const id = `${state.name}@${vp.name}`;
      if (filter && !id.includes(filter)) continue;
      out.push({ id, state, vp });
    }
  }
  return out;
}

/**
 * Start a Vite server and resolve its base URL once it answers. The child is
 * returned so the caller can kill it; `--strictPort` makes a stale server on the
 * same port a loud failure rather than a silent run against old code.
 */
export async function startServer(kind, port) {
  const args = kind === 'preview'
    ? ['vite', 'preview', '--port', String(port), '--strictPort']
    : ['vite', '--port', String(port), '--strictPort'];
  const url = `http://localhost:${port}`;
  // Something already answering here would be measured instead of this tree —
  // typically a server orphaned by a run that crashed.
  if (await fetch(url).then(() => true, () => false)) {
    throw new Error(`${url} is already in use — stop that server, or pass --port`);
  }
  const child = spawn('npx', args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Never leave the server behind, even when the run dies on an exception.
  const reap = () => stopServer(child);
  process.once('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { reap(); process.exit(130); });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`vite ${kind} exited:\n${log}`);
    try {
      const r = await fetch(url);
      if (r.ok) return { url, child };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`vite ${kind} did not answer on ${url}:\n${log}`);
}

export function stopServer(child) {
  if (child.exitCode !== null || child.killed) return;
  // npx runs vite as a grandchild, so the whole tree has to go. Synchronous,
  // because it must also work from a process 'exit' handler.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
  child.killed = true;
}

export async function launch(browserName = 'chromium') {
  const type = browserName === 'firefox' ? firefox : chromium;
  return type.launch({
    args: browserName === 'firefox' ? [] : ['--autoplay-policy=no-user-gesture-required'],
    firefoxUserPrefs: browserName === 'firefox' ? { 'media.autoplay.default': 0 } : undefined,
  });
}

/**
 * Boot the app at `vp`, run `state`'s steps, and freeze it. A fresh context per
 * call: empty storage, so nothing a previous state persisted (a fold, a tab)
 * leaks in. The same three flags e2e sets keep the tour, Performance mode and
 * the empty-play hint out of the picture.
 */
export async function openState(browser, url, state, vp) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1');
      localStorage.setItem('websynth.perf', 'off');
      localStorage.setItem('websynth.hint.emptyplay', '1');
    } catch { /* ignore */ }
  });
  await page.goto(url);
  await page.getByTestId('app-header').waitFor({ state: 'visible' });
  const start = page.getByRole('button', { name: 'Tap to start' });
  if (await start.count() > 0) await start.click();
  for (const step of state.steps) await step(page);
  await settle(page);
  return { page, close: () => context.close() };
}

/**
 * Let layout settle, then pin every animation: a finite one (a transition, a
 * one-shot keyframe) is finished, so its END value is what gets compared; an
 * infinite one (the attract pulse, a blinking LED) is paused at time 0.
 * Done through the Web Animations API rather than an injected stylesheet,
 * because an injected stylesheet would itself take part in the cascade under test.
 */
export async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  for (let round = 0; round < 3; round++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        const timing = a.effect?.getComputedTiming();
        if (timing && timing.iterations === Infinity) {
          a.pause();
          a.currentTime = 0;
        } else {
          try { a.finish(); } catch { a.cancel(); }
        }
      }
    });
  }
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

/** Run `fn` over `items` with at most `n` in flight. */
export async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}
