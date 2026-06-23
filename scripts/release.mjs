#!/usr/bin/env node
// Release helper for VAST G1-J5.
//
// Takes a version (an explicit x.y.z or a major|minor|patch keyword), bumps
// package.json — which is the single source of truth the About modal reads via
// __APP_VERSION__ — and promotes the CHANGELOG's [Unreleased] section to a dated
// version heading. It then builds the app, zips the dist/ folder into a
// release artifact, and prints the exact git + GitHub steps to publish (with
// the dist zip attached to the release).
//
// Deliberately conservative: it only edits files + produces local build
// artifacts and NEVER touches git or GitHub. Run the printed commands yourself
// to commit, tag, push, and create the release.
//
// Usage:
//   npm run release -- <version|major|minor|patch> [--dry-run] [--yes] [--skip-build]
//
// Flags:
//   --dry-run     Show what would change; write/build nothing.
//   --yes, -y     Skip the confirmation prompt.
//   --skip-build  Bump files but skip the build + zip (e.g. dist/ already built).
//   --help, -h    Show usage.
//
// Zero dependencies — Node built-ins only.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const root = new URL('../', import.meta.url);
const ROOT_DIR = fileURLToPath(root);
const PKG_PATH = fileURLToPath(new URL('package.json', root));
const CHANGELOG_PATH = fileURLToPath(new URL('CHANGELOG.md', root));
const DIST_DIR = fileURLToPath(new URL('dist', root));

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

  ${c.dim('Bumps the version + CHANGELOG, builds the app, and zips dist/ into a')}
  ${c.dim('release artifact — then prints the git + gh commands to publish.')}

  ${c.dim('Usage:')}  npm run release -- <version|major|minor|patch> [--dry-run] [--yes] [--skip-build]

  ${c.dim('Examples:')}
    npm run release -- 1.4.0
    npm run release -- minor
    npm run release -- patch --dry-run

  ${c.dim('Flags:')}
    --dry-run     Preview the changes; write/build nothing.
    --yes, -y     Skip the confirmation prompt.
    --skip-build  Bump files but skip the build + zip step.
    --help, -h    Show this help.
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

/** Escape a string for safe use inside a RegExp pattern. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
// Build + zip the dist/ folder
// ---------------------------------------------------------------------------

/** Run the production build (`npm run build`), inheriting stdio. */
function runBuild() {
  // shell:true so Windows resolves npm → npm.cmd (Node refuses to spawn .cmd
  // directly since 18.20/20.12); the shell also finds `npm` on POSIX. Args are
  // static, so there's no injection surface.
  const res = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', cwd: ROOT_DIR, shell: true });
  if (res.error) die(`Failed to run "npm run build": ${res.error.message}`);
  if (res.status !== 0) {
    die(
      `Build failed (exit ${res.status}). package.json/CHANGELOG.md were already ` +
        `bumped — run "git checkout -- package.json CHANGELOG.md" before retrying.`,
    );
  }
}

// CRC32 — table-based, so we don't depend on zlib.crc32 (newer Node only).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Recursively list files under dir, returning paths relative to `dir` (posix). */
function listFiles(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = `${dir}/${entry.name}`;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(abs, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Pack a Date into DOS date + time words (used by the ZIP local header). */
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * Build a ZIP archive (Buffer) of every file under `srcDir`, with each entry
 * named `<topPrefix>/<relative path>`. Dependency-free: deflate via node:zlib,
 * CRC32 in JS. Implements the minimal local-header + central-directory + EOCD
 * structure (no Zip64 — fine for a web build).
 */
function zipDir(srcDir, topPrefix) {
  const files = listFiles(srcDir).sort();
  const local = [];
  const central = [];
  let offset = 0;

  for (const rel of files) {
    const name = `${topPrefix}/${rel}`;
    const nameBuf = Buffer.from(name, 'utf8');
    const data = readFileSync(`${srcDir}/${rel}`);
    const crc = crc32(data);
    const compressed = deflateRawSync(data);
    const { time, date } = dosDateTime(statSync(`${srcDir}/${rel}`).mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // general purpose flags
    localHeader.writeUInt16LE(8, 8); // method: deflate
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    local.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central dir header signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(8, 10); // method: deflate
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    central.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central dir size
  eocd.writeUInt32LE(offset, 16); // central dir offset

  return Buffer.concat([...local, centralBuf, eocd]);
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
  const skipBuild = argv.includes('--skip-build');
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

  if (new RegExp(`^##\\s+\\[${escapeRegExp(targetVersion)}\\]`, 'm').test(changelogRaw)) {
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
  const zipName = `dist-${tag}.zip`;
  const notesName = `dist-${tag}.notes.md`;
  const ZIP_PATH = fileURLToPath(new URL(zipName, root));
  const NOTES_PATH = fileURLToPath(new URL(notesName, root));

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
  arrow(`package.json    ${c.dim(`version → ${targetVersion}`)}`);
  arrow(`CHANGELOG.md    ${c.dim(`promote [Unreleased] → [${targetVersion}] - ${today()}`)}`);
  arrow(`${notesName}    ${c.dim('release notes (for gh --notes-file)')}`);
  if (!skipBuild) {
    arrow(`dist/           ${c.dim('build via npm run build')}`);
    arrow(`${zipName}    ${c.dim('zip of dist/ (GitHub release asset)')}`);
  }

  if (dryRun) {
    log('\n' + c.dim('  --dry-run: nothing was written or built.') + '\n');
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

  // Release notes file — referenced by the printed `gh release create` command
  // via --notes-file, so the markdown notes never need shell-escaping.
  writeFileSync(NOTES_PATH, notes + '\n');

  heading('Files written');
  ok('package.json');
  ok('CHANGELOG.md');
  ok(notesName);

  // --- Build + zip dist/ -----------------------------------------------------
  if (skipBuild) {
    log('');
    note(`--skip-build: not building. ${zipName} must already exist for the gh command below.`);
  } else {
    heading('Building app (npm run build)');
    runBuild();

    const zip = zipDir(DIST_DIR, 'dist');
    writeFileSync(ZIP_PATH, zip);
    heading('Release artifact');
    ok(`${zipName}  ${c.dim(`(${(zip.length / 1024).toFixed(0)} kB — zip of dist/)`)}`);
  }

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

  // --- GitHub release (with the dist zip attached) ---------------------------
  heading('Then: create the GitHub release (with the dist zip attached)');
  box([
    c.cyan('gh') + ` release create ${tag} --title ${tag} --notes-file ${notesName} --verify-tag ${zipName}`,
  ]);
  note('Requires the `gh` CLI (authenticated). --verify-tag uses the tag you pushed above.');
  note(`No gh? Create it at ${repoBase}/releases/new?tag=${tag} and upload ${zipName} manually.`);

  log('\n' + c.green(c.bold(`✓ Prepared ${targetVersion}.`)) + ' ' + c.dim('Run the commands above to publish.') + '\n');
}

main().catch((err) => {
  die(err && err.stack ? err.stack : String(err));
});
