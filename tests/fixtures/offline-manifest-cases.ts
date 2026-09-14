/**
 * One table of offline-manifest validation cases (play-offline.md REQ-9), run
 * against both readers of the file: the page's `parseOfflineManifest`
 * (tests/utils/offline-copy.test.ts) and the worker's `parseManifest`
 * (tests/pwa/sw.test.ts). `sw.js` sits outside the bundle and cannot import the
 * page's parser, so the two are separate code — sharing the cases is what keeps
 * them from drifting apart.
 */

export const CASE_VERSION = '9.9.9';

const list = (url: unknown, bytes: unknown = 1) => ({ version: CASE_VERSION, files: [{ url, bytes }] });

/** Accepted when read as `CASE_VERSION`. */
export const VALID_MANIFESTS: [label: string, raw: unknown][] = [
  ['a root-relative asset', list('/assets/index-abc.js', 453385)],
  ['the page itself', list('/', 7834)],
  ['a zero-byte file', list('/robots.txt', 0)],
  ['an empty list', { version: CASE_VERSION, files: [] }],
];

/** Rejected when read as `CASE_VERSION`. */
export const INVALID_MANIFESTS: [label: string, raw: unknown][] = [
  ['null', null],
  ['a string', 'offline'],
  ['another version', { version: '1.0.0', files: [{ url: '/a.js', bytes: 1 }] }],
  ['no file list', { version: CASE_VERSION }],
  ['a protocol-relative url', list('//evil.example/a.js')],
  ['a backslash that resolves off-origin', list('/\\evil.example/a.js')],
  ['an absolute url', list('https://evil.example/a.js')],
  ['a relative url', list('assets/a.js')],
  ['a non-string url', list(42)],
  ['a negative size', list('/a.js', -1)],
  ['a non-finite size', list('/a.js', Number.NaN)],
  ['a size as a string', list('/a.js', '12')],
  ['a null entry', { version: CASE_VERSION, files: [null] }],
];
