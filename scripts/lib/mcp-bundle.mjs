/**
 * Staging and packing the deployable MCP server bundle
 * (DEPLOYMENT.md → "Hosting the MCP server", mcp-server.md REQ-1b).
 *
 * Two callers, one implementation: `release.mjs` packs it alongside the `dist/`
 * artifact when cutting a version, and `pack-mcp.mjs` packs it on its own so the
 * server can be deployed and tested *before* a release exists. Those must
 * produce byte-identical layouts or testing the bundle proves nothing about the
 * one that ships.
 */
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { zipDir } from './zip.mjs';

const root = new URL('../../', import.meta.url);
const ROOT_DIR = fileURLToPath(root);

// ---------------------------------------------------------------------------
// The MCP server bundle (DEPLOYMENT.md → "Hosting the MCP server")
// ---------------------------------------------------------------------------

/**
 * Files the deployed MCP server needs, relative to `scripts/mcp/`.
 *
 * `app.js` is the Passenger startup file; `dist/song-core.mjs` is the prebuilt
 * bundle it refuses to run without (mcp-server.md REQ-3), which is the whole
 * reason this artifact exists rather than the server being told to `git pull`.
 * `websynth-mcp.mjs` and `core.mjs`'s self-build path are deliberately absent
 * from what the server ever runs — but `core.mjs` itself ships, because
 * `loadCore` is what enforces the refusal.
 */
const MCP_BUNDLE_FILES = ['app.js', 'http.mjs', 'core.mjs', 'rpc.mjs', 'tools.mjs'];

/** Run `npm run build:mcp` so `dist/song-core.mjs` matches this release. */
export function runMcpBuild() {
  const res = spawnSync('npm', ['run', 'build:mcp'], { stdio: 'inherit', cwd: ROOT_DIR, shell: true });
  if (res.error) throw new Error(`Failed to run "npm run build:mcp": ${res.error.message}`);
  if (res.status !== 0) throw new Error(`MCP core build failed (exit ${res.status}).`);
}

/**
 * Stage the deployable MCP server in a temp dir and return its path.
 *
 * The layout mirrors `scripts/mcp/` exactly — same filenames, same `dist/`
 * subdirectory — because `core.mjs` resolves the bundle relative to itself.
 * That is what lets the identical files run from the repo and from a Plesk
 * Application Root with no build-time rewriting.
 */
export function stageMcpBundle(version, provenance) {
  const stage = mkdtempSync(path.join(tmpdir(), 'websynth-mcp-'));
  const srcDir = fileURLToPath(new URL('scripts/mcp/', root));

  for (const f of MCP_BUNDLE_FILES) copyFileSync(path.join(srcDir, f), path.join(stage, f));
  mkdirSync(path.join(stage, 'dist'));
  copyFileSync(path.join(srcDir, 'dist', 'song-core.mjs'), path.join(stage, 'dist', 'song-core.mjs'));

  // Minimal and dependency-free by construction (ADR-003): `"type": "module"`
  // is what makes app.js ESM under Passenger, and `version` is what the server
  // reports from /healthz and `initialize` (core.mjs → readVersion).
  writeFileSync(
    path.join(stage, 'package.json'),
    JSON.stringify(
      {
        name: 'websynth-mcp',
        version,
        private: true,
        type: 'module',
        engines: { node: '>=20' },
      },
      null,
      2,
    ) + '\n',
  );

  writeFileSync(path.join(stage, 'README.txt'), MCP_BUNDLE_README(version, provenance));
  return stage;
}

const MCP_BUNDLE_README = (version, provenance = '') => `websynth MCP server v${version} — deploy notes
================================================

A read-only, authless MCP server over Streamable HTTP. Zero dependencies: do
NOT run "npm install". Node >= 20.
${provenance}

Plesk (panel only)
------------------
1. Subdomain (e.g. mcp.status201.com) -> Node.js:
     Application Root : this folder's contents (NOT httpdocs)
     Document Root    : httpdocs (leave empty)
     Startup File     : app.js
     Node version     : newest LTS offered (20.x+; prefer an EVEN major)
     Mode             : production
   Do not click "NPM install".
2. Enable Let's Encrypt on the subdomain.
3. On the main site's domain, Apache & nginx Settings ->
   Additional nginx directives:

     location ^~ /mcp {
         proxy_pass            https://<subdomain>/;
         proxy_ssl_server_name on;
         proxy_set_header      Host <subdomain>;
         proxy_set_header      X-Forwarded-Proto https;
         proxy_set_header      X-Forwarded-For $remote_addr;
         proxy_http_version    1.1;
         client_max_body_size  1m;
         proxy_read_timeout    30s;
     }

   X-Forwarded-For must be OVERWRITTEN, not appended: the rate limiter keys on
   the first hop, and appending would let a caller choose its own bucket.

   Never enable the Node.js extension on the main site's own domain — Passenger
   would take over its document root and change how /worklets/*.js are served,
   and audioWorklet.addModule throws on a wrong MIME type. The app would load
   and make no sound.

Verify
------
  curl -s https://<your-domain>/healthz
  curl -s https://<your-domain>/mcp -X POST \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

Full documentation: DEPLOYMENT.md in the websynth repo.
`;

/**
 * Where this bundle came from, for the README inside it.
 *
 * A bundle packed from a working tree is not the same artifact as one cut from
 * a tag, and once it is unzipped on a server nothing else says which it was.
 * That matters most in exactly the case `pack-mcp.mjs` exists for: deploying to
 * test before releasing, where "is the box running what I think?" is the whole
 * question.
 */
export function describeSource() {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  const sha = git(['rev-parse', '--short', 'HEAD']);
  if (!sha) return 'Packed from a working tree with no git metadata.\n';
  const dirty = git(['status', '--porcelain']) !== '';
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16);
  return (
    `Packed ${when} UTC from ${sha}${dirty ? ' + uncommitted changes' : ''}.\n` +
    (dirty
      ? 'NOTE: the working tree was dirty, so this is not reproducible from a\n' +
        'commit. Fine for testing; re-pack from a clean tree before relying on it.\n'
      : '')
  );
}

/**
 * Build the core, stage the bundle, and return the zip as a Buffer.
 * The single path both `release.mjs` and `pack-mcp.mjs` take.
 */
export function packMcpBundle(version) {
  runMcpBuild();
  const stage = stageMcpBundle(version, describeSource());
  try {
    return zipDir(stage, 'websynth-mcp');
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** The version in the repo's package.json — what an un-bumped pack reports. */
export function currentVersion() {
  return JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;
}
