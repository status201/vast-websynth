/**
 * Lib-mode build of the pure song core for the MCP server (mcp-server.md
 * REQ-3/4): scripts/mcp/song-core-entry.ts → scripts/mcp/dist/song-core.mjs
 * (gitignored). Run via `npm run build:mcp`, or let websynth-mcp.mjs
 * self-build on start. Unminified, Node-target ES module.
 */
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  logLevel: 'silent', // stdout belongs to the MCP protocol during self-build
  publicDir: false,   // don't copy the app's public/ assets into the lib output
  build: {
    lib: {
      entry: fileURLToPath(new URL('./song-core-entry.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'song-core.mjs',
    },
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
  },
});
