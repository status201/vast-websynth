#!/usr/bin/env node
// Spec-structure lint (see specs/README.md → "Enforcement & exemptions").
//
// The SDD guard (scripts/sdd-guard.mjs) checks that a spec *changed*; this checks
// that each spec is structurally *well-formed* and that the hand-maintained
// indexes stay complete. Zero-dep. Runs three ways:
//   • `npm run spec:lint` / `node scripts/spec-lint.mjs` — lint all, exit 1 on error
//   • CI (.github/workflows/sdd.yml)                     — same
//   • local Stop hook (`spec-lint.mjs hook`) — only when specs/ changed this turn;
//     exit 2 to block finishing, so a malformed spec is caught at edit time too
// It complements — never replaces — human review of spec quality.
//
// Per spec under specs/ (skipping README.md and any _*.md template):
//   • a leading ```yaml metadata block
//   • `id` present and equal to the filename (without .md)
//   • a valid `status` — ADR lifecycle under decisions/, else feature lifecycle
//   • every root-anchored `# pinned by:` path resolves (literal exists; glob ≥1)
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

function lint(failExit) {
  const errors = [];
  const warnings = [];
  const allMd = walk(SPECS).filter((f) => f.endsWith('.md'));
  const specs = allMd.filter((f) => {
    const base = path.basename(f);
    return base !== 'README.md' && !base.startsWith('_');
  });

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
function specsChanged() {
  return Boolean(git(['status', '--porcelain', '--', 'specs'], ROOT));
}

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

// Stop-hook mode: skip unless specs changed this turn, and never loop on ourselves;
// block (exit 2) on failure so the agent fixes the spec before finishing.
async function runHook() {
  const input = parseJson(await readStdin());
  if (input?.stop_hook_active) process.exit(0);
  if (!specsChanged()) process.exit(0);
  lint(2);
}

if ((process.argv[2] || '') === 'hook') {
  runHook();
} else {
  lint(1);
}
