/**
 * Loading the song-core bundle, shared by every entry (mcp-server.md REQ-3).
 * Extracted from websynth-mcp.mjs when the HTTP transport arrived and needed
 * the same staleness check with the opposite answer for a missing bundle.
 *
 * Two callers, two policies:
 *   - `selfBuild: true`  — the local entries. A clean checkout needs only
 *     `npm install`; the bundle is rebuilt whenever the core sources move.
 *   - `selfBuild: false` — the deployed entry. Production has no node_modules
 *     to build from, and a server that shells out to a bundler in response to
 *     an unauthenticated request would be a far worse thing than a server that
 *     refuses to start. So a missing bundle throws.
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const distFile = path.join(here, 'dist', 'song-core.mjs');

const log = (...a) => process.stderr.write(`[websynth-mcp] ${a.join(' ')}\n`);

/** Newest mtime under the paths that feed the core bundle. */
function newestSourceMtime() {
  const roots = [
    path.join(here, 'song-core-entry.ts'),
    path.join(here, 'vite.lib.config.ts'),
    path.join(repoRoot, 'src', 'state'),
    path.join(repoRoot, 'src', 'utils'),
  ];
  let newest = 0;
  const visit = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) visit(path.join(p, f));
    } else {
      newest = Math.max(newest, st.mtimeMs);
    }
  };
  for (const r of roots) if (existsSync(r)) visit(r);
  return newest;
}

async function ensureCore() {
  const stale = !existsSync(distFile) || statSync(distFile).mtimeMs < newestSourceMtime();
  if (!stale) return;
  log('building song-core bundle (vite lib mode)…');
  const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteBin)) throw new Error(`${viteBin} is missing — run \`npm install\` first`);
  // The build runs in a CHILD process, never here. Vite bundles with rolldown,
  // whose native binding Windows locks for the lifetime of whatever loaded it —
  // in a server that outlives the client's session that pins node_modules, and
  // the next `npm ci` dies with EPERM on a file nobody can see is in use. It
  // also makes REQ-1a structural: the child has no handle on our stdout, so
  // nothing it prints can corrupt the protocol stream.
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [viteBin, 'build', '--config', path.join(here, 'vite.lib.config.ts'), '--logLevel', 'silent'],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const relay = (chunk) => process.stderr.write(chunk);
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`song-core build exited with code ${code}`)),
    );
  });
  if (!existsSync(distFile)) throw new Error('song-core build produced no bundle');
  log('song-core bundle ready');
}

/**
 * The song core, built first if this entry is allowed to build (REQ-3).
 * @param {{selfBuild?: boolean}} [opts]
 */
export async function loadCore({ selfBuild = true } = {}) {
  if (selfBuild) {
    await ensureCore();
  } else if (!existsSync(distFile)) {
    throw new Error(
      `${distFile} is missing. This entry does not self-build: run \`npm run build:mcp\` ` +
        'and ship the bundle alongside it (see DEPLOYMENT.md).',
    );
  }
  return import(pathToFileURL(distFile).href);
}

/**
 * The server version, reported by `initialize` and `/healthz`.
 *
 * Two layouts, one lookup. In the repo this file is `scripts/mcp/core.mjs` and
 * the version lives two levels up. In the deployed bundle (DEPLOYMENT.md) the
 * same files sit in the Plesk Application Root with their own minimal
 * `package.json` beside them — which is checked first, so the deployed server
 * reports the release it was cut from rather than guessing.
 */
export function readVersion() {
  for (const p of [path.join(here, 'package.json'), path.join(repoRoot, 'package.json')]) {
    if (!existsSync(p)) continue;
    try {
      const v = JSON.parse(readFileSync(p, 'utf8')).version;
      if (v) return v;
    } catch {
      // A malformed package.json is not worth failing a boot over.
    }
  }
  return '0.0.0';
}
