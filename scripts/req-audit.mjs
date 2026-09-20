#!/usr/bin/env node
// REQ citation auditor — finds citations that RESOLVE but name the wrong rule.
//
// `spec-lint` checks that every `REQ-<slug>` a file cites is declared somewhere.
// Because a slug is unique repo-wide (ADR-021), a citation that points at the
// WRONG requirement still resolves, so the lint passes and the comment lies.
//
// The ADR-021 migration (e790e0b) is where they came from. Its own commit
// message records the mechanism: a bare `REQ-<n>` names no spec, so the renamer
// had to decide which spec's numbering the number belonged to, and where it
// guessed wrong the number was rewritten with a slug from a different spec.
// Anchored citations (`x.md REQ-<n>`) carry their spec and survived intact —
// this tool exists for the bare ones.
//
// Method:
//   1. Recover each spec's `<number> -> <slug>` map by aligning its REQ
//      declaration order at e790e0b^ against e790e0b. Declaration order is
//      stable across the rename, so position i before is position i after.
//   2. For every citation in the CURRENT tree, recover the number it was by
//      matching its comment TEXT against the pre-migration file — the migration
//      changed REQ tokens and nothing else, so a line that still reads the same
//      apart from its REQ tokens identifies its own original numbers exactly.
//      (Text matching, not line position: these files have been edited since,
//      and a positional pair silently misattributes wherever one was added.)
//   3. Anchored citations are then checked mechanically: the named spec's map
//      must send <n> to that slug. A mismatch is a PROVEN error.
//   4. Bare ones cannot be decided mechanically, so they are scored. Every spec
//      declaring a REQ-<n> offers a candidate slug; candidates are ranked by
//      word overlap between the requirement's own prose and the comment the
//      citation sits in, and reported where one clearly beats the slug present.
//
// A bare report is a CANDIDATE, not a verdict. The tool proposes; a human reads
// the comment and the requirement and decides. Expect false positives wherever a
// correct citation simply shares no vocabulary with the rule it names.
//
//   node scripts/req-audit.mjs                 # bare candidates, grouped by file
//   node scripts/req-audit.mjs --all           # every recovered bare citation
//   node scripts/req-audit.mjs --anchored      # the mechanical check only
//   node scripts/req-audit.mjs --file src/audio/engine.ts
//   node scripts/req-audit.mjs --map audio-lifecycle    # a spec's number -> slug
//
// Dev tool: never imported by the app, never run in CI.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** The ADR-021 slug migration. Everything here is relative to it. */
const MIGRATION = 'e790e0b';
const BEFORE = `${MIGRATION}^`;

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const ROOT = git(['rev-parse', '--show-toplevel']).trim();

