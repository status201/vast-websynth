import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatBuildId, buildId } from '../../scripts/lib/build-id.mjs';

// specs/features/build-id.md
describe('formatBuildId', () => {
  it('names the commits past the release and the commit (REQ-build-id-counts-commits-past-the-release)', () => {
    expect(formatBuildId('2.22.1', 'v2.22.1-7-gc09145c\n')).toBe('2.22.1+7.c09145c');
  });

  it('is the plain version on the release tag (REQ-a-release-build-reads-the-plain-version)', () => {
    expect(formatBuildId('2.22.1', 'v2.22.1-0-gc09145c')).toBe('2.22.1');
  });

  it('marks uncommitted changes, even on the tag (REQ-a-modified-tree-says-so)', () => {
    expect(formatBuildId('2.22.1', 'v2.22.1-7-gc09145c-dirty')).toBe('2.22.1+7.c09145c.dirty');
    expect(formatBuildId('2.22.1', 'v2.22.1-0-gc09145c-dirty')).toBe('2.22.1+0.c09145c.dirty');
  });

  it('keeps a hash git lengthened to stay unique', () => {
    expect(formatBuildId('2.22.1', 'v2.22.1-3-gc09145c1')).toBe('2.22.1+3.c09145c1');
  });

  it('is the plain version for output that does not parse (REQ-build-id-never-fails-the-build)', () => {
    expect(formatBuildId('2.22.1', '')).toBe('2.22.1');
    expect(formatBuildId('2.22.1', 'c09145c')).toBe('2.22.1');
    expect(formatBuildId('2.22.1', 'fatal: No names found')).toBe('2.22.1');
  });
});

describe('buildId', () => {
  it('is a well-formed build id in this repo', () => {
    // Whatever HEAD and the tags are, the shape is fixed (a shallow clone gives the plain version).
    expect(buildId('2.22.1')).toMatch(/^2\.22\.1(\+\d+\.[0-9a-f]{7,}(\.dirty)?)?$/);
  });

  it('is the plain version for a version that has no tag', () => {
    expect(buildId('0.0.0-no-such-release')).toBe('0.0.0-no-such-release');
  });

  it('is the plain version outside a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-id-'));
    try {
      expect(buildId('2.22.1', dir)).toBe('2.22.1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
