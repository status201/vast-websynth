// The display build id: `<version>+<commits since v<version>>.<short hash>[.dirty]`
// (specs/features/build-id.md). Node built-ins only; never throws.
import { execFileSync } from 'node:child_process';

/**
 * Turn `git describe --tags --long --dirty` output into the build id. The plain
 * version when the build sits clean on the release tag or the output does not parse
 * (build-id.md REQ-a-release-build-reads-the-plain-version, REQ-build-id-never-fails-the-build);
 * `.dirty` when the working tree had uncommitted changes
 * (REQ-a-modified-tree-says-so).
 * @param {string} version
 * @param {string} describe
 * @returns {string}
 */
export function formatBuildId(version, describe) {
  const m = /-(\d+)-g([0-9a-f]{7,})(-dirty)?$/.exec(describe.trim());
  if (!m) return version;
  const [, n, hash, dirty] = m;
  if (n === '0' && !dirty) return version;
  return `${version}+${n}.${hash}${dirty ? '.dirty' : ''}`;
}

/**
 * Ask git how far HEAD is past the tag `v<version>` — that tag exactly, never the
 * nearest one, so a release built before it is tagged reads the plain version.
 * @param {string} version
 * @param {string} [cwd] the repository to describe (vite.config.ts passes its own folder)
 * @returns {string}
 */
export function buildId(version, cwd = process.cwd()) {
  try {
    const out = execFileSync(
      'git',
      ['describe', '--tags', '--long', '--dirty', '--abbrev=7', '--match', `v${version}`],
      { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    );
    return formatBuildId(version, out);
  } catch {
    return version;
  }
}
