#!/usr/bin/env node
// Release helper for VAST G1-J5.
//
// Takes a version (an explicit x.y.z or a major|minor|patch keyword), bumps
// package.json — which is the single source of truth the About modal reads via
// __APP_VERSION__ — and promotes the CHANGELOG's [Unreleased] section to a dated
// version heading. It then prints the exact git + GitHub steps to publish.
//
// Deliberately conservative: it edits files only and NEVER touches git. Run the
// printed commands yourself to commit, tag, and push.
//
// Usage:
//   npm run release -- <version|major|minor|patch> [--dry-run] [--yes]
//
// Flags:
//   --dry-run   Show what would change; write nothing.
//   --yes, -y   Skip the confirmation prompt.
//   --help, -h  Show usage.
//
// Zero dependencies — Node built-ins only.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const root = new URL('../', import.meta.url);
const PKG_PATH = fileURLToPath(new URL('package.json', root));
const CHANGELOG_PATH = fileURLToPath(new URL('CHANGELOG.md', root));

// ---------------------------------------------------------------------------
// Pretty console output (degrades when not a TTY or NO_COLOR is set)
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  cyan: paint('36'),
};

const log = (s = '') => process.stdout.write(s + '\n');
const heading = (s) => log('\n' + c.bold(c.cyan('▌ ' + s)));
const ok = (s) => log(c.green('  ✓ ') + s);
const arrow = (s) => log(c.blue('  → ') + s);
const note = (s) => log(c.dim('    ' + s));

function die(msg) {
  log('\n' + c.red(c.bold('✗ ' + msg)) + '\n');
  process.exit(1);
}

