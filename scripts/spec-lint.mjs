#!/usr/bin/env node
// Spec-structure lint (see specs/README.md → "Enforcement & exemptions").
//
// The SDD guard (scripts/sdd-guard.mjs) checks that a spec *changed*; this checks
// that each spec is structurally *well-formed* and that the hand-maintained
// indexes stay complete. Zero-dep. Runs three ways:
//   • `npm run spec:lint` / `node scripts/spec-lint.mjs` — lint all, exit 1 on error
//   • CI (.github/workflows/sdd.yml)                     — same
//   • local Stop hook (`spec-lint.mjs hook`) — lints unconditionally (fast, and a
//     changed-this-turn gate misses turns that end after `git commit`);
//     exit 2 to block finishing, so a malformed spec is caught at edit time too
// It complements — never replaces — human review of spec quality.
//
// Per spec under specs/ (skipping README.md and any _*.md template):
//   • a leading ```yaml metadata block
//   • `id` present and equal to the filename (without .md)
//   • a valid `status` — ADR lifecycle under decisions/, else feature lifecycle
//   • every root-anchored `# pinned by:` path resolves (literal exists; glob ≥1)
//   • every gherkin `Scenario:` carries a trailing `#` note — a pin, or an
//     explicit reason there is none (warning)
// Plus repo-structure checks (drift prevention):
//   • every spec / ADR / template file is listed in the specs/README.md folder map
//   • every ADR is listed in the specs/decisions/README.md index
// `version` not being a positive integer is a warning, not a failure.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const ROOT = git(['rev-parse', '--show-toplevel'], process.cwd()) || process.cwd();
const SPECS = path.join(ROOT, 'specs');

const FEATURE_STATUS = /^(draft|active|implemented)$/;
const ADR_STATUS = /^(proposed|accepted|deprecated|superseded by adr-\d{3,})$/;
const ADR_FILE = /^adr-\d{3,}-.+\.md$/;
const PRUNE = new Set(['node_modules', '.git', 'dist', 'playwright-report', 'coverage']);

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

