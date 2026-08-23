/**
 * Deployed entry for the public websynth MCP server (mcp-server.md REQ-1b/9e).
 *
 * This is the Passenger startup file named in the Plesk Node.js settings, and
 * it is the file the release bundle (`mcp-v<version>.zip`) puts in the
 * Application Root — see DEPLOYMENT.md → "Hosting the MCP server".
 *
 * Named `.js` rather than `.mjs` on purpose: some Passenger builds only
 * recognise a `.js` startup file. The shipped `package.json` carries
 * `"type": "module"`, which is what makes this ESM.
 *
 * `selfBuild: false` is the whole difference from `websynth-mcp-http.mjs`
 * (REQ-3): production has no `node_modules`, and a public server that shells
 * out to a bundler on request would be a far worse thing than one that refuses
 * to start. A missing `dist/song-core.mjs` is a deploy that forgot the bundle,
 * and it should say so loudly at boot rather than at the first tool call.
 */
import process from 'node:process';
import { startServer } from './http.mjs';

startServer({ selfBuild: false }).catch((e) => {
  process.stderr.write(`[websynth-mcp] fatal: ${e?.stack ?? String(e)}\n`);
  process.exit(1);
});
