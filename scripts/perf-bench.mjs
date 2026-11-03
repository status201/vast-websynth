// Performance bench: fixed scenarios, repeated, measuring the AUDIO thread as
// well as the main thread, through the real app in headless Chromium.
//
//   npm run bench:perf                         # all scenarios, 3 reps
//   npm run bench:perf -- --reps 5 --name before
//   npm run bench:perf -- --only idle --only "8 voices"
//   npm run bench:perf -- --compare bench/perf-before.json bench/perf-after.json
//
// Options
//   --name <id>      results file: bench/perf-<id>.json            [default latest]
//   --reps <n>       repeats per scenario; the median is reported   [default 3]
//   --only <name>    run just this scenario (repeatable)
//   --url <url>      drive an already-running dev server (skips spawning vite)
//   --compare a b    print two result files side by side and stop
//
// Why the audio thread, and how. A synth's real budget is the render callback,
// and no web API reports its load. Chrome's tracing does: with the `webaudio`
// category on, `AudioDestination::RequestRender` spans the render thread's work
// for one device callback, so load = its duration / the callback period, and
// `RealtimeAudioDestinationHandler::Render` spans one 128-frame block. ONLY
// `webaudio`/`audio` are recorded: the per-node categories
// (`disabled-by-default-webaudio.audionode`) log every node every block and
// inflate the very timings they report.
//
// The main thread comes from CDP's Performance metrics over the same window,
// plus a requestAnimationFrame counter. Chromium only: Gecko has no equivalent
// trace. The dev server is the target because scenarios are set up through the
// dev-only `window.__synth` bridge; the audio thread runs the same worklets and
// graph either way. Numbers are this machine's: compare runs from one machine,
// and treat a phone as several times slower.
//
// See specs/features/runtime-performance.md.

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const benchDir = `${root}bench`;
const PORT = 5197; // off the dev server's and bench:audio's ports so all three can run

// ------------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flags = (name) => argv.reduce((acc, a, i) => (a === `--${name}` ? [...acc, argv[i + 1]] : acc), []);

// ---------------------------------------------------------------- compare

const fmtRow = (name, r) =>
  `${name.padEnd(40)} audio ${(r.loadMean * 100).toFixed(1).padStart(5)}% mean ${(r.loadP95 * 100).toFixed(1).padStart(5)}% p95 ${(r.loadMax * 100).toFixed(0).padStart(4)}% max`
  + ` | >50% ${String(r.over50).padStart(3)} >90% ${String(r.over90).padStart(3)}`
  + ` | worst block ${r.quantumMax.toFixed(2)}/${r.budgetQ.toFixed(2)} ms`
  + ` | main ${(r.mainTask * 100).toFixed(1).padStart(5)}% (script ${(r.mainScript * 100).toFixed(1)}%)`
  + ` ${r.recalcPerS.toFixed(0).padStart(3)} recalc/s ${r.fps.toFixed(0)} fps`;

const cmpIdx = argv.indexOf('--compare');
if (cmpIdx >= 0) {
  const [a, b] = [argv[cmpIdx + 1], argv[cmpIdx + 2]];
  if (!a || !b) { console.error('perf-bench: --compare needs two result files'); process.exit(1); }
  const A = JSON.parse(readFileSync(a, 'utf8')).results;
  const B = JSON.parse(readFileSync(b, 'utf8')).results;
  for (const name of Object.keys({ ...A, ...B })) {
    const x = A[name], y = B[name];
    if (!x || !y) { console.log(`${name.padEnd(40)} only in ${x ? a : b}`); continue; }
    const d = (k, scale = 100) => `${((y[k] - x[k]) * scale >= 0 ? '+' : '')}${((y[k] - x[k]) * scale).toFixed(1)}`;
    console.log(`${name.padEnd(40)} audio mean ${(x.loadMean * 100).toFixed(1)}% -> ${(y.loadMean * 100).toFixed(1)}% (${d('loadMean')})`
      + `  p95 ${(x.loadP95 * 100).toFixed(1)}% -> ${(y.loadP95 * 100).toFixed(1)}% (${d('loadP95')})`
      + `  worst block ${x.quantumMax.toFixed(2)} -> ${y.quantumMax.toFixed(2)} ms`
      + `  main ${(x.mainTask * 100).toFixed(1)}% -> ${(y.mainTask * 100).toFixed(1)}%`);
  }
  process.exit(0);
}

