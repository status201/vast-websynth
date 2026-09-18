#!/usr/bin/env node
// REQ renamer — migrates one spec's numeric ids to slugs (ADR-021), everywhere.
//
// An id is cited from other specs, the root docs, source comments, tests and e2e
// specs, in four different shapes, so renaming one by hand is a tree-wide edit
// nobody should attempt with sed. This does the mechanical part and REFUSES the
// rest: where a reference names no spec and the file's owner is ambiguous,
// guessing would silently repoint a citation at a different requirement, which is
// exactly the rot the cross-reference lint exists to catch. Those are printed for
// a human to settle.
//
//   node scripts/req-migrate.mjs <spec-id> --init > map.json   # skeleton to fill in
//   node scripts/req-migrate.mjs <spec-id> --map map.json      # dry run (default)
//   node scripts/req-migrate.mjs <spec-id> --map map.json --apply
//   node scripts/req-migrate.mjs --audit                       # the per-file sweep
//
// The map is `{ "<old number>": "<new slug>" }`. Ids left out are not touched, so
// a spec can migrate in passes. On --apply, once nothing numeric is left, the
// spec's entry in lib/req-legacy.mjs is dropped — which is what closes the freeze
// behind it.
//
// Dev tool: never imported by the app, never run in CI.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { declaredReqs, reqKind } from './lib/spec-reqs.mjs';
import { globToRegExp } from './lib/glob.mjs';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const repoFiles = () => execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\n').filter(Boolean);

/** Files whose REQ prose is a claim about a spec — the same set the lint checks. */
const TEXT_FILE = /\.(?:md|ts|mts|js|mjs|cjs|json|css|html)$/;
/**
 * Never rewritten. Vendored and generated trees, and — the one that bites — the
 * lint's own tests, whose citations are deliberately WRONG and whose fixtures
 * declare their own made-up ids. Renaming those turns a fixture into a citation
 * of a spec that really exists and breaks the test. `spec-lint.mjs` exempts the
 * same two files from its citation sweep, for the same reason.
 */
const SKIP = /^(?:src\/vendor\/|src\/state\/demos\/|scripts\/mcp\/dist\/|node_modules\/|tests\/scripts\/spec-(?:xref|reqs)\.test\.ts$)/;

const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
/** Read as LF, remember the file's own ending, write it back unchanged. */
const split = (raw) => ({ crlf: raw.includes('\r\n'), lines: raw.split('\r\n').join('\n').split('\n') });
const join = (doc) => (doc.crlf ? doc.lines.join('\r\n') : doc.lines.join('\n'));

const TAG = String.raw`[a-z0-9]+(?:-[a-z0-9]+)*`;
const TOKEN = new RegExp(String.raw`REQ-(${TAG})`, 'g');
const MD_CITATION = new RegExp(
  String.raw`(${TAG})\.md[)\`]*(?:'s)?[\s,:→]*(?:v\d+,?\s*)?REQ-${TAG}(?:\s*[/,]\s*REQ-${TAG})*`, 'g');
const BARE_CITATION = new RegExp(
  String.raw`(?<![\w./-])(${TAG}) REQ-${TAG}(?:\s*[/,]\s*REQ-${TAG})*`, 'g');
/**
 * The markdown-link form, with the same loose window `spec-lint` gives it:
 * `[the progress bar](progress-bar.md) (its REQ-1/REQ-2)`. Prose can sit between
 * the link and the id, which is why the two tighter patterns above miss it — and
 * why the lint found a citation this tool had left behind.
 */
const LINK_CITATION = new RegExp(
  String.raw`\]\((?:[^)]*/)?(${TAG})\.md(?:#[^)]*)?\)[^.]{0,60}?REQ-${TAG}(?:\s*[/,]\s*REQ-${TAG})*`, 'g');
/** `REQ-9..REQ-12` and `REQ-9/10/11`: shorthands with no slug equivalent. */
const RANGE = /REQ-\d+[a-z]?\s*(?:\.\.\.?|…|–|—|-{2,}| to | through )\s*REQ?-?\d/;
const SHORTHAND = /REQ-\d+[a-z]?(?:\s*\/\s*\d+[a-z]?)+/;

