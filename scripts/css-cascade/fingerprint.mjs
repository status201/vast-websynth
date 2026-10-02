/**
 * Cascade fingerprint — proves a CSS refactor changed nothing on screen
 * (specs/features/css-cascade-layers.md REQ-a-cascade-refactor-is-proven-by-fingerprint).
 *
 *   node scripts/css-cascade/fingerprint.mjs --out base.ndjson.gz [--runs 2]
 *   node scripts/css-cascade/fingerprint.mjs --compare base.ndjson.gz
 *
 * Boots the app in every state × viewport from lib.mjs and records, for every element under <body> and
 * its ::before/::after, the full computed style and its bounding box. Elements
 * are keyed by their DOM path, never by class name: a CSS Module's hashed class
 * changes when a stylesheet moves, and that is exactly the kind of change this
 * tool must see through.
 *
 * `--runs 2` captures the baseline twice and records anything that differs
 * between the two as volatile (a timestamp readout, a meter) — `--compare`
 * ignores those and exits non-zero on any other difference.
 *
 * `--server preview` (default) captures the BUILT app — run `npm run build`
 * first; `--server dev` captures `vite dev`. Capture BOTH: they do not share a
 * CSS order. The build hoists a module that lazy chunks also use (switch, for
 * one) into a shared CSS chunk, so its position comes from chunking, while dev
 * injects strictly in import order — which is where e2e, and the reverted
 * app.ts split, live.
 *
 * Options: --filter <substr> (state@viewport ids), --browser firefox,
 * --port <n> (default 4179), --jobs <n> (default 3), --limit <n> diffs shown per id.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  launch, openState, parseArgs, plan, pool, startServer, stopServer,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.out && !args.compare) {
  console.error('usage: fingerprint.mjs --out <file.ndjson.gz> [--runs 2] | --compare <file.ndjson.gz>');
  process.exit(2);
}

/** Runs in the page: the computed style of every element, deduplicated. */
function capture() {
  const props = [];
  const probe = getComputedStyle(document.body);
  for (let i = 0; i < probe.length; i++) props.push(probe[i]);
  props.sort();

  const table = [];
  const index = new Map();
  const vec = (cs) => {
    const v = props.map((p) => cs.getPropertyValue(p)).join('\u0001');
    let i = index.get(v);
    if (i === undefined) { i = table.length; table.push(v); index.set(v, i); }
    return i;
  };
  const r2 = (n) => Math.round(n * 100) / 100;

  const elements = {};
  const walk = (el, path) => {
    const rect = el.getBoundingClientRect();
    const entry = { s: vec(getComputedStyle(el)), r: `${r2(rect.x)},${r2(rect.y)},${r2(rect.width)},${r2(rect.height)}` };
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      if (cs.content !== 'none' && cs.content !== 'normal') entry[pseudo] = vec(cs);
    }
    if (el.dataset?.testid) entry.t = el.dataset.testid;
    elements[path] = entry;
    let n = 0;
    for (const child of el.children) {
      walk(child, `${path}/${child.tagName.toLowerCase()}[${n++}]`);
    }
  };
  walk(document.body, 'body');
  return { props, table, elements };
}

async function captureOne(browser, url, { id, state, vp }) {
  const t0 = Date.now();
  const { page, close } = await openState(browser, url, state, vp);
  try {
    const cap = await page.evaluate(capture);
    console.error(`  ${id} — ${Object.keys(cap.elements).length} elements (${Date.now() - t0} ms)`);
    return cap;
  } finally {
    await close();
  }
}

/**
 * The file: gzipped NDJSON — a header line, then one line per state. One JSON
 * document cannot hold it: a state is ~5 MB of JSON, and a full run is past
 * V8's maximum string length. Read back line by line from the Buffer, so no
 * string ever holds more than one state.
 */
function writeFingerprint(file, header, states) {
  const lines = [Buffer.from(`${JSON.stringify(header)}\n`)];
  for (const [id, cap] of Object.entries(states)) lines.push(Buffer.from(`${JSON.stringify({ id, ...cap })}\n`));
  writeFileSync(file, gzipSync(Buffer.concat(lines)));
}

function readFingerprint(file) {
  const buf = gunzipSync(readFileSync(file));
  const docs = [];
  for (let start = 0; start < buf.length;) {
    let end = buf.indexOf(10, start);
    if (end < 0) end = buf.length;
    if (end > start) docs.push(JSON.parse(buf.toString('utf-8', start, end)));
    start = end + 1;
  }
  const [header, ...rows] = docs;
  const states = {};
  for (const { id, ...cap } of rows) states[id] = cap;
  return { ...header, states };
}

/**
 * Comparable form of a computed value: whitespace collapsed (a custom property
 * keeps its raw text, so re-indenting its stylesheet "changes" every element
 * that inherits it), and a CSS Module's hash dropped from a scoped name
 * (`_ledPulse_im0b3_1` → `_ledPulse`) — the hash follows the file's content and
 * path, so it moves whenever a stylesheet does, which is exactly the change this
 * tool must see through.
 */
const norm = (v) => v.trim().replace(/\s+/g, ' ').replace(/(_[A-Za-z][\w-]*?)_[a-z0-9]{5}_\d+/g, '$1');

