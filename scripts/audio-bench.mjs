// Render a take through the REAL audio graph and drop a WAV on disk.
//
// This exists because the Zoetrope bug could not be reproduced against the
// worklet in isolation — the kernel measured clean on every synthetic input
// while the shipped effect sounded broken. The gap was the rest of the graph
// (voices, filter, FX chain, the pitch-signal feed, the bypass wrapper), and
// there was no way to hear or measure that except asking a human to export a
// file. ADR-010 ranks DSP "musical, stable, cheap" in that order; this is the
// loop that lets us check the first one.
//
//   npm run bench:audio -- --name held-note --note A2 --set fx.zoetrope.on=1
//   npm run bench:audio -- --name song-on --demo "Night Rider" --set fx.zoetrope.on=1
//   npm run bench:audio -- --name dry --url http://localhost:5173
//
// Options
//   --name <id>        output basename (bench/<id>.wav)              [required]
//   --note <spec>      notes to hold: "A2", "45", "45,52,57"         [default A2]
//   --seconds <n>      take length in note mode                      [default 6]
//   --velocity <0..1>  note velocity in note mode                    [default 0.9]
//                      Needed to hear anything velocity-sensitive — `filter.velAmount`
//                      only differs BETWEEN velocities (envelopes.md REQ-5).
//   --demo <name>      load a demo song and render one full pass instead
//   --runs <n>         passes to render in --demo mode (1..10)        [default 1]
//   --tail-bar         hold the capture open a whole bar after the last step,
//                      so reverb/delay tails decay instead of being cut at
//                      350 ms. Off by default: a plain take stays bar-exact.
//   --stagger <s>      release the held notes one at a time, oldest first,
//                      `s` seconds apart, instead of dropping the chord at
//                      once. What voice stealing needs to be audible: hold
//                      more notes than there are voices and the early keys
//                      have already lost their voice to the late ones, so
//                      which note stops on each release is the whole test
//                      (voicing.md REQ-9). Default 0 = release together.
//   --set id=value     ParamBus write applied before the take (repeatable)
//   --url <url>        drive an already-running server (skips spawning vite)
//   --format wav|mp3   capture format                                [default wav]
//   --headed           show the browser (debugging)
//
// Playwright is already a devDependency and `scripts/generate-icons.mjs` is the
// precedent for driving it from a script. Capture goes through the app's own
// `RecorderController`, so a take is byte-for-byte the file the Export button
// produces — no second recording path to keep honest.
//
// See specs/recipes/verify-audio-by-ear.md.

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const benchDir = `${root}bench`;
const PORT = 5199; // off the dev server's default so both can run at once

// ------------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flags = (name) => argv.reduce((acc, a, i) => (a === `--${name}` ? [...acc, argv[i + 1]] : acc), []);

const opts = {
  name: flag('name'),
  note: flag('note', 'A2'),
  seconds: Number(flag('seconds', 6)),
  // 0.9 is what every take before this flag used, so an old command still
  // renders the same file. Clamped, since it goes straight to bus.noteOn.
  velocity: Math.max(0, Math.min(1, Number(flag('velocity', 0.9)))),
  demo: flag('demo'),
  url: flag('url'),
  format: flag('format', 'wav'),
  headed: argv.includes('--headed'),
  sets: flags('set').filter(Boolean),
  // Export options (audio-export.md REQ-2/REQ-3), --demo mode only. Both
  // default OFF so a plain `--demo` take stays bar-exact and comparable with
  // every take rendered before they existed.
  runs: Number(flag('runs', 1)),
  tailBar: argv.includes('--tail-bar'),
  // Seconds between note-offs in --note mode. 0 (the default) releases the
  // whole chord at once, which is what every take before this flag did.
  stagger: Math.max(0, Number(flag('stagger', 0))),
};

if (!opts.name) {
  console.error('audio-bench: --name is required (output goes to bench/<name>.wav)');
  process.exit(1);
}

/** "A2" / "C#3" / "45" → MIDI number. C4 = 60, matching the repo convention. */
function toMidi(spec) {
  const n = Number(spec);
  if (Number.isFinite(n)) return n;
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`unrecognised note "${spec}" (try A2, C#3, or a MIDI number)`);
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + base + accidental;
}

const notes = opts.note.split(',').map((s) => toMidi(s));

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
let url = opts.url;
if (!url) {
  url = `http://localhost:${PORT}/`;
  server = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' },
  );
  console.log(`audio-bench: starting vite on ${url}`);
  await waitForServer(url);
}

// ------------------------------------------------------------------- take

mkdirSync(benchDir, { recursive: true });
const outPath = `${benchDir}/${opts.name}.${opts.format}`;

