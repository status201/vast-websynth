#!/usr/bin/env node
/**
 * websynth MCP server — song authoring & validation for AI agents
 * (specs/features/mcp-server.md). Hand-rolled stdio JSON-RPC 2.0 with
 * newline-delimited framing, zero dependencies beyond the repo's own dev
 * toolchain (Vite is only needed to (re)build the song-core bundle).
 *
 * PROTOCOL PURITY: stdout carries JSON-RPC frames ONLY. Every log goes to
 * stderr, and console.log/info/warn are redirected to stderr for the whole
 * process lifetime as a belt-and-braces guard. The self-build is stronger than
 * that: it runs in a child process whose stdout is piped to our stderr, so it
 * cannot reach the protocol stream even in principle.
 *
 * Register in an MCP client as: `node scripts/mcp/websynth-mcp.mjs` with this
 * repo as cwd (see .mcp.json). First start self-builds
 * scripts/mcp/dist/song-core.mjs; later starts rebuild only when src/state,
 * src/utils, or the entry changed.
 */
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const distFile = path.join(here, 'dist', 'song-core.mjs');

const log = (...a) => process.stderr.write(`[websynth-mcp] ${a.join(' ')}\n`);

// stdout is protocol-only (REQ-1): anything that logs via console must land
// on stderr, including Vite during the self-build.
console.log = console.info = console.warn = (...a) =>
  process.stderr.write(a.map(String).join(' ') + '\n');

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
  // also makes REQ-1 structural: the child has no handle on our stdout, so
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

async function main() {
  await ensureCore();
  const core = await import(pathToFileURL(distFile).href);
  const { makeTools } = await import('./tools.mjs');
  const { createDispatcher } = await import('./rpc.mjs');

  const version = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  const dispatch = createDispatcher({
    name: 'websynth',
    version,
    tools: makeTools(core, { cwd: process.cwd() }),
  });

  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    void dispatch(msg).then((res) => {
      if (res) send(res);
    });
  });
  rl.on('close', () => process.exit(0));

  log(`ready (stdio, v${version})`);
}

main().catch((e) => {
  log('fatal:', e?.stack ?? String(e));
  process.exit(1);
});