/** Read as LF regardless of the file's own endings (this tree is mixed). */
const lf = (s) => s.replace(/\r\n/g, '\n');
const show = (rev, file) => {
  try {
    return lf(execFileSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore','pipe','ignore'] }));
  } catch {
    return null;
  }
};

/** Vendored, generated, and the lint's own deliberately-wrong fixtures. */
const SKIP =
  /^(?:src\/vendor\/|src\/state\/demos\/|scripts\/mcp\/dist\/|node_modules\/|tests\/scripts\/spec-(?:xref|reqs)\.test\.ts$)/;

const SLUG_CITE = /REQ-[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g;
const NUM_CITE = /REQ-\d+[a-z]?(?![\w-])/g;
/** An `x.md` (or a link to one) close enough in front to anchor a citation. */
const ANCHOR_BEFORE = /([a-z0-9-]+)(?:\.md)?[)`'s]*[\s,:→v\d]*(?:REQ-[a-z0-9-]+[\s,/]*)*$/;
const ANCHOR_MD = /([a-z0-9-]+)\.md[)`'s]*[\s,:→v\d]*(?:REQ-[a-z0-9-]+[\s,/]*)*$/;

// ---------------------------------------------------------------- spec maps

const REQ_DEF_NUM = /^\s*-\s+\*\*REQ-(\d+[a-z]?)\*\*/gm;
const REQ_DEF_SLUG = /^\s*-\s+\*\*(REQ-[a-z][a-z0-9]*(?:-[a-z0-9]+)*)\*\*/gm;
const REQ_DEF_PROSE =
  /^\s*-\s+\*\*(REQ-[a-z][a-z0-9]*(?:-[a-z0-9]+)*)\*\*\s*(?:\([^)]*\))?\s*—?([^\n]*(?:\n(?!\s*-\s+\*\*REQ)[^\n]*){0,3})/gm;

/** `- **REQ-x** — <prose>`, with the two following lines, for a tag pattern. */
const declRe = (tagPat) =>
  new RegExp(
    String.raw`^[ \t]*-[ \t]+\*\*(REQ-${tagPat})\*\*[ \t]*(?:\([^)]*\))?[ \t]*—?[ \t]*`
      + String.raw`([^\n]*(?:\n(?![ \t]*-[ \t]+\*\*REQ)[^\n]*){0,2})`,
    'gm',
  );

/** A requirement's prose, reduced to something the rename could not change. */
const sigOf = (s) =>
  s.replace(/REQ-[a-z0-9-]+/g, ' ')
    .replace(/\(v\d+[^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();

const declsIn = (text, tagPat) =>
  [...text.matchAll(declRe(tagPat))].map((m) => ({ tag: m[1], sig: sigOf(m[2] ?? '') }));

const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

function buildSpecIndex() {
  const specs = git(['ls-tree', '-r', '--name-only', BEFORE, 'specs/'])
    .split('\n')
    .filter((f) => f.endsWith('.md'));

  const numToSlug = new Map(); // spec -> Map(n -> slug)
  const prose = new Map(); // slug -> text
  const specOf = new Map(); // slug -> spec
  const claims = new Map(); // source file -> [spec]
  const stemOf = new Map(); // "engine" -> specs/features/engine.md

  for (const spec of specs) {
    const before = show(BEFORE, spec);
    const after = show(MIGRATION, spec);
    if (!before || !after) continue;

    // Match each renamed requirement to its number by PROSE, not position. The
    // migration rewrote REQ tokens and nothing else, so a requirement's own
    // sentence is a stable key — and unlike position it survives the commit
    // also splitting one requirement into several (motion-sequencer's pad
    // gesture set became a parent plus (a)/(b)/(c)), which is why 43 specs had
    // no positional map at all.
    const oldDecls = declsIn(before, String.raw`\d+[a-z]?`);
    const newDecls = declsIn(after, String.raw`[a-z][a-z0-9]*(?:-[a-z0-9]+)*`);
    const m = new Map();
    const used = new Set();
    for (const nd of newDecls) {
      if (!nd.sig) continue;
      let best = null;
      let bestLen = 0;
      for (const od of oldDecls) {
        if (used.has(od.tag) || !od.sig) continue;
        const len = commonPrefix(od.sig, nd.sig);
        if (len > bestLen) { bestLen = len; best = od; }
      }
      // A shared opening of this length is the same sentence, not a coincidence.
      // Keyed by the bare number ("2"), which is how a citation carries it.
      if (best && bestLen >= 24) { m.set(best.tag.slice(4), nd.tag); used.add(best.tag); }
    }
    if (m.size) numToSlug.set(spec, m);
    // Fall back to position only where prose recovered nothing and the counts
    // line up exactly.
    const nums = [...before.matchAll(REQ_DEF_NUM)].map((x) => x[1]);
    const slugs = [...after.matchAll(REQ_DEF_SLUG)].map((x) => x[1]);
    if (!m.size && nums.length && nums.length === slugs.length) {
      const pm = new Map();
      nums.forEach((n, i) => pm.set(n, slugs[i]));
      numToSlug.set(spec, pm);
    }
    for (const m of after.matchAll(REQ_DEF_PROSE)) {
      if (!prose.has(m[1])) prose.set(m[1], `${m[1].slice(4).replace(/-/g, ' ')} ${m[2] ?? ''}`);
      if (!specOf.has(m[1])) specOf.set(m[1], spec);
    }
    stemOf.set(path.basename(spec, '.md'), spec);

    const src = after.match(/^source:\n((?:[ \t]+-[ \t]+\S+.*\n)+)/m);
    if (src) {
      for (const line of src[1].split('\n')) {
        const f = line.match(/-[ \t]+(\S+)/);
        if (!f) continue;
        if (!claims.has(f[1])) claims.set(f[1], []);
        claims.get(f[1]).push(spec);
      }
    }
  }
  // What the specs declare TODAY. The maps above describe the tree as it was at
  // the migration, and requirements have been renamed since (motion-sequencer's
  // "two extra tracks" became "extra single-param tracks" when the count stopped
  // being two). A citation naming today's slug is right even though the
  // migration-era map disagrees, and a slug that no longer exists must never be
  // proposed — so every verdict below is filtered through this set.
  const live = new Set();
  const liveSpecOf = new Map();
  const walkSpecs = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walkSpecs(p);
      else if (e.endsWith('.md')) {
        const rel = path.relative(ROOT, p).split(path.sep).join('/');
        for (const m of lf(readFileSync(p, 'utf8')).matchAll(REQ_DEF_SLUG)) {
          live.add(m[1]);
          if (!liveSpecOf.has(m[1])) liveSpecOf.set(m[1], rel);
        }
      }
    }
  };
  walkSpecs(path.join(ROOT, 'specs'));

  return { numToSlug, prose, specOf, claims, stemOf, live, liveSpecOf };
}

// ------------------------------------------------- recover each citation's N

/** A line reduced to "everything except which REQs it names". */
const shape = (line) =>
  line.replace(SLUG_CITE, '\u0001').replace(NUM_CITE, '\u0001').replace(/\s+/g, ' ').trim();

/**
 * For one file, pair every CURRENT citation with the number it used to be, by
 * matching comment text against the pre-migration copy. A line whose shape
 * occurs exactly once on each side, with the same number of REQ tokens, is an
 * unambiguous match; anything else is left unrecovered rather than guessed.
 */
function recoverFile(file) {
  const before = show(BEFORE, file);
  const abs = path.join(ROOT, file);
  if (!before || !existsSync(abs)) return [];
  const now = lf(readFileSync(abs, 'utf8')).split('\n');

  const oldByShape = new Map();
  before.split('\n').forEach((l) => {
    if (!l.includes('REQ-')) return;
    const s = shape(l);
    if (!oldByShape.has(s)) oldByShape.set(s, []);
    oldByShape.get(s).push([...l.matchAll(NUM_CITE)].map((m) => m[0].slice(4)));
  });

  const out = [];
  now.forEach((line, i) => {
    if (!line.includes('REQ-')) return;
    const hits = [...line.matchAll(SLUG_CITE)];
    if (!hits.length) return;
    const cands = oldByShape.get(shape(line));
    // Unique shape match, same token count — otherwise we do not know.
    if (!cands || cands.length !== 1 || cands[0].length !== hits.length) return;
    hits.forEach((h, k) => {
      const head = line.slice(0, h.index).replace(/^\s*[*/#]*\s*/, '');
      const md = ANCHOR_MD.exec(head);
      const bare = ANCHOR_BEFORE.exec(head);
      out.push({
        file,
        line: i + 1,
        text: line.trim(),
        ctx: now.slice(Math.max(0, i - 3), i + 4).join(' ').replace(SLUG_CITE, ' '),
        num: cands[0][k],
        slug: h[0],
        // `x.md REQ-…` is anchored; so is the `webrtc-sync REQ-…` short form,
        // which spec-lint also accepts. Anything else named no spec.
        anchor: md ? md[1] : bare && bare[1].includes('-') ? bare[1] : null,
        anchored: Boolean(md),
      });
    });
  });
  return out;
}

function allCitations(only) {
  const files = git(['ls-files', 'src', 'tests', 'e2e', 'public', 'scripts'])
    .split('\n')
    .filter((f) => f && /\.(ts|tsx|js|mjs|css)$/.test(f) && !SKIP.test(f))
    .filter((f) => !only || f === only);
  const out = [];
  for (const f of files) out.push(...recoverFile(f));
  return out;
}

// ---------------------------------------------------------------- scoring

const STOP = new Set(
  ('a an the is are be was were it its this that these those of to in on at by for with from and or not'
    + ' no never every each any all one two only also but so as if then than when while where which what who'
    + ' how why does do did has have had can could may might must shall should will would there their they'
    + ' them we us you your our first last next same own just even still yet already because since until'
    + ' unless though although however more most less least other another over under about after before'
    + ' between both new old out up down into via per').split(' '),
);
const stem = (w) => w.replace(/ies$/, 'y').replace(/(ing|ed|es|s)$/, '');
const words = (s) =>
  s.split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);

function score(text, ctx) {
  const have = new Set(words(ctx));
  const want = [...new Set(words(text))];
  if (!want.length) return 0;
  return want.filter((w) => have.has(w)).length / Math.sqrt(want.length);
}

// ------------------------------------------------------------------- report

const argv = process.argv.slice(2);
const only = argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : null;
const idx = buildSpecIndex();

if (argv.includes('--map')) {
  const stemArg = argv[argv.indexOf('--map') + 1];
  const spec = idx.stemOf.get(stemArg);
  if (!spec) {
    console.error(`no spec "${stemArg}". Use a bare stem, e.g. audio-lifecycle`);
    process.exit(1);
  }
  const map = idx.numToSlug.get(spec);
  if (!map) {
    console.error(`${spec}: REQ counts differ across the migration — not positionally recoverable`);
    process.exit(1);
  }
  console.log(`${spec}\n`);
  for (const [n, slug] of map) {
    const p = (idx.prose.get(slug) ?? '').replace(/\s+/g, ' ');
    console.log(`  REQ-${n.padEnd(4)} ${slug}`);
    console.log(`           ${p.slice(slug.length - 3).trim().slice(0, 96)}`);
  }
  process.exit(0);
}

const mode = argv.includes('--anchored') ? 'anchored' : argv.includes('--all') ? 'all' : 'bare';
const cites = allCitations(only);

// `--retarget <spec> [--from <spec>]` — emit a repair list (TSV) that re-resolves
// each bare citation's recovered number through <spec>'s own numbering. This is
// for a file the migration repointed WHOLESALE at one wrong spec: the numbers
// were right, only the spec they were read against was wrong. `--from` limits it
// to citations currently owned by that spec, so a file with a few genuine
// cross-references does not get them rewritten too.
//
// It prints a proposal. Read it against the code before applying any of it.
if (argv.includes('--retarget')) {
  const toStem = argv[argv.indexOf('--retarget') + 1];
  const fromStem = argv.includes('--from') ? argv[argv.indexOf('--from') + 1] : null;
  const toSpec = idx.stemOf.get(toStem);
  const map = toSpec && idx.numToSlug.get(toSpec);
  if (!map) {
    console.error(`no recoverable map for "${toStem}"`);
    process.exit(1);
  }
  let n = 0;
  for (const c of cites) {
    if (c.anchored) continue;
    const ownSpec = idx.specOf.get(c.slug);
    if (fromStem && ownSpec !== idx.stemOf.get(fromStem)) continue;
    const want = map.get(c.num);
    if (!want || want === c.slug || !idx.live.has(want)) continue;
    if (idx.live.has(c.slug) && idx.liveSpecOf.get(c.slug) === toSpec) continue;
    console.log([c.file, c.line, c.slug, want].join('\t'));
    n++;
  }
  console.error(`\n${n} proposed (was REQ-<n> re-read against ${toSpec})`);
  process.exit(0);
}
const anchored = cites.filter((c) => c.anchored);
const bare = cites.filter((c) => !c.anchored);
console.log(`citations recovered: ${cites.length}   (anchored ${anchored.length} / bare ${bare.length})\n`);

const short = (s) => s.replace('specs/features/', '').replace('specs/', '');

if (mode === 'anchored') {
  let checked = 0;
  const wrong = [];
  for (const c of anchored) {
    const spec = idx.stemOf.get(c.anchor);
    const map = spec && idx.numToSlug.get(spec);
    const expect = map && map.get(c.num);
    if (!expect) continue;
    // An expectation the specs no longer declare means the requirement was
    // renamed AFTER the migration (motion-sequencer's "two extra tracks" became
    // "extra single-param tracks" in v17). The code tracks today's name and the
    // migration-era map is simply out of date, so there is nothing to report.
    if (!idx.live.has(expect)) continue;
    checked++;
    if (expect !== c.slug) wrong.push({ ...c, expect });
  }
  console.log(`mechanically checkable: ${checked}\nprovably wrong: ${wrong.length}\n`);
  for (const w of wrong) {
    console.log(`${w.file}:${w.line}   ${w.anchor}.md REQ-${w.num}`);
    console.log(`   | ${w.text.slice(0, 100)}`);
    console.log(`   is:     ${w.slug}`);
    console.log(`   should: ${w.expect}\n`);
  }
  process.exit(0);
}

const byFile = new Map();
for (const c of bare) {
  const cands = [];
  for (const [spec, map] of idx.numToSlug) {
    const slug = map.get(c.num);
    if (!slug) continue;
    if (!idx.live.has(slug)) continue;
    cands.push({ slug, spec, owns: (idx.claims.get(c.file) ?? []).includes(spec), score: 0 });
  }
  if (!cands.length) continue;
  for (const cd of cands) cd.score = score(idx.prose.get(cd.slug) ?? cd.slug, c.ctx);
  // A spec that claims this file in its `source:` block gets a nudge: it is the
  // likeliest owner of a citation that named no spec at all.
  const rank = (x) => x.score + (x.owns ? 0.35 : 0);
  const best = [...cands].sort((a, b) => rank(b) - rank(a))[0];
  const cur = cands.find((x) => x.slug === c.slug);
  const suspicious = best.slug !== c.slug && best.score > 0.35 && (cur ? cur.score : 0) < 0.12;
  if (mode === 'bare' && !suspicious) continue;
  if (!byFile.has(c.file)) byFile.set(c.file, []);
  byFile.get(c.file).push({
    line: c.line,
    text: c.text,
    num: c.num,
    is: c.slug,
    isSpec: cur ? cur.spec : idx.specOf.get(c.slug) ?? '?',
    should: best.slug,
    shouldSpec: best.spec,
  });
}
for (const v of byFile.values()) v.sort((a, b) => a.line - b.line);

const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`${mode === 'bare' ? 'candidates' : 'recovered bare citations'}: `
  + `${files.reduce((n, [, v]) => n + v.length, 0)} across ${files.length} files\n`);

for (const [file, hits] of files) {
  const specs = [...new Set(hits.map((h) => short(h.isSpec)))];
  console.log(`${file}  (${hits.length}${specs.length === 1 ? ` -> all ${specs[0]}` : ''})`);
  for (const h of hits) {
    console.log(`   :${h.line}  was REQ-${h.num}`);
    console.log(`      | ${h.text.slice(0, 100)}`);
    console.log(`      is:     ${h.is}  [${short(h.isSpec)}]`);
    console.log(`      should: ${h.should}  [${short(h.shouldSpec)}]`);
  }
  console.log();
}
