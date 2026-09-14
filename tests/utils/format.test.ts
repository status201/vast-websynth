import { describe, it, expect } from 'vitest';
import { formatBytes, megabytes, plural } from '../../src/utils/format';

describe('plural', () => {
  it('uses the singular for exactly one', () => {
    expect(plural(1, 'preset')).toBe('1 preset');
    expect(plural(0, 'preset')).toBe('0 presets');
    expect(plural(3, 'automation target')).toBe('3 automation targets');
  });
});

describe('formatBytes', () => {
  it('reads megabytes to one decimal from a megabyte up', () => {
    expect(formatBytes(1_000_000)).toBe('1.0 MB');
    expect(formatBytes(7_138_386)).toBe('7.1 MB');
  });

  it('reads whole kilobytes below, and never rounds a non-empty size to zero', () => {
    expect(formatBytes(999_499)).toBe('999 kB');
    expect(formatBytes(35_200)).toBe('35 kB');
    expect(formatBytes(12)).toBe('1 kB');
    expect(formatBytes(0)).toBe('0 kB');
  });

  it('megabytes drops the unit for "x / y MB" pairs', () => {
    expect(`${megabytes(3_100_000)} / ${megabytes(7_100_000)} MB`).toBe('3.1 / 7.1 MB');
  });
});