const reps = Math.max(1, Number(flag('reps', 3)));
const only = flags('only').filter(Boolean);
const name = flag('name', 'latest');
const SETTLE_MS = 1500;
const MEASURE_MS = 4000;

// -------------------------------------------------------------- scenarios

const CHORD8 = [36, 43, 48, 52, 55, 59, 62, 67];
const ALL_SYNTH_FX = ['fx.eq.on', 'fx.dist.on', 'fx.wah.on', 'fx.phaser.on', 'fx.flanger.on', 'fx.chorus.on',
  'fx.delay.on', 'fx.reverb.on', 'fx.duck.on', 'fx.master.comp.on'];

/** Demos by KIND, never by name (e2e/CLAUDE.md): the first zip and the first JSON in the index. */
const index = JSON.parse(readFileSync(`${root}src/state/demos-index.json`, 'utf8'));
const firstDemo = (ext) => Object.entries(index).filter(([f]) => f.endsWith(ext)).map(([, d]) => d.name).sort()[0];

const SCENARIOS = [
  { name: 'idle', notes: [] },
  { name: '1 note', notes: [48] },
  { name: '4-note chord', notes: [48, 52, 55, 59] },
  { name: '8 voices', notes: CHORD8 },
  { name: '8 voices as 2 notes x unison 4', notes: [48, 55], params: { 'unison.voices': 4 } },
  { name: '8 voices + every synth FX', notes: CHORD8, params: Object.fromEntries(ALL_SYNTH_FX.map((id) => [id, 1])) },
  { name: '8 voices POLY + sync + FM + ring', notes: CHORD8,
    params: { 'filter.model': 1, 'osc2.sync': 1, 'osc1.fm': 2, 'osc1.ring': 0.5, 'osc2.level': 0.5 } },
  { name: 'zip demo playing', demo: firstDemo('.zip'), play: true },
  { name: 'json demo playing', demo: firstDemo('.json'), play: true },
  { name: 'weak tier idle', tier: 'weak', notes: [] },
].filter((s) => !only.length || only.includes(s.name));

if (!SCENARIOS.length) {
  console.error(`perf-bench: no scenario matches --only ${only.join(', ')}`);
  process.exit(1);
}

// ------------------------------------------------------------- dev server

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

let server = null;
let url = flag('url');
// Kill once, from wherever we leave (an orphaned vite holds rolldown's native
// binding and the next `npm ci` fails with EPERM — see audio-bench.mjs).
const stopServer = () => { const s = server; server = null; if (s) s.kill(); };
process.on('exit', stopServer);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopServer(); process.exit(130); });

if (!url) {
  // `localhost` can resolve to the address family vite is not listening on;
  // pin the host so the URL below is the one it serves.
  url = `http://127.0.0.1:${PORT}/`;
  const viteBin = `${root}node_modules/vite/bin/vite.js`;
  if (!existsSync(viteBin)) { console.error('perf-bench: run `npm install` first.'); process.exit(1); }
  server = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  console.log(`perf-bench: starting vite on ${url}`);
  await waitForServer(url);
}

// ------------------------------------------------------------------ runs

const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const median = (a) => q(a, 0.5);