/** spec id → the file it lives in, for every spec the lint recognises. */
function specIndex() {
  const out = new Map();
  for (const f of repoFiles()) {
    if (!f.startsWith('specs/') || !f.endsWith('.md')) continue;
    const base = path.basename(f);
    if (base === 'README.md' || base.startsWith('_')) continue;
    out.set(path.basename(f, '.md'), f);
  }
  return out;
}

/**
 * code file → the specs that claim it, via `source:` and `# pinned by:`. This is
 * the only evidence in the repo for what a bare `REQ-<id>` in a comment refers to,
 * and it is evidence, not proof — which is why a file two specs both claim is
 * reported rather than rewritten.
 */
function ownerIndex(specs) {
  const all = repoFiles();
  const owners = new Map();
  for (const [id, file] of specs) {
    const text = read(file);
    const toks = [];
    const yaml = text.match(/```yaml\r?\n([\s\S]*?)```/);
    if (yaml) {
      const lines = yaml[1].split(/\r?\n/);
      const at = lines.findIndex((l) => /^source:/.test(l));
      if (at >= 0) {
        for (let i = at + 1; i < lines.length; i++) {
          const m = lines[i].match(/^\s+-\s+(\S+)/);
          if (!m) { if (/^\S/.test(lines[i])) break; continue; }
          if (!m[1].includes('<')) toks.push(m[1].replace(/,$/, ''));
        }
      }
    }
    for (const m of text.matchAll(/#\s*pinned by:\s*(.+)/g)) {
      for (const p of m[1].split(/[,\s]+/)) {
        if (/^(?:tests|e2e|src|public|scripts)\//.test(p)) toks.push(p.replace(/[.,;)]+$/, ''));
      }
    }
    for (const tok of toks) {
      for (const f of (/[*?]/.test(tok) ? all.filter((x) => globToRegExp(tok).test(x)) : [tok])) {
        if (!owners.has(f)) owners.set(f, new Set());
        owners.get(f).add(id);
      }
    }
  }
  return owners;
}

/**
 * Every `REQ-<id>` on the line, with the spec each one is anchored to (or null).
 *
 * `known` is every real spec id, and filtering by it is load-bearing rather than
 * tidy: in `[the bar](progress-bar.md) (its REQ-1)` the bare pattern also matches
 * `its REQ-1`, and an anchor on a spec called "its" would hide the real one and
 * leave the citation behind. The lint only ever treats a bare id as a citation
 * when it names an actual spec; this has to read it the same way.
 */
function tokensOn(line, known) {
  const anchors = [];
  for (const re of [MD_CITATION, BARE_CITATION, LINK_CITATION]) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      if (known.has(m[1])) anchors.push({ id: m[1], start: m.index, end: m.index + m[0].length });
    }
  }
  const out = [];
  TOKEN.lastIndex = 0;
  for (const m of line.matchAll(TOKEN)) {
    const a = anchors.find((x) => m.index >= x.start && m.index < x.end);
    out.push({ tag: m[1], start: m.index, end: m.index + m[0].length, anchor: a ? a.id : null });
  }
  return out;
}

/**
 * Re-wrap the declaration bullets this rename lengthened, back to the ~80 columns
 * the specs are written at. A slug is longer than a number, so without this every
 * one of them ends up with a first line running past the margin.
 *
 * Only the bullet's opening paragraph is touched — it stops at a blank line, the
 * next bullet, a heading or a fence — and a paragraph holding a fence, a table or
 * a nested bullet is left alone rather than reflowed into something wrong.
 */
