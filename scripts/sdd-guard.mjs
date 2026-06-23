#!/usr/bin/env node
// SDD guard — enforces spec-driven development (see specs/README.md).
//
// One zero-dep script backing several Claude Code hooks + CI. The rule: a change
// that touches *production code* must also touch a spec under specs/ (spec-before-
// code), unless it is exempt. Exempt = an allowlisted path, or an explicit marker
// (a gitignored `.sdd-skip` sentinel locally, or `[skip-sdd]` / a `skip-sdd` label
// in CI).
//
// Modes (argv[2]):
//   pretool  PreToolUse hook  — deny an Edit/Write to gated code with no spec change
//   stop     Stop hook        — block finishing if code changed without a spec
//   remind   SessionStart     — print the procedure into context
//   ci       GitHub Action    — fail the PR if code changed without a spec
//
// Blocking is via exit code 2 (stderr is shown back to the agent) for the hook
// modes, and exit code 1 for ci. Anything unexpected fails open (exit 0) so the
// guard can never wedge a session on its own bug.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] ?? '';

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const ROOT = git(['rev-parse', '--show-toplevel'], process.cwd()) || process.cwd();

/** The base ref to diff a branch against (CI sets BASE_REF; else origin/main). */
function baseRef() {
  const env = process.env.BASE_REF || process.env.GITHUB_BASE_REF;
  if (env) return `origin/${env.replace(/^origin\//, '')}`;
  return 'origin/main';
}

/** A path is "production code" (needs a spec) unless it is on the allowlist. */
function isProductionPath(rel) {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  const gated = p.startsWith('src/') || p.startsWith('public/worklets/');
  if (!gated) return false;
  const allow =
    p.endsWith('.md') ||
    p.endsWith('.css') ||
    p.includes('/styles/') ||
    p.startsWith('src/vendor/');
  return !allow;
}

/** Convert an absolute or relative path to a repo-root-relative POSIX path. */
function toRel(file) {
  if (!file) return '';
  const abs = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
  return path.relative(ROOT, abs).replace(/\\/g, '/');
}

/** Did this change touch any spec? (uncommitted, or committed on this branch.) */
function specChanged() {
  if (git(['status', '--porcelain', '--', 'specs'], ROOT)) return true;
  const base = baseRef();
  if (base && git(['diff', '--name-only', `${base}...HEAD`, '--', 'specs'], ROOT)) return true;
  return false;
}

/** Explicit trivial-change marker. */
function markerPresent({ ci = false } = {}) {
  if (process.env.SDD_SKIP === '1') return true;
  if (existsSync(path.join(ROOT, '.sdd-skip'))) return true;
  if (ci) {
    if (process.env.SDD_SKIP_LABEL === 'true') return true;
    const log = git(['log', '--format=%B', `${baseRef()}..HEAD`], ROOT);
    if (/\[skip-sdd\]/i.test(log)) return true;
  }
  return false;
}

/** Production files changed in the working tree (staged + unstaged + untracked). */
function changedProductionWorkingTree() {
  const out = git(['status', '--porcelain'], ROOT);
  if (!out) return [];
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3); // strip the XY status + space
    const arrow = p.indexOf(' -> '); // renames: "old -> new"
    if (arrow >= 0) p = p.slice(arrow + 4);
    p = p.replace(/^"|"$/g, '');
    if (isProductionPath(p)) files.push(p);
  }
  return files;
}

/** Production files changed on this branch vs base (for CI). */
function changedProductionBranch() {
  const out = git(['diff', '--name-only', `${baseRef()}...HEAD`], ROOT);
  if (!out) return [];
  return out.split('\n').map((s) => s.trim()).filter(isProductionPath);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function parse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

const PROCEDURE = `SDD is enforced in this repo (see specs/README.md → "Procedure by change type").
Spec-before-code: a change that edits production code (src/**, public/worklets/**)
must also create/update a spec under specs/ in the same change.
  • Feature/behaviour change → write specs/features/<name>.md first (/feature, /spec)
  • Bug fix → add/correct the governing spec's scenario (a regression scenario)
  • Refactor (no behaviour change) → keep the spec's contract + scenarios green
  • Trivial (typo/comment/dep-bump/test/style/docs) → exempt; for a rare trivial
    production tweak run:  touch .sdd-skip`;

function denyPretool(rel) {
  process.stderr.write(
    `SDD gate: editing production code (${rel}) requires a spec change first.\n` +
      `Write or update the relevant spec under specs/ (spec-before-code) — e.g. /feature or /spec —\n` +
      `then retry this edit. If this change is genuinely trivial, run:  touch .sdd-skip\n` +
      `See specs/README.md → "Procedure by change type".\n`,
  );
  process.exit(2);
}

async function runPretool() {
  const input = parse(await readStdin());
  const file = input?.tool_input?.file_path;
  const rel = toRel(file);
  if (!rel || !isProductionPath(rel)) process.exit(0);
  if (markerPresent() || specChanged()) process.exit(0);
  denyPretool(rel);
}

async function runStop() {
  const input = parse(await readStdin());
  if (input?.stop_hook_active) process.exit(0); // never loop on ourselves
  const changed = changedProductionWorkingTree();
  if (changed.length === 0) process.exit(0);
  if (markerPresent() || specChanged()) process.exit(0);
  process.stderr.write(
    `SDD backstop: production code changed but no spec under specs/ was updated:\n` +
      changed.map((f) => `  - ${f}`).join('\n') +
      `\nReconcile the spec (add/update the governing spec, or a regression scenario for a fix),\n` +
      `or run  touch .sdd-skip  if this change is genuinely trivial.\n`,
  );
  process.exit(2);
}

function runRemind() {
  let out = PROCEDURE;
  const changed = changedProductionWorkingTree();
  if (changed.length > 0 && !specChanged() && !markerPresent()) {
    out += `\n\n⚠ This working tree already changes production code without a spec:\n` +
      changed.map((f) => `  - ${f}`).join('\n');
  }
  process.stdout.write(out + '\n');
  process.exit(0);
}

function runCi() {
  if (markerPresent({ ci: true })) {
    process.stdout.write('SDD check skipped (marker present).\n');
    process.exit(0);
  }
  const changed = changedProductionBranch();
  if (changed.length === 0) {
    process.stdout.write('SDD check: no production-code changes — OK.\n');
    process.exit(0);
  }
  if (specChanged()) {
    process.stdout.write('SDD check: production code changed and a spec was updated — OK.\n');
    process.exit(0);
  }
  process.stderr.write(
    `SDD check FAILED: production code changed without any spec under specs/:\n` +
      changed.map((f) => `  - ${f}`).join('\n') +
      `\nAdd/update the governing spec, or add [skip-sdd] to a commit message / the` +
      ` 'skip-sdd' PR label if this change is genuinely trivial.\n`,
  );
  process.exit(1);
}

switch (mode) {
  case 'pretool':
    await runPretool();
    break;
  case 'stop':
    await runStop();
    break;
  case 'remind':
    runRemind();
    break;
  case 'ci':
    runCi();
    break;
  default:
    process.stderr.write(`sdd-guard: unknown mode "${mode}" (use pretool|stop|remind|ci)\n`);
    process.exit(0); // fail open
}
