import { describe, it, expect } from 'vitest';
import { cleanName } from '../../src/state/names';
import { MAX_NAME_CHARS } from '../../src/state/limits';

/** untrusted-input.md REQ-names-are-capped — the one name sanitiser. */
describe('cleanName', () => {
  it('leaves an ordinary name alone', () => {
    expect(cleanName('Night Drive Lead')).toBe('Night Drive Lead');
  });

  it('caps at MAX_NAME_CHARS (50)', () => {
    expect(MAX_NAME_CHARS).toBe(50);
    expect(cleanName('x'.repeat(80))).toBe('x'.repeat(50));
    expect(cleanName('x'.repeat(50))).toBe('x'.repeat(50));
  });

  it('strips control characters and trims', () => {
    expect(cleanName('  Lead\u0000\u0007 Bass\n\t ')).toBe('Lead Bass');
    expect(cleanName('\u0085Pad\u009f')).toBe('Pad');
  });

  it('trims again after the cut, so no trailing blank survives', () => {
    expect(cleanName(`${'a'.repeat(49)} tail`)).toBe('a'.repeat(49));
  });

  it('counts code points, so an emoji at the boundary is never cut in half', () => {
    const name = `${'a'.repeat(49)}🎹🎹`;
    const out = cleanName(name);
    expect([...out]).toHaveLength(50);
    expect(out.endsWith('🎹')).toBe(true);
    // No lone surrogate left behind.
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('takes a custom cap', () => {
    expect(cleanName('abcdef', 3)).toBe('abc');
  });

  it('an all-blank name comes back empty, for the caller to default', () => {
    expect(cleanName(' \u0000 ')).toBe('');
  });
});