function rewrapDeclarations(lines, width = 80) {
  const indent = '  ';
  for (let i = 0; i < lines.length; i++) {
    if (!/^- \*\*REQ-/.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && lines[end].startsWith(indent) && lines[end].trim() !== ''
      && !/^\s*[-*]\s/.test(lines[end]) && !/^\s*```/.test(lines[end]) && !lines[end].includes('|')) end++;
    if (lines.slice(i, end).every((l) => l.length <= width)) { i = end - 1; continue; }
    const para = [lines[i], ...lines.slice(i + 1, end).map((l) => l.slice(indent.length))].join(' ');
    const out = [];
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (line && ((out.length ? indent : '') + line + ' ' + word).length > width) {
        out.push((out.length ? indent : '') + line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push((out.length ? indent : '') + line);
    lines.splice(i, end - i, ...out);
    i += out.length - 1;
  }
  return lines;
}

/**
 * The per-file sweep: every bare numeric id left in the code, grouped by the file
 * that holds it.
 *
 * A bare `(REQ-5)` in a comment names no spec, and the shared files are claimed by
 * dozens, so no rename can place one from the outside. What does place it is
 * reading the file — the surrounding comment says which subsystem it is about. So
 * these are collected here and settled once per file, instead of being re-reported
 * on every spec migration that happens to share the file. The lint has never been
 * able to check them either way, so deferring breaks nothing.
 */
function auditBare(specs, owners, known) {
  const byFile = new Map();
  for (const file of repoFiles()) {
    if (SKIP.test(file) || !TEXT_FILE.test(file) || file.startsWith('specs/')) continue;
    const raw = read(file);
    if (!raw.includes('REQ-')) continue;
    split(raw).lines.forEach((line, i) => {
      if (!line.includes('REQ-')) return;
      for (const t of tokensOn(line, known)) {
        if (t.anchor || !/^[0-9]+[a-z]?$/.test(t.tag)) continue;
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push({ line: i + 1, tag: t.tag, text: line.trim() });
      }
    });
  }
  const total = [...byFile.values()].reduce((a, b) => a + b.length, 0);
  console.log(`${total} bare numeric id(s) in ${byFile.size} file(s), most-loaded first.\n`);
  for (const [file, hits] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    const own = owners.get(file);
    console.log(`${file}  (${hits.length})  claimed by: ${own ? [...own].join(', ') : 'no spec'}`);
    for (const h of hits) console.log(`  ${String(h.line).padStart(5)}  REQ-${h.tag}  | ${h.text.slice(0, 108)}`);
    console.log('');
  }
}

/**
 * The spec a citation names when the citation is split across a line break:
 *
 *     …reallocates each channel's buffers to match ([scope](scope.md)
 *     REQ-<id>). Because it applies live, …
 *
 * Both the lint and this tool read line by line, so the second line looks bare —
 * and inside `scope.md`'s *own* spec a bare id is that spec's, which is how an id
 * cited there from performance-mode.md was once rewritten with
 * performance-mode's slug. 130 citations in the tree are split this way. So a line
 * whose previous line ENDS with a known spec's `.md` and carries no id of its own
 * lends that spec to the ids at the start of this one.
 */
function carriedAnchor(prevLine, known) {
  if (!prevLine) return null;
  // The spec name ENDING the line is the signal — not the absence of ids on it. A
  // requirement bullet always carries its own id, and one in sequencer.md ends
  // with a link to banks.md whose id opens the next line; bailing on "the previous
  // line mentions an id" missed exactly that shape and mis-renamed it.
  const m = prevLine.match(/([a-z0-9]+(?:-[a-z0-9]+)*)\.md[)`'\s]*$/);
  return m && known.has(m[1]) ? m[1] : null;
}

/** The skeleton map: every numeric id left in the spec, with a gist of its body. */
function printSkeleton(specId, specFile) {
  const lines = read(specFile).split(/\r?\n/);
  const numeric = declaredReqs(read(specFile)).filter((r) => reqKind(r.tag) === 'numeric');
  // The `(determinate)` / `(v4)` parenthetical stays in the gist: where a spec has
  // one it is usually the best name the author already wrote.
  const body = numeric.map((r, i) => {
    const gist = (lines[r.line - 1] ?? '')
      .replace(/^- \*\*REQ-[^*]+\*\*\s*/, '').replace(/^[—-]\s*/, '')
      .replace(/[*`]/g, '').slice(0, 88);
    const comma = i === numeric.length - 1 ? '' : ',';   // JSON has no trailing comma
    return `  "${r.tag}": ""${comma}${' '.repeat(Math.max(1, 15 - r.tag.length - comma.length))}// ${gist}`;
  }).join('\n');
  console.log(`{\n${body}\n}`);
  console.log(`\n// ${numeric.length} numeric id(s) in ${specFile}. Name every one, then:`);
  console.log(`//   node scripts/req-migrate.mjs ${specId} --map <file>`);
}

function main() {
  const argv = process.argv.slice(2);
  const specId = argv.find((a) => !a.startsWith('-'));
  const apply = argv.includes('--apply');
  const specs = specIndex();
  if (argv.includes('--audit')) {
    auditBare(specs, ownerIndex(specs), new Set(specs.keys()));
    return;
  }
  if (!specId || !specs.has(specId)) {
    console.error('usage: node scripts/req-migrate.mjs <spec-id> [--init | --map <file> [--apply]]');
    if (specId) console.error(`unknown spec: ${specId}`);
    process.exit(1);
  }
  const specFile = specs.get(specId);
  if (argv.includes('--init')) { printSkeleton(specId, specFile); return; }

  const mapArg = argv[argv.indexOf('--map') + 1];
  if (!argv.includes('--map') || !mapArg || !existsSync(mapArg)) {
    console.error('--map <file> is required (or --init to print a skeleton)');
    process.exit(1);
  }
  // Tolerate the `//` comments --init writes, so a filled-in skeleton is usable as is.
  const map = new Map(Object.entries(JSON.parse(
    readFileSync(mapArg, 'utf8').split('\n').map((l) => l.replace(/\s*\/\/.*$/, '')).join('\n'),
  )));
  for (const [from, to] of map) {
    if (!to) { console.error(`map: REQ-${from} has no slug yet`); process.exit(1); }
    if (reqKind(to) !== 'slug') { console.error(`map: "${to}" is not a valid slug`); process.exit(1); }
  }
  const declared = declaredReqs(read(specFile));
  const declaredTags = new Set(declared.map((r) => r.tag));
  for (const from of map.keys()) {
    if (!declaredTags.has(from)) console.error(`map: warning — ${specFile} declares no REQ-${from}`);
  }

  const owners = ownerIndex(specs);
  const known = new Set(specs.keys());
  const specFiles = new Set(specs.values());
  const reqsOf = new Map([...specs].map(([id, f]) => [id, new Set(declaredReqs(read(f)).map((r) => r.tag))]));
  const changed = [];
  const refused = [];
  const deferred = new Map();
  let rewrites = 0;

  for (const file of repoFiles()) {
    if (SKIP.test(file) || !TEXT_FILE.test(file)) continue;
    const raw = read(file);
    if (!raw.includes('REQ-')) continue;
    const doc = split(raw);
    let touched = false;
    // Is this file about this spec at all? One that the spec neither claims nor is
    // named in is simply not ours: its bare `REQ-1` belongs to whichever spec does
    // own it, and reporting every such line would bury the real refusals under the
    // hundreds of files that merely happen to have a REQ-1 of their own.
    const owned = owners.get(file);
    const related = file === specFile || Boolean(owned?.has(specId))
      || doc.lines.some((l) => l.includes('REQ-') && tokensOn(l, known).some((t) => t.anchor === specId));
    // A bare id inside ANOTHER spec is that spec's own — `audio-export.md` saying
    // "(REQ-4)" means its REQ-4, whatever else the paragraph links to. Only this
    // spec's own file, and the code, can hold a bare id that belongs to us.
    const bareIdsCouldBeOurs = file === specFile || !specFiles.has(file);
    // A file named after the spec — `tests/ui/lazy-load-failure.test.ts`,
    // `src/ui/components/progress-bar.ts` — is that spec's own, and its bare ids
    // are too. Without this the spec's own test ends up half-migrated: the
    // citations that name a spec become slugs while the bare ones next to them
    // stay numbers, which reads worse than either.
    const stem = path.basename(file).replace(/\.(?:test|spec|module)\.[a-z]+$/, '').replace(/\.[a-z]+$/, '');
    const isNamesake = stem === specId;

    doc.lines.forEach((line, i) => {
      if (!line.includes('REQ-')) return;
      const where = `${file}:${i + 1}`;
      if (RANGE.test(line) || SHORTHAND.test(line)) {
        const toks = tokensOn(line, known).filter((t) => map.has(t.tag));
        if (toks.some((t) => t.anchor === specId)
          || (related && bareIdsCouldBeOurs && toks.some((t) => !t.anchor))) {
          refused.push({ where, line: line.trim(), why: 'a range or `/n/n` shorthand — no slug equivalent; expand it by hand' });
        }
        return;
      }
      const all = tokensOn(line, known);
      // A carried anchor only reaches the ids at the START of the line — the tail
      // of the split citation. Anything after ordinary prose resumes is not covered.
      const carry = carriedAnchor(doc.lines[i - 1], known);
      if (carry) {
        let end = 0;
        for (const t of all) {
          const gap = line.slice(end, t.start);
          if (!/^[\s*/#>|()[\]'"`,-]*$/.test(gap)) break;
          if (!t.anchor) t.anchor = carry;
          end = t.end;
        }
      }
      const toks = all.filter((t) => map.has(t.tag));
      if (!toks.length) return;

      const keep = [];
      for (const t of toks) {
        if (t.anchor === specId) { keep.push(t); continue; }
        if (t.anchor) continue;                          // names another spec: not ours
        // Unanchored: only the owning spec gives a bare id its meaning.
        if (file === specFile) { keep.push(t); continue; }
        if (!bareIdsCouldBeOurs) continue;               // another spec's own id
        if (isNamesake) { keep.push(t); continue; }      // the spec's own namesake file
        if (!related) continue;                          // nothing ties this file to us
        const own = owned;
        if (!own) {
          refused.push({ where, line: line.trim(), why: `no spec claims this file, so a bare REQ-${t.tag} cannot be placed` });
          continue;
        }
        if (own.size === 1 && own.has(specId)) { keep.push(t); continue; }
        const claimants = [...own].filter((id) => reqsOf.get(id)?.has(t.tag));
        if (claimants.length === 1 && claimants[0] === specId) { keep.push(t); continue; }
        // Ambiguous: several specs claim the file and more than one declares this
        // number. These are deferred to the per-file sweep (`--audit`) rather than
        // printed one by one — the shared files (`engine.ts`, `app.ts`,
        // `params.ts`) are claimed by 25-35 specs each, so printing them here would
        // repeat the same lines on every migration and bury the actionable ones.
        // Reading one file once and placing all of its bare ids is the cheaper pass.
        if (claimants.includes(specId)) deferred.set(file, (deferred.get(file) ?? 0) + 1);
      }
      if (!keep.length) return;

      // Right to left, so an earlier span's offsets stay valid.
      let out = line;
      for (const t of keep.sort((a, b) => b.start - a.start)) {
        out = out.slice(0, t.start) + `REQ-${map.get(t.tag)}` + out.slice(t.end);
        rewrites++;
      }
      doc.lines[i] = out;
      touched = true;
    });

    if (touched) {
      if (file === specFile) rewrapDeclarations(doc.lines);
      changed.push(file);
      if (apply) writeFileSync(path.join(ROOT, file), join(doc));
    }
  }

  // Once the spec has no numbers left, its ceiling has nothing left to permit.
  const remaining = declared.filter((r) => reqKind(r.tag) === 'numeric' && !map.has(r.tag));
  if (apply && !remaining.length) {
    const ledger = 'scripts/lib/req-legacy.mjs';
    const before = read(ledger);
    const entry = new RegExp(String.raw`^\s*\['${specId}',.*$`);
    const after = before.split('\n').filter((l) => !entry.test(l)).join('\n');
    if (after !== before) {
      writeFileSync(path.join(ROOT, ledger), after);
      console.log(`ledger: dropped '${specId}' — it has no numbers left to permit`);
    }
  }

  console.log(`${apply ? 'applied' : 'DRY RUN'}: ${rewrites} rewrite(s) of ${map.size} id(s) across ${changed.length} file(s)`);
  for (const f of changed) console.log(`  ${f}`);
  if (remaining.length) {
    console.log(`\n${remaining.length} numeric id(s) still unmapped: ${remaining.map((r) => `REQ-${r.tag}`).join(', ')}`);
  }
  if (refused.length) {
    console.log(`\n${refused.length} reference(s) NOT rewritten — settle each by hand:`);
    for (const r of refused) console.log(`  ${r.where}\n    ${r.why}\n    | ${r.line.slice(0, 120)}`);
  }
  const deferredTotal = [...deferred.values()].reduce((a, b) => a + b, 0);
  if (deferredTotal) {
    console.log(`\n${deferredTotal} bare id(s) in ${deferred.size} file(s) shared with other specs — deferred to the`);
    console.log('per-file sweep (`node scripts/req-migrate.mjs --audit`), which reads each file once:');
    for (const [f, n] of [...deferred].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${f}`);
  }
  if (!apply) console.log('\nNothing was written. Re-run with --apply once the refusals above are settled.');
}

main();