/** Recursively collect file paths under `dir` (absolute), pruning build dirs. */
function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (PRUNE.has(ent.name) || ent.name.startsWith('dist-v')) continue;
      walk(path.join(dir, ent.name), out);
    } else {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

/** Lazily-built set of every repo file as a root-relative POSIX path (for globs). */
let _repoFiles = null;
function repoFiles() {
  if (_repoFiles) return _repoFiles;
  _repoFiles = walk(ROOT).map(rel);
  return _repoFiles;
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else { re += '[^/]*'; }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** First ```yaml fenced block's body, or null. */
function metadataBlock(text) {
  const m = text.match(/```ya?ml\s*\n([\s\S]*?)\n```/);
  return m ? m[1] : null;
}

/** The fenced code block under "## Folder map" in the specs README, or ''. */
function folderMapBlock(readme) {
  const after = readme.split('## Folder map')[1];
  if (!after) return '';
  const m = after.match(/```[a-z]*\r?\n([\s\S]*?)\r?\n```/);
  return m ? m[1] : '';
}

/** Top-level (column-0) scalar key from a flat YAML block. */
function topKey(block, key) {
  const re = new RegExp('^' + key + ':\\s*(.*)$', 'm');
  const m = block.match(re);
  if (!m) return null;
  return m[1].split('#')[0].trim().replace(/^["']|["']$/g, '');
}

/**
 * Path/glob tokens referenced by every `# pinned by:` line. The convention is
 * free-form prose (mixed `,`/`;` separators, bare symbols, spec cross-refs), so
 * we extract only **root-anchored** path substrings (src/ tests/ e2e/ public/
 * scripts/) and ignore everything else. Placeholders (`<name>`, `...`) are skipped.
 */
function pinnedPaths(text) {
  const tokens = [];
  for (const m of text.matchAll(/#\s*pinned by:\s*(.+)/gi)) {
    for (const pm of m[1].matchAll(/\b(?:src|tests|e2e|public|scripts)\/[\w./*[\]<>-]+/g)) {
      const tok = pm[0].replace(/[).,;]+$/, '');
      if (tok.includes('<') || tok.includes('...')) continue; // placeholders
      tokens.push(tok);
    }
  }
  return tokens;
}

/**
 * Path/glob tokens listed under the metadata block's `source:` key — the files a
 * spec claims implement it. Same literal/glob treatment as `pinnedPaths`, but a
 * far tighter grammar (one path per `- ` item), so we parse rather than scrape.
 * Prose paths elsewhere in a spec stay unchecked on purpose: an "Open questions"
 * section legitimately names a file that does not exist yet.
 */
function sourcePaths(block) {
  const m = block.match(/^source:\s*\n((?:[ \t]+-[ \t].*\n?)+)/m);
  if (!m) return [];
  const out = [];
  for (const line of m[1].split('\n')) {
    const v = line.replace(/^[ \t]*-[ \t]*/, '').split('#')[0].trim();
    if (!v || v.includes('<') || v.includes('...')) continue; // placeholders
    out.push(v);
  }
  return out;
}

/** Headings that end the requirements region — everything after is not a REQ list. */
const AFTER_REQS = /^## (Technical design|Visual aids|Scenarios|Tests & verification|Open questions)/;

/**
 * `REQ-<n><suffix>` ids declared between `## Requirements` and the first
 * design/scenario/test heading, in document order. The window deliberately spans
 * intermediate `##` sections: a spec that grew in versioned rounds
 * (`midi-clock-sync.md`'s "## v2 additions", "## v3 fix — …") keeps declaring
 * REQs under them, and those are declarations like any other.
 *
 * Only a top-level `- **REQ-n**` bullet declares one — a prose bullet that merely
 * *starts* with a REQ reference does not, which is why the bold must close right
 * after the id.
 */
function declaredReqs(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0) { if (/^## Requirements/.test(lines[i])) start = i; }
    else if (AFTER_REQS.test(lines[i])) { end = i; break; }
  }
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^- \*\*REQ-(\d+[a-z]*)\*\*/);
    if (m) out.push({ tag: m[1], line: i + 1 });
  }
  return out;
}

/** Sort key for a REQ tag: `5` < `5a` < `5b` < `6`. */
function reqKey(tag) {
  const m = tag.match(/^(\d+)([a-z]*)$/);
  return [Number(m[1]), m[2]];
}

/**
 * Scenarios inside a ```gherkin block that carry no trailing `#` comment at all.
 *
 * A scenario is a claim, and the convention is that it says how the claim is
 * held: `# pinned by: tests/…` normally, or an explicit note (`# by design:`,
 * `# NOT AUTOMATED`, `# verified manually on device`) when nothing automated
 * can. Silence is the third state, and the one worth reporting — it reads as a
 * gap whether or not it is one, so a later sweep has to re-derive the answer.
 *
 * A comment may cover the run of scenarios above it (specs/README.md), so the
 * search runs to the next `Scenario:` or the block's closing fence — and a
 * comment on the line *after* the fence still counts, which is where a pin for
 * the whole block conventionally sits.
 *
 * Warning, not error: a spec being drafted has scenarios before it has tests,
 * and blocking that would push authors toward writing the pin first and the
 * test never.
 */
function unpinnedScenarios(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inGherkin = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```\s*gherkin\s*$/i.test(lines[i])) { inGherkin = true; continue; }
    if (!inGherkin) continue;
    if (/^\s*```\s*$/.test(lines[i])) { inGherkin = false; continue; }

    const m = lines[i].match(/^\s*Scenario(?: Outline)?:\s*(.+)$/);
    if (!m) continue;
    let annotated = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*Scenario(?: Outline)?:/.test(lines[j])) break;
      if (/^\s*#/.test(lines[j])) { annotated = true; break; }
      if (/^\s*```\s*$/.test(lines[j])) { annotated = /^\s*#/.test(lines[j + 1] ?? ''); break; }
    }
    if (!annotated) out.push({ name: m[1].trim(), line: i + 1 });
  }
  return out;
}

function lint(failExit) {
  const errors = [];
  const warnings = [];
  const allMd = walk(SPECS).filter((f) => f.endsWith('.md'));
  const specs = allMd.filter((f) => {
    const base = path.basename(f);
    return base !== 'README.md' && !base.startsWith('_');
  });

  // Cross-spec `REQ-n` references are checked against this, so it must be built
  // before the per-spec pass.
  const reqsById = new Map();
  for (const file of specs) {
    reqsById.set(path.basename(file, '.md'),
      new Set(declaredReqs(readFileSync(file, 'utf8')).map((r) => r.tag)));
  }

  for (const file of specs) {
    const r = rel(file);
    const err = (msg) => errors.push(`${r}: ${msg}`);
    const warn = (msg) => warnings.push(`${r}: ${msg}`);
    const text = readFileSync(file, 'utf8');

    const block = metadataBlock(text);
    if (!block) {
      err('no leading ```yaml metadata block');
      continue;
    }

    const id = topKey(block, 'id');
    const expectedId = path.basename(file, '.md');
    if (!id) err('metadata is missing `id`');
    else if (id !== expectedId) err(`\`id: ${id}\` does not match filename (\`${expectedId}\`)`);

    const isAdr = r.includes('/decisions/');
    const status = topKey(block, 'status');
    const allowed = isAdr ? ADR_STATUS : FEATURE_STATUS;
    if (!status) err('metadata is missing `status`');
    else if (!allowed.test(status)) {
      err(`invalid \`status: ${status}\` (expected ${isAdr
        ? 'proposed | accepted | deprecated | superseded by adr-NNN'
        : 'draft | active | implemented'})`);
    }

    const version = topKey(block, 'version');
    if (version !== null && !/^[1-9]\d*$/.test(version)) {
      warn(`\`version: ${version}\` is not a positive integer`);
    }

    for (const tok of pinnedPaths(text)) {
      if (/[*?[]/.test(tok)) {
        const re = globToRegExp(tok);
        if (!repoFiles().some((f) => re.test(f))) err(`\`# pinned by:\` glob matches no file: ${tok}`);
      } else if (!existsSync(path.join(ROOT, tok))) {
        err(`\`# pinned by:\` path does not exist: ${tok}`);
      }
    }

    // A stale `source:` entry is how a spec starts lying about where its code
    // lives — the same check `# pinned by:` already gets, applied to the claim
    // that matters most.
    for (const tok of sourcePaths(block)) {
      if (/[*?[]/.test(tok)) {
        const re = globToRegExp(tok);
        if (!repoFiles().some((f) => re.test(f))) err(`\`source:\` glob matches no file: ${tok}`);
      } else if (!existsSync(path.join(ROOT, tok))) {
        err(`\`source:\` path does not exist: ${tok}`);
      }
    }

    // REQ ids: unique, and in ascending order so the list reads 1,2,3. They are
    // stable cross-spec identifiers, so a REQ inserted later is APPENDED and the
    // bullet moved into place — never renumbered.
    const reqs = declaredReqs(text);
    const seen = new Map();
    for (const { tag, line } of reqs) {
      if (seen.has(tag)) err(`duplicate \`REQ-${tag}\` (line ${line}; first at line ${seen.get(tag)})`);
      else seen.set(tag, line);
    }
    for (let i = 1; i < reqs.length; i++) {
      const [pn, ps] = reqKey(reqs[i - 1].tag);
      const [cn, cs] = reqKey(reqs[i].tag);
      if (cn < pn || (cn === pn && cs < ps)) {
        err(`\`REQ-${reqs[i].tag}\` (line ${reqs[i].line}) is out of order — it follows \`REQ-${reqs[i - 1].tag}\``);
        break; // one report per spec; the whole list needs re-sorting anyway
      }
    }
    // A gap is only a warning: a reserved range is plausible, a scrambled list is not.
    const nums = [...new Set(reqs.map((r) => reqKey(r.tag)[0]))];
    if (nums.length) {
      const missing = [];
      for (let n = 1; n <= Math.max(...nums); n++) if (!nums.includes(n)) missing.push(n);
      if (missing.length) warn(`gap in the REQ sequence: no REQ-${missing.join(', REQ-')}`);
    }

    // Every scenario says how it is held — a test, or an explicit reason there
    // is none. See `unpinnedScenarios` for why this is a warning.
    for (const { name, line } of unpinnedScenarios(text)) {
      warn(`line ${line}: scenario "${name}" names no \`# pinned by:\` test and gives no reason`);
    }

    // A cross-spec `[x](x.md) … REQ-n` must actually find REQ-n in x.md — this is
    // what rots when a REQ is renumbered and its referrers are not.
    text.split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(/\]\(([a-z0-9-]+)\.md(?:#[^)]*)?\)[^.]{0,60}?REQ-(\d+[a-z]*)/g)) {
        const target = reqsById.get(m[1]);
        if (!target) err(`line ${i + 1}: reference to unknown spec \`${m[1]}.md\``);
        else if (!target.has(m[2])) err(`line ${i + 1}: \`${m[1]}.md\` declares no \`REQ-${m[2]}\``);
      }
    });
  }

  // Structure: the hand-maintained enumerations must stay complete — this catches
  // the exact drift the lint exists to prevent (a new spec/ADR never indexed).
  const map = folderMapBlock(existsSync(path.join(SPECS, 'README.md'))
    ? readFileSync(path.join(SPECS, 'README.md'), 'utf8') : '');
  if (!map) {
    errors.push('specs/README.md: could not find the "## Folder map" code block');
  } else {
    for (const f of allMd) {
      if (path.basename(f) === 'README.md') continue; // the index files themselves
      if (!map.includes(path.basename(f))) errors.push(`${rel(f)}: not listed in the specs/README.md folder map`);
    }
  }

  const adrIndexFile = path.join(SPECS, 'decisions', 'README.md');
  const adrIndex = existsSync(adrIndexFile) ? readFileSync(adrIndexFile, 'utf8') : '';
  if (!adrIndex) {
    errors.push('specs/decisions/README.md: ADR index is missing');
  } else {
    for (const f of allMd) {
      if (ADR_FILE.test(path.basename(f)) && !adrIndex.includes(path.basename(f))) {
        errors.push(`${rel(f)}: not listed in the specs/decisions/README.md index`);
      }
    }
  }

  if (warnings.length) {
    process.stdout.write(`spec-lint: ${warnings.length} warning(s):\n` +
      warnings.map((w) => `  ⚠ ${w}`).join('\n') + '\n');
  }
  if (errors.length) {
    process.stderr.write(`spec-lint FAILED: ${errors.length} error(s):\n` +
      errors.map((e) => `  ✗ ${e}`).join('\n') +
      `\nFix the spec(s) above, or update the README folder map / decisions index.\n`);
    process.exit(failExit);
  }
  process.stdout.write(`spec-lint: ${specs.length} specs OK.\n`);
  process.exit(0);
}

/** Did the working tree touch anything under specs/ this turn? */
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// Stop-hook mode: lint unconditionally (a changed-this-turn gate misses turns
// that end after `git commit` — the tree is clean by then), but never loop on
// ourselves; block (exit 2) on failure so the agent fixes the spec before finishing.
async function runHook() {
  const input = parseJson(await readStdin());
  if (input?.stop_hook_active) process.exit(0);
  lint(2);
}

if ((process.argv[2] || '') === 'hook') {
  runHook();
} else {
  lint(1);
}
