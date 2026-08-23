#!/usr/bin/env node
/**
 * Pack the deployable MCP server bundle WITHOUT cutting a release.
 *
 *   npm run pack:mcp            -> mcp-v<package.json version>.zip
 *   npm run pack:mcp -- --out X -> write it to X instead
 *
 * `npm run release` also produces this zip, but only as part of bumping the
 * version and promoting the CHANGELOG. That is the wrong shape for the thing you
 * actually do first: deploy the server, point Claude at it, and find out whether
 * the Plesk config is right — all of which has to happen *before* you would want
 * to commit to a version number.
 *
 * Both paths call `packMcpBundle`, so what you test here is byte-for-byte the
 * layout a release ships; the only difference is the provenance line in the
 * bundle's README.txt, which records the commit and whether the tree was dirty.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { packMcpBundle, currentVersion } from './lib/mcp-bundle.mjs';

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    'Usage: npm run pack:mcp [-- --out <path>]\n\n' +
      '  Builds the song-core bundle and writes mcp-v<version>.zip for deploying\n' +
      '  the MCP server (see DEPLOYMENT.md -> Hosting the MCP server).\n' +
      '  Does not touch package.json, the CHANGELOG, or git.\n',
  );
  process.exit(0);
}

const outIdx = argv.indexOf('--out');
const version = currentVersion();
const outPath =
  outIdx >= 0 && argv[outIdx + 1]
    ? argv[outIdx + 1]
    : fileURLToPath(new URL(`../mcp-v${version}.zip`, import.meta.url));

try {
  const zip = packMcpBundle(version);
  writeFileSync(outPath, zip);
  process.stdout.write(
    `\n  ${outPath}  (${(zip.length / 1024).toFixed(0)} kB)\n\n` +
      '  Unzip it, and put the CONTENTS of websynth-mcp/ in the Plesk\n' +
      '  Application Root. Steps are in the bundle\'s README.txt and in\n' +
      '  DEPLOYMENT.md -> Hosting the MCP server.\n\n',
  );
} catch (e) {
  process.stderr.write(`\n  pack:mcp failed: ${e?.message ?? String(e)}\n\n`);
  process.exit(1);
}
