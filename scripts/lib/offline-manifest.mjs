/**
 * The build's own file list — `dist/offline-manifest.json` — which the About
 * card's **Play offline** downloads and the service worker refreshes on a new
 * release (specs/features/play-offline.md REQ-2, REQ-7).
 *
 * The app is not one bundle: demo songs are separate files fetched on click and
 * half the dialogs are split chunks, so "everything the app can request" is only
 * knowable after the build has written it. Hand-maintaining that list is how a
 * new chunk would ship missing offline; walking the output directory is not.
 *
 * Exclusions, not inclusions: a file is listed unless a rule below names it, so a
 * newly added public file is covered the day it ships. Build-time only — no
 * runtime dependency (ADR-003); the page and the worker read the JSON it writes.
 */
import { statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listFiles } from './zip.mjs';

export const OFFLINE_MANIFEST_FILE = 'offline-manifest.json';

/** Files in the output that the app never requests, each with the reason. */
const EXCLUSIONS = [
  [/\.map$/, 'sourcemaps — debugging only, and larger than the code they map'],
  [/(^|\/)\./, 'dotfiles — build tooling, never served on purpose'],
  [/^_headers$/, 'host config (Netlify / Cloudflare Pages), not a page asset'],
  [/^robots\.txt$/, 'crawlers only'],
  [/^sitemap\.xml$/, 'crawlers only'],
  [/^og-card\./, 'the social preview image, fetched by link unfurlers'],
  [/^vast-websynth[^/]*\.png$/, 'install-sheet screenshots and README art'],
  [/^sw\.js$/, 'the browser stores the worker script itself'],
  [/^offline-manifest\.json$/, 'the list itself'],
];

/** Normalise to a POSIX path relative to the output directory. */
const toPosix = (path) => path.split('\\').join('/').replace(/^\.\//, '').replace(/^\//, '');

/** True when `path` (relative to the output dir) is never requested by the app. */
export function isOfflineExcluded(path) {
  const p = toPosix(path);
  return EXCLUSIONS.some(([re]) => re.test(p));
}

/**
 * `[{ path, bytes }]` → `{ version, files: [{ url, bytes }], totalBytes }`.
 * `index.html` is listed as `/`, the URL the worker's navigation fallback reads.
 */
export function buildOfflineManifest(entries, version) {
  const files = entries
    .map((e) => ({ path: toPosix(e.path), bytes: e.bytes }))
    .filter((e) => !isOfflineExcluded(e.path))
    .map((e) => ({ url: e.path === 'index.html' ? '/' : `/${e.path}`, bytes: e.bytes }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  return { version, files, totalBytes };
}

/** Vite plugin: write the manifest once the whole output (public/ included) exists. */
export function offlineManifestPlugin(version) {
  let outDir = 'dist';
  return {
    name: 'websynth-offline-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const entries = listFiles(outDir).map((path) => ({
        path,
        bytes: statSync(`${outDir}/${path}`).size,
      }));
      const manifest = buildOfflineManifest(entries, version);
      writeFileSync(`${outDir}/${OFFLINE_MANIFEST_FILE}`, JSON.stringify(manifest));
    },
  };
}
