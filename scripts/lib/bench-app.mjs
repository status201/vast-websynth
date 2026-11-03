// What the two benches (`audio-bench.mjs`, `perf-bench.mjs`) share: a dev server
// of their own and an app booted past onboarding and the start gate.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

/**
 * Spawn vite on `port` and resolve with its URL once it answers. Returns
 * `{ url, stop }`; `stop` is also wired to process exit and the usual signals,
 * so the server dies with the script however it leaves.
 *
 * Vite's own binary under the running Node: no `npx`, no shell. On Windows
 * `kill()` reaches only the cmd wrapper, so anything spawned through one survives
 * as an orphan holding the port and rolldown's native binding, and the next
 * `npm ci` fails with EPERM on a file nobody can see is in use. The host is
 * pinned because `localhost` can resolve to the address family vite is not
 * listening on.
 */
export async function startDevServer({ root, port, tag }) {
  const viteBin = `${root}node_modules/vite/bin/vite.js`;
  if (!existsSync(viteBin)) {
    console.error(`${tag}: ${viteBin} is missing — run \`npm install\` first.`);
    process.exit(1);
  }
  const url = `http://127.0.0.1:${port}/`;
  let server = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: 'ignore',
  });
  // Kill once, from wherever we leave: the caller's `finally`, Ctrl-C, or a crash.
  const stop = () => {
    const s = server;
    server = null;
    if (s) s.kill();
  };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop(); process.exit(130); });
  console.log(`${tag}: starting vite on ${url}`);
  await waitForServer(url);
  return { url, stop };
}

/**
 * Open the app at `url` with the e2e helpers' boot flags (no onboarding, a pinned
 * performance tier so a run is reproducible across machines) and wait until the
 * AudioContext runs.
 *
 * Gets past whichever start gate this browser gets (audio-lifecycle.md
 * REQ-the-gesture-is-required-only-when-required): the modal exists only to buy a
 * user gesture, and Playwright launches both engines with autoplay permitted, so
 * usually there is none. Waiting for the button alone times out on that path;
 * wait for either outcome, as `e2e/helpers.ts` startAudio does.
 */
export async function bootApp(page, url, { tier = 'medium' } = {}) {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1');
      localStorage.setItem('websynth.perf', t);
      localStorage.setItem('websynth.hint.emptyplay', '1');
    } catch { /* ignore */ }
  }, tier);
  await page.goto(url);
  await page.waitForFunction(() =>
    Boolean(document.querySelector('.start-btn'))
    || window.__synth?.engine.ctx.state === 'running');
  const start = page.getByRole('button', { name: 'Tap to start' });
  if (await start.count() > 0) {
    await start.click();
    await start.waitFor({ state: 'hidden' });
  }
  await page.waitForFunction(() => window.__synth?.engine.ctx.state === 'running');
}