async function runOnce(browser, sc) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript((tier) => {
    localStorage.setItem('websynth.onboarding.done', '1');
    localStorage.setItem('websynth.perf', tier);
    localStorage.setItem('websynth.hint.emptyplay', '1');
  }, sc.tier ?? 'medium');
  await page.goto(url);
  await page.waitForFunction(() => window.__synth?.engine.ctx.state === 'running' || Boolean(document.querySelector('.start-btn')));
  const start = page.getByRole('button', { name: 'Tap to start' });
  if (await start.count() > 0) { await start.click(); await start.waitFor({ state: 'hidden' }); }
  await page.waitForFunction(() => window.__synth?.engine.ctx.state === 'running');
  if (sc.demo) {
    await page.getByTestId('tab-song').click();
    const btn = page.getByTestId(`song-demo-${sc.demo}`);
    if (!(await btn.isVisible())) await page.getByTestId('song-demo-more').click();
    await btn.click();
    await page.locator(`[data-testid="demo-loaded-info"][aria-label="About ${sc.demo}"]`).waitFor({ state: 'attached', timeout: 30_000 });
    await page.waitForTimeout(2000); // a zip decodes its clips after the song applies
  }
  const sr = await page.evaluate(({ params, notes, play }) => {
    const s = window.__synth;
    for (const [k, v] of Object.entries(params ?? {})) s.bus.set(k, v);
    for (const n of notes ?? []) s.bus.noteOn(n, 0.8);
    if (play) s.engine.clock.start();
    window.__perfFrames = 0;
    const tick = () => { window.__perfFrames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return s.engine.ctx.sampleRate;
  }, { params: sc.params, notes: sc.notes, play: sc.play });
  await page.waitForTimeout(SETTLE_MS);

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => { for (const ev of e.value) if (ev.cat === 'webaudio' || ev.cat === 'audio') events.push(ev); });
  const done = new Promise((res) => cdp.once('Tracing.tracingComplete', res));
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  const m0 = await metrics();
  const f0 = await page.evaluate(() => window.__perfFrames);
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['webaudio', 'audio'] }, transferMode: 'ReportEvents' });
  await page.waitForTimeout(MEASURE_MS);
  await cdp.send('Tracing.end');
  await done;
  const m1 = await metrics();
  const f1 = await page.evaluate(() => window.__perfFrames);
  await context.close();

  const wall = m1.Timestamp - m0.Timestamp;
  const req = events.filter((e) => e.name === 'AudioDestination::RequestRender' && e.ph === 'X').sort((a, b) => a.ts - b.ts);
  const blocks = events.filter((e) => e.name === 'RealtimeAudioDestinationHandler::Render' && e.ph === 'X').map((e) => e.dur / 1000);
  if (req.length < 10) throw new Error(`only ${req.length} render callbacks traced — is this Chromium?`);
  const gaps = [];
  for (let i = 1; i < req.length; i++) gaps.push((req[i].ts - req[i - 1].ts) / 1000);
  const period = median(gaps); // ms; robust to the device's buffer size
  const load = req.map((e) => e.dur / 1000 / period);
  return {
    callbackMs: period, callbacks: req.length,
    loadMean: load.reduce((a, b) => a + b, 0) / load.length,
    loadP95: q(load, 0.95), loadMax: q(load, 1),
    over50: load.filter((l) => l > 0.5).length, over90: load.filter((l) => l > 0.9).length,
    quantumP99: q(blocks, 0.99), quantumMax: q(blocks, 1), budgetQ: (128 / sr) * 1000,
    mainTask: (m1.TaskDuration - m0.TaskDuration) / wall, mainScript: (m1.ScriptDuration - m0.ScriptDuration) / wall,
    recalcPerS: (m1.RecalcStyleCount - m0.RecalcStyleCount) / wall, layoutPerS: (m1.LayoutCount - m0.LayoutCount) / wall,
    fps: (f1 - f0) / wall, heapMB: m1.JSHeapUsedSize / 1e6,
  };
}

mkdirSync(benchDir, { recursive: true });
const browser = await chromium.launch();
const results = {};
let failure = null;
try {
  console.log(`perf-bench: ${SCENARIOS.length} scenario(s) x ${reps} rep(s), ${MEASURE_MS / 1000} s each; medians`);
  for (const sc of SCENARIOS) {
    const runs = [];
    for (let r = 0; r < reps; r++) {
      try { runs.push(await runOnce(browser, sc)); } catch (err) { console.log(`  ${sc.name} rep ${r + 1} failed: ${String(err.message).split('\n')[0]}`); }
    }
    if (!runs.length) continue;
    results[sc.name] = Object.fromEntries(Object.keys(runs[0]).map((k) => [k, median(runs.map((x) => x[k]))]));
    console.log(fmtRow(sc.name, results[sc.name]));
  }
} catch (err) {
  failure = err;
} finally {
  await browser.close();
  stopServer();
}
if (failure) { console.error('perf-bench failed:', failure.message); process.exit(1); }
const out = `${benchDir}/perf-${name}.json`;
writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), reps, measureMs: MEASURE_MS, results }, null, 2));
console.log(`\nperf-bench: wrote ${out}`);