const browser = await chromium.launch({ headless: !opts.headed });
let failure = null;
try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  // Same boot flags the e2e helpers use: no onboarding overlay, and a pinned
  // performance tier so a take is reproducible across machines.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1');
      localStorage.setItem('websynth.perf', 'medium');
      localStorage.setItem('websynth.hint.emptyplay', '1');
    } catch { /* ignore */ }
  });
  await page.goto(url);

  // Audio needs a real gesture; the click is trusted under Playwright.
  const start = page.getByRole('button', { name: 'Tap to start' });
  await start.click();
  await start.waitFor({ state: 'hidden' });

  if (opts.demo) {
    // The demo buttons live on the Song tab, and only the first few are inline —
    // the rest sit behind "All Demos" (song-mode.md REQ-10).
    await page.getByTestId('tab-song').click();
    const btn = page.getByTestId(`song-demo-${opts.demo}`);
    if (await btn.count() === 0) {
      throw new Error(`no demo named "${opts.demo}" (check the Song panel's Demos row)`);
    }
    if (!(await btn.isVisible())) await page.getByTestId('song-demo-more').click();
    await btn.click();
    await page.waitForTimeout(800); // the fetched demos resolve async
  }

  // Param writes go through the bus, exactly as the UI does.
  for (const pair of opts.sets) {
    const eq = pair.indexOf('=');
    if (eq < 0) throw new Error(`--set expects id=value, got "${pair}"`);
    const id = pair.slice(0, eq);
    const value = Number(pair.slice(eq + 1));
    if (!Number.isFinite(value)) throw new Error(`--set value must be numeric: "${pair}"`);
    await page.evaluate((a) => window.__synth.bus.set(a.id, a.value), { id, value });
    console.log(`audio-bench: ${id} = ${value}`);
  }

  const download = page.waitForEvent('download', { timeout: 180_000 });

  if (opts.demo) {
    // One full pass of the longest enabled chain, then auto-stop — deterministic
    // and directly comparable between takes.
    console.log(
      `audio-bench: rendering ${opts.runs} song pass${opts.runs === 1 ? '' : 'es'}`
      + `${opts.tailBar ? ' + a tail bar' : ''}…`,
    );
    await page.evaluate(
      (a) => window.__synth.engine.recorder.exportSong(a.format, { runs: a.runs, tailBar: a.tailBar }),
      { format: opts.format, runs: opts.runs, tailBar: opts.tailBar },
    );
  } else {
    console.log(`audio-bench: holding ${notes.join(', ')} at vel ${opts.velocity} for ${opts.seconds}s…`);
    await page.evaluate((a) => {
      const bus = window.__synth.bus;
      window.__synth.engine.recorder.startManual();
      for (const n of a.notes) bus.noteOn(n, a.velocity);
    }, { notes, velocity: opts.velocity });
    // Release a little early so the take includes the envelope + FX tail rather
    // than being cut mid-sustain.
    const holdMs = Math.max(0, opts.seconds - 1) * 1000;
    if (opts.stagger > 0) {
      // Oldest key first: with more notes than voices, that is the one whose
      // voice was stolen, so this is the ordering the bug lives in.
      const gapMs = opts.stagger * 1000;
      await page.waitForTimeout(Math.max(0, holdMs - gapMs * (notes.length - 1)));
      for (const n of notes) {
        await page.evaluate((note) => window.__synth.bus.noteOff(note), n);
        await page.waitForTimeout(gapMs);
      }
    } else {
      await page.waitForTimeout(holdMs);
      await page.evaluate((a) => {
        for (const n of a.notes) window.__synth.bus.noteOff(n);
      }, { notes });
    }
    await page.waitForTimeout(1000);
    // Stop parks the take in `review` and writes nothing — saving is the
    // separate, explicit step now (audio-export.md REQ-4).
    await page.evaluate((f) => {
      const rec = window.__synth.engine.recorder;
      rec.stopManual();
      return rec.saveTake(f);
    }, opts.format);
  }

  await (await download).saveAs(outPath);
  console.log(`\naudio-bench: wrote ${outPath}`);
} catch (err) {
  failure = err;
} finally {
  await browser.close();
  if (server) server.kill();
}

if (failure) {
  console.error('audio-bench failed:', failure.message);
  process.exit(1);
}

// Print the metrics straight away so a take is never just an opaque file.
if (opts.format === 'wav' && existsSync(outPath)) {
  const { load, analyze } = await import('./audio-metrics.mjs');
  const { x, sampleRate } = load(outPath);
  const a = analyze(x, sampleRate, {});
  console.log(`  ${a.seconds.toFixed(2)}s  peak ${a.peak.toFixed(4)}  rms ${a.rms.toFixed(4)}` +
    `  bursts ${a.bursts.runs} (${a.bursts.perSecond.toFixed(0)}/s)  maxStep ${a.bursts.maxStep.toFixed(4)}`);
  console.log(`\n  listen:  ${outPath}`);
}