function box(lines) {
  const width = Math.max(...lines.map((l) => stripAnsi(l).length));
  const bar = '─'.repeat(width + 2);
  log(c.dim('  ┌' + bar + '┐'));
  for (const l of lines) {
    const pad = ' '.repeat(width - stripAnsi(l).length);
    log(c.dim('  │ ') + l + pad + c.dim(' │'));
  }
  log(c.dim('  └' + bar + '┘'));
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function usage() {
  log(`
${c.bold('VAST G1-J5 — release helper')}

  ${c.dim('Usage:')}  npm run release -- <version|major|minor|patch> [--dry-run] [--yes]

  ${c.dim('Examples:')}
    npm run release -- 1.4.0
    npm run release -- minor
    npm run release -- patch --dry-run

  ${c.dim('Flags:')}
    --dry-run   Preview the changes; write nothing.
    --yes, -y   Skip the confirmation prompt.
    --help, -h  Show this help.
`);
}

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

function parseVersion(v) {
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 if a<b, 0 if equal core, 1 if a>b. */
function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function bumpVersion(core, kind) {
  const [maj, min, pat] = core;
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  return null;
}

// ---------------------------------------------------------------------------
// Confirmation prompt
// ---------------------------------------------------------------------------
function confirm(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(c.yellow('? ') + question + c.dim(' [y/N] '), (answer) => {
      rl.close();
      // readline resumes stdin; rl.close() doesn't release it, which keeps the
      // event loop (and the process) alive after we're done. unref it so the
      // script exits on its own once main() finishes.
      process.stdin.unref?.();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// ---------------------------------------------------------------------------
// CHANGELOG parsing / rewriting
// ---------------------------------------------------------------------------

/**
 * Split the changelog into: text before the [Unreleased] heading, the
 * [Unreleased] body, the rest (subsequent version sections), and the trailing
 * link-reference block. Returns null if [Unreleased] can't be found.
 */
function parseChangelog(text) {
  const lines = text.split('\n');
  const unrelIdx = lines.findIndex((l) => /^##\s+\[Unreleased\]/i.test(l));
  if (unrelIdx === -1) return null;

  // Body runs from just after the heading up to the next "## [" heading.
  let nextHeadingIdx = lines.length;
  for (let i = unrelIdx + 1; i < lines.length; i++) {
    if (/^##\s+\[/.test(lines[i])) {
      nextHeadingIdx = i;
      break;
    }
  }

  const before = lines.slice(0, unrelIdx); // everything above the heading
  const body = lines.slice(unrelIdx + 1, nextHeadingIdx);
  const after = lines.slice(nextHeadingIdx); // remaining version sections + links

  return { before, body, after };
}

/** Trim leading/trailing blank lines from an array of lines. */
function trimBlankLines(arr) {
  let start = 0;
  let end = arr.length;
  while (start < end && arr[start].trim() === '') start++;
  while (end > start && arr[end - 1].trim() === '') end--;
  return arr.slice(start, end);
}

/** Does the [Unreleased] body contain at least one real bullet entry? */
function hasEntries(bodyLines) {
  return bodyLines.some((l) => /^\s*[-*]\s+\S/.test(l));
}

/** Find the most recent already-released version heading (the "previous"). */
function findPreviousVersion(afterLines) {
  for (const l of afterLines) {
    const m = /^##\s+\[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/.exec(l);
    if (m) return m[1];
  }
  return null;
}

/** Derive the GitHub repo base (https://github.com/owner/repo) from a link ref. */
function findRepoBase(afterLines) {
  for (const l of afterLines) {
    const m = /\]:\s*(https:\/\/github\.com\/[^/]+\/[^/\s]+)\//.exec(l);
    if (m) return m[1];
  }
  return null;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Rewrite the changelog: promote [Unreleased] to a dated version section, open a
 * fresh empty [Unreleased], and update the link references at the bottom.
 */
function rewriteChangelog({ before, body, after }, version, repoBase, prevVersion) {
  const date = today();
  const notesBody = trimBlankLines(body);

  // Rebuild the body region.
  const out = [];
  out.push(...before);
  out.push('## [Unreleased]');
  out.push('');
  out.push(`## [${version}] - ${date}`);
  out.push('');
  out.push(...notesBody);
  out.push('');

  // `after` holds prior version sections followed by the link-ref block. Rewrite
  // the link refs: update the Unreleased compare line and insert the new tag.
  const rewrittenAfter = [];
  const tagLink = prevVersion
    ? `[${version}]: ${repoBase}/compare/v${prevVersion}...v${version}`
    : `[${version}]: ${repoBase}/releases/tag/v${version}`;
  let insertedTagLink = false;

  for (const line of after) {
    if (/^\[Unreleased\]:/i.test(line)) {
      rewrittenAfter.push(`[Unreleased]: ${repoBase}/compare/v${version}...HEAD`);
      rewrittenAfter.push(tagLink);
      insertedTagLink = true;
    } else {
      rewrittenAfter.push(line);
    }
  }
  if (!insertedTagLink) {
    // No Unreleased link ref existed — append a link block at the very end.
    if (rewrittenAfter.length && rewrittenAfter[rewrittenAfter.length - 1].trim() !== '') {
      rewrittenAfter.push('');
    }
    rewrittenAfter.push(`[Unreleased]: ${repoBase}/compare/v${version}...HEAD`);
    rewrittenAfter.push(tagLink);
  }

  out.push(...rewrittenAfter);

  // Collapse 3+ blank lines to a single blank, ensure trailing newline.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '') + '\n';
}

// ---------------------------------------------------------------------------
// Render the extracted release notes (for the GitHub release body)
// ---------------------------------------------------------------------------
function renderNotes(bodyLines) {
  return trimBlankLines(bodyLines).join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const dryRun = argv.includes('--dry-run');
  const skipConfirm = argv.includes('--yes') || argv.includes('-y');
  const positionals = argv.filter((a) => !a.startsWith('-'));

  if (positionals.length !== 1) {
    usage();
    die('Expected exactly one version argument (x.y.z, major, minor, or patch).');
  }
  const requested = positionals[0];

  // --- Read current version --------------------------------------------------
  let pkgRaw;
  try {
    pkgRaw = readFileSync(PKG_PATH, 'utf8');
  } catch {
    die(`Could not read ${PKG_PATH}`);
  }
  const pkg = JSON.parse(pkgRaw);
  const currentVersion = pkg.version;
  const currentCore = parseVersion(currentVersion);
  if (!currentCore) die(`package.json has an unparseable version: "${currentVersion}"`);

  // --- Resolve target version ------------------------------------------------
  let targetVersion;
  if (requested === 'major' || requested === 'minor' || requested === 'patch') {
    targetVersion = bumpVersion(currentCore, requested);
  } else {
    targetVersion = requested.replace(/^v/, '');
  }
  const targetCore = parseVersion(targetVersion);
  if (!targetCore) {
    die(`"${requested}" is not a valid version. Use x.y.z or major|minor|patch.`);
  }
  if (cmpVersion(targetCore, currentCore) <= 0) {
    die(
      `Target version ${targetVersion} is not greater than current ${currentVersion}.`,
    );
  }

  // --- Read & parse the changelog -------------------------------------------
  let changelogRaw;
  try {
    changelogRaw = readFileSync(CHANGELOG_PATH, 'utf8');
  } catch {
    die(`Could not read ${CHANGELOG_PATH}. Create it first (Keep a Changelog format).`);
  }

  if (new RegExp(`^##\\s+\\[${targetVersion.replace(/\./g, '\\.')}\\]`, 'm').test(changelogRaw)) {
    die(`CHANGELOG.md already has a section for ${targetVersion}.`);
  }

  const parsed = parseChangelog(changelogRaw);
  if (!parsed) die('CHANGELOG.md has no "## [Unreleased]" section.');

  const repoBase = findRepoBase(parsed.after) || findRepoBase(parsed.before);
  if (!repoBase) {
    die('Could not determine the GitHub repo URL from CHANGELOG.md link references.');
  }
  const prevVersion = findPreviousVersion(parsed.after);
  const notes = renderNotes(parsed.body);
  const tag = `v${targetVersion}`;

  // --- Preview ---------------------------------------------------------------
  heading('Release preview');
  arrow(`${c.bold(currentVersion)} ${c.dim('→')} ${c.bold(c.green(targetVersion))}   (tag ${c.bold(tag)})`);
  note(`repo: ${repoBase}`);
  if (prevVersion) note(`previous: v${prevVersion}`);

  heading(`Release notes for ${targetVersion}`);
  if (notes.trim() === '') {
    log(c.yellow('  (the [Unreleased] section is empty)'));
  } else {
    for (const line of notes.split('\n')) log('  ' + line);
  }

  if (!hasEntries(parsed.body)) {
    log('');
    log(c.yellow('  ⚠ The [Unreleased] section has no entries. Add changes before releasing.'));
  }

  heading('Files to change');
  arrow(`package.json   ${c.dim(`version → ${targetVersion}`)}`);
  arrow(`CHANGELOG.md   ${c.dim(`promote [Unreleased] → [${targetVersion}] - ${today()}`)}`);

  if (dryRun) {
    log('\n' + c.dim('  --dry-run: no files were written.') + '\n');
    return;
  }

  // --- Confirm ---------------------------------------------------------------
  if (!skipConfirm) {
    log('');
    const yes = await confirm(`Write these changes for ${c.bold(targetVersion)}?`);
    if (!yes) {
      log('\n' + c.dim('  Aborted. Nothing was written.') + '\n');
      process.exit(1);
    }
  }

  // --- Write files -----------------------------------------------------------
  // package.json: targeted replace of the version line to keep a one-line diff.
  const newPkgRaw = pkgRaw.replace(
    /("version"\s*:\s*")[^"]*(")/,
    `$1${targetVersion}$2`,
  );
  if (newPkgRaw === pkgRaw) die('Failed to update the version field in package.json.');
  writeFileSync(PKG_PATH, newPkgRaw);

  const newChangelog = rewriteChangelog(parsed, targetVersion, repoBase, prevVersion);
  writeFileSync(CHANGELOG_PATH, newChangelog);

  heading('Files written');
  ok('package.json');
  ok('CHANGELOG.md');

  // --- Publish playbook ------------------------------------------------------
  const commitMsg = `[RELEASE] ${tag}`;
  heading('Next: commit, tag & push');
  box([
    c.cyan('git') + ' add package.json CHANGELOG.md',
    c.cyan('git') + ` commit -m ${JSON.stringify(commitMsg)}`,
    c.cyan('git') + ` tag -a ${tag} -m ${JSON.stringify(tag)}`,
    c.cyan('git') + ' push origin main --follow-tags',
  ]);
  note('--follow-tags pushes the annotated tag alongside the commit.');

  // --- GitHub release link ---------------------------------------------------
  const releaseUrl =
    `${repoBase}/releases/new?tag=${encodeURIComponent(tag)}` +
    `&title=${encodeURIComponent(tag)}` +
    `&body=${encodeURIComponent(notes)}`;

  heading('Then: create the GitHub release');
  arrow('Open this prefilled link (notes already filled in):');
  log('  ' + c.blue(releaseUrl));
  note('Or paste the notes shown above into a new release for ' + tag + '.');

  log('\n' + c.green(c.bold(`✓ Prepared ${targetVersion}.`)) + ' ' + c.dim('Run the commands above to publish.') + '\n');
}

main().catch((err) => {
  die(err && err.stack ? err.stack : String(err));
});
