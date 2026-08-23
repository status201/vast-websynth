#!/usr/bin/env node
/**
 * websynth MCP server — song authoring & validation for AI agents, over stdio
 * (specs/features/mcp-server.md REQ-1a). Hand-rolled JSON-RPC 2.0 with
 * newline-delimited framing, zero dependencies beyond the repo's own dev
 * toolchain (Vite is only needed to (re)build the song-core bundle).
 *
 * PROTOCOL PURITY: stdout carries JSON-RPC frames ONLY. Every log goes to
 * stderr, and console.log/info/warn are redirected to stderr for the whole
 * process lifetime as a belt-and-braces guard. The self-build is stronger than
 * that: it runs in a child process whose stdout is piped to our stderr, so it
 * cannot reach the protocol stream even in principle.
 *
 * This is the LOCAL profile: all ten tools, writes included (REQ-10). The
 * public endpoint is `app.js` / `websynth-mcp-http.mjs` — same dispatcher,
 * different framing and no write tools.
 *
 * Register in an MCP client as: `node scripts/mcp/websynth-mcp.mjs` with this
 * repo as cwd (see .mcp.json). First start self-builds
 * scripts/mcp/dist/song-core.mjs; later starts rebuild only when src/state,
 * src/utils, or the entry changed.
 */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadCore, repoRoot } from './core.mjs';

const log = (...a) => process.stderr.write(`[websynth-mcp] ${a.join(' ')}\n`);

// stdout is protocol-only (REQ-1a): anything that logs via console must land
// on stderr, including Vite during the self-build.
console.log = console.info = console.warn = (...a) =>
  process.stderr.write(a.map(String).join(' ') + '\n');

async function main() {
  const core = await loadCore({ selfBuild: true });
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
