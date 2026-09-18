import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOfflineManifest,
  isOfflineExcluded,
  offlineManifestPlugin,
  OFFLINE_MANIFEST_FILE,
} from '../../scripts/lib/offline-manifest.mjs';

/**
 * The build's file list for Play offline (specs/features/play-offline.md REQ-the-build-writes-the-file-list):
 * everything the app can request, minus a named set of files it never does.
 */

const entry = (path: string, bytes = 10) => ({ path, bytes });

describe('buildOfflineManifest (REQ-the-build-writes-the-file-list)', () => {
  const tree = [
    entry('index.html', 7834),
    entry('assets/index-B-idqKpf.js', 453385),
    entry('assets/index-B-idqKpf.js.map', 999999),
    entry('assets/sync-pair-modal-XHy0IzSC.js', 31337),
    entry('assets/Elegy.websynth-BZRyojWm.json', 95763),
    entry('assets/1973.websynth-Cwcumo1H.zip', 833508),
    entry('worklets/recorder.js', 3705),
    entry('schema/websynth-song.schema.json', 12703),
    entry('params.json', 68477),
    entry('llms.txt', 8452),
    entry('site.webmanifest', 1401),
    entry('_headers', 1211),
    entry('robots.txt', 796),
    entry('sitemap.xml', 244),
    entry('og-card.png', 1047703),
    entry('og-card.svg', 71130),
    entry('vast-websynth.png', 162577),
    entry('vast-websynth-song-tab.png', 175960),
    entry('sw.js', 5657),
    entry('offline-manifest.json', 4000),
    entry('.vite/manifest.json', 100),
  ];

  it('lists every chunk, demo, worklet and doc, with index.html as "/"', () => {
    const m = buildOfflineManifest(tree, '9.9.9');
    expect(m.version).toBe('9.9.9');
    expect(m.files.map((f) => f.url)).toEqual([
      '/',
      '/assets/1973.websynth-Cwcumo1H.zip',
      '/assets/Elegy.websynth-BZRyojWm.json',
      '/assets/index-B-idqKpf.js',
      '/assets/sync-pair-modal-XHy0IzSC.js',
      '/llms.txt',
      '/params.json',
      '/schema/websynth-song.schema.json',
      '/site.webmanifest',
      '/worklets/recorder.js',
    ]);
    expect(m.files.find((f) => f.url === '/')!.bytes).toBe(7834);
  });

  it('sums the listed bytes only', () => {
    const m = buildOfflineManifest(tree, '1.0.0');
    expect(m.totalBytes).toBe(m.files.reduce((s, f) => s + f.bytes, 0));
    expect(m.totalBytes).toBe(7834 + 453385 + 31337 + 95763 + 833508 + 3705 + 12703 + 68477 + 8452 + 1401);
  });

  it('never lists sourcemaps, host/crawler files, preview art, the worker or itself', () => {
    for (const path of [
      'assets/x.js.map', '_headers', 'robots.txt', 'sitemap.xml', 'og-card.png', 'og-card.svg',
      'vast-websynth.png', 'vast-websynth-drum-machine.png', 'sw.js', OFFLINE_MANIFEST_FILE, '.vite/manifest.json',
    ]) {
      expect(isOfflineExcluded(path), path).toBe(true);
    }
    // Look-alikes elsewhere in the tree are still app files.
    for (const path of ['assets/sw.js-abc.js', 'assets/og-card-helper.js', 'worklets/recorder.js']) {
      expect(isOfflineExcluded(path), path).toBe(false);
    }
  });

  it('normalises Windows separators', () => {
    const m = buildOfflineManifest([entry('assets\\index-abc.js'), entry('assets\\index-abc.js.map')], '1.0.0');
    expect(m.files).toEqual([{ url: '/assets/index-abc.js', bytes: 10 }]);
  });
});

describe('offlineManifestPlugin (REQ-the-build-writes-the-file-list)', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('writes the manifest for the whole output directory after the build', () => {
    dir = mkdtempSync(join(tmpdir(), 'offline-manifest-'));
    const out = join(dir, 'dist');
    mkdirSync(join(out, 'assets'), { recursive: true });
    writeFileSync(join(out, 'index.html'), '<html></html>');
    writeFileSync(join(out, 'assets', 'index-abc.js'), 'console.log(1)');
    writeFileSync(join(out, 'assets', 'index-abc.js.map'), '{}');

    const plugin = offlineManifestPlugin('2.0.0');
    expect(plugin.apply).toBe('build');
    plugin.configResolved({ root: dir, build: { outDir: 'dist' } });
    plugin.closeBundle();

    const written = JSON.parse(readFileSync(join(out, OFFLINE_MANIFEST_FILE), 'utf-8'));
    expect(written).toEqual({
      version: '2.0.0',
      files: [
        { url: '/', bytes: 13 },
        { url: '/assets/index-abc.js', bytes: 14 },
      ],
      totalBytes: 27,
    });
  });
});
