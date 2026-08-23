#!/usr/bin/env node
/**
 * Local HTTP entry for the websynth MCP server (mcp-server.md REQ-1b).
 *
 * The same server the public endpoint runs, with one difference: it self-builds
 * the song-core bundle (REQ-3), so `npm run start:mcp:http` works in a fresh
 * checkout the way the stdio entry does. `app.js` is the deployed twin and does
 * not build.
 *
 * This exists so the whole thing — bounds, status codes, the read-only tool
 * profile — can be exercised before it ever reaches a server:
 *
 *   npm run start:mcp:http
 *   claude mcp add --transport http websynth-local http://127.0.0.1:8787/mcp
 */
import process from 'node:process';
import { startServer } from './http.mjs';

startServer({ selfBuild: true }).catch((e) => {
  process.stderr.write(`[websynth-mcp] fatal: ${e?.stack ?? String(e)}\n`);
  process.exit(1);
});