/** Expand one state's capture into path → { prop → value }-ish accessors. */
function styleOf(cap, idx) {
  return cap.table[idx].split('\u0001');
}

/**
 * Every difference between two captures of one state, as human-readable lines.
 * `volatile` is a Set of `path|prop` keys to ignore.
 */
function diffState(a, b, volatile = new Set()) {
  const lines = [];
  const paths = new Set([...Object.keys(a.elements), ...Object.keys(b.elements)]);
  const propsB = new Map(b.props.map((p, i) => [p, i]));
  for (const path of paths) {
    const ea = a.elements[path];
    const eb = b.elements[path];
    const label = (ea?.t ?? eb?.t) ? `${path} [${ea?.t ?? eb?.t}]` : path;
    if (!ea || !eb) { lines.push({ key: `${path}|*`, text: `${label}: ${ea ? 'missing' : 'extra'} element` }); continue; }
    if (ea.r !== eb.r && !volatile.has(`${path}|rect`)) {
      lines.push({ key: `${path}|rect`, text: `${label}: box ${ea.r} -> ${eb.r}` });
    }
    for (const slot of ['s', '::before', '::after']) {
      if (ea[slot] === undefined && eb[slot] === undefined) continue;
      if (ea[slot] === undefined || eb[slot] === undefined) {
        lines.push({ key: `${path}${slot}|*`, text: `${label}${slot === 's' ? '' : slot}: pseudo ${ea[slot] === undefined ? 'appeared' : 'vanished'}` });
        continue;
      }
      const va = styleOf(a, ea[slot]);
      const vb = styleOf(b, eb[slot]);
      a.props.forEach((p, i) => {
        const j = propsB.get(p);
        const x = norm(va[i]);
        const y = j === undefined ? undefined : norm(vb[j]);
        const key = `${path}${slot === 's' ? '' : slot}|${p}`;
        if (x !== y && !volatile.has(key)) {
          lines.push({ key, text: `${label}${slot === 's' ? '' : slot}: ${p}: ${x} -> ${y}` });
        }
      });
    }
  }
  return lines;
}

const items = plan(args.filter);
const jobs = Number(args.jobs ?? 3);
const server = args.server ?? 'preview';
if (server !== 'preview' && server !== 'dev') throw new Error('--server is preview or dev');
const { url, child } = await startServer(server, Number(args.port ?? (server === 'dev' ? 5179 : 4179)));
const browser = await launch(args.browser);
let exit = 0;
try {
  if (args.out) {
    const runs = Number(args.runs ?? 1);
    console.error(`capturing ${items.length} state×viewport pairs, ${runs} run(s)`);
    const first = {};
    await pool(items, jobs, async (item) => { first[item.id] = await captureOne(browser, url, item); });
    const volatile = {};
    for (let r = 1; r < runs; r++) {
      // Each repeat is judged against the first as it lands, then dropped.
      await pool(items, jobs, async (item) => {
        const again = await captureOne(browser, url, item);
        const keys = diffState(first[item.id], again, new Set(volatile[item.id] ?? [])).map((l) => l.key);
        if (keys.length) volatile[item.id] = [...new Set([...(volatile[item.id] ?? []), ...keys])];
      });
    }
    for (const [id, keys] of Object.entries(volatile)) console.error(`  volatile in ${id}: ${keys.length} key(s)`);
    writeFingerprint(args.out, { browser: args.browser ?? 'chromium', server, volatile }, first);
    console.error(`wrote ${args.out}`);
  } else {
    const base = readFingerprint(args.compare);
    if ((args.browser ?? 'chromium') !== base.browser) {
      throw new Error(`baseline was captured in ${base.browser}; pass --browser ${base.browser}`);
    }
    if (server !== base.server && !args['cross-server']) {
      throw new Error(`baseline was captured on vite ${base.server}; pass --server ${base.server} (or --cross-server to compare the two on purpose)`);
    }
    // A state the baseline lacks is a failure, not a skip: silence is not "identical".
    const missing = items.filter((i) => !base.states[i.id]).map((i) => i.id);
    const present = items.filter((i) => base.states[i.id]);
    const limit = Number(args.limit ?? 40);
    const found = new Map();
    await pool(present, jobs, async (item) => {
      const now = await captureOne(browser, url, item);
      found.set(item.id, diffState(base.states[item.id], now, new Set(base.volatile[item.id] ?? [])));
    });
    let total = 0;
    for (const { id } of present) {
      const lines = found.get(id);
      if (!lines.length) continue;
      total += lines.length;
      console.log(`\n## ${id}: ${lines.length} difference(s)`);
      for (const l of lines.slice(0, limit)) console.log(`  ${l.text}`);
      if (lines.length > limit) console.log(`  … ${lines.length - limit} more`);
    }
    if (missing.length) {
      console.log(`\nnot in the baseline, so NOT compared: ${missing.join(', ')}`);
      exit = 1;
    }
    if (total) {
      console.log(`\n${total} difference(s) across ${present.length} captures`);
      exit = 1;
    } else console.log(`identical: ${present.length} captures`);
  }
} finally {
  await browser.close();
  stopServer(child);
}
process.exit(exit);
