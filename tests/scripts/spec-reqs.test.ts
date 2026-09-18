import { describe, it, expect } from 'vitest';
import { checkSpecReqs, declaredReqs, duplicateSlugs, reqKind } from '../../scripts/lib/spec-reqs.mjs';

/**
 * The REQ-id half of `spec-lint` (specs/README.md → "Enforcement & exemptions",
 * ADR-021). The lint passing on the real tree only shows the tree is clean; these
 * show each rule actually REFUSES the id it exists to refuse — above all the
 * freeze, which is the whole mechanism by which "new ids are slugs" is more than
 * a request.
 *
 * Every fixture here is a deliberately wrong spec, which is why
 * `spec-lint.mjs`'s `NOT_OURS` exempts this file from the citation sweep.
 */

const spec = (...bullets: string[]): string =>
  ['## Requirements', '', ...bullets, '', '## Technical design'].join('\n');
const errs = (text: string, ceiling = 0): string[] => checkSpecReqs(text, ceiling).errors;
const warns = (text: string, ceiling = 0): string[] => checkSpecReqs(text, ceiling).warnings;

describe('reqKind — the two grammars never overlap', () => {
  it('reads a legacy number, with or without its one sub-id letter', () => {
    expect(reqKind('4')).toBe('numeric');
    expect(reqKind('23a')).toBe('numeric');
  });

  it('reads a kebab-case slug', () => {
    expect(reqKind('reset-auto-start')).toBe('slug');
    expect(reqKind('eq')).toBe('slug');
  });

  it('refuses a typo that a looser numeric grammar would wave through', () => {
    // `\d+[a-z]*` would call this a sub-id of REQ-2 and let it ride REQ-2's ceiling.
    expect(reqKind('2fast')).toBeNull();
    expect(reqKind('5ab')).toBeNull();
  });

  it('refuses ids that are not kebab-case, and the degenerate one-character one', () => {
    for (const bad of ['Foo_Bar', 'trailing-', 'Has Space', 'a', 'x'.repeat(61)]) {
      expect(reqKind(bad), bad).toBeNull();
    }
  });
});

describe('the freeze — a NEW id may not be a number', () => {
  it('refuses a number above the spec\'s ceiling, and says what to write instead', () => {
    const out = errs(spec('- **REQ-12** — a', '- **REQ-13** — b'), 12);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('`REQ-13` (line 4) is a NEW numeric id');
    expect(out[0]).toContain('frozen at REQ-12');
    expect(out[0]).toContain('REQ-<kebab-slug>');
  });

  it('accepts the numbers the spec already had, including a lettered part at the ceiling', () => {
    expect(errs(spec('- **REQ-11** — a', '- **REQ-12** — b', '- **REQ-12a** — c'), 12)).toEqual([]);
  });

  it('gives a spec with no ledger entry a ceiling of 0 — so a new spec is slug-only', () => {
    expect(errs(spec('- **REQ-1** — a'))).toHaveLength(1);
    expect(errs(spec('- **REQ-1** — a'))[0]).toContain('this spec has no legacy numbers');
    expect(errs(spec('- **REQ-reset-auto-start** — a'))).toEqual([]);
  });
});

describe('the rules that outlive the numbers', () => {
  it('refuses a malformed id where it is declared, not at every site that cites it', () => {
    const out = errs(spec('- **REQ-Foo_Bar** — a'), 12);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('is not a valid id — use a kebab-case slug');
  });

  it('refuses a duplicate, whichever grammar it is written in', () => {
    expect(errs(spec('- **REQ-slug-one** — a', '- **REQ-slug-one** — b'))).toEqual([
      'duplicate `REQ-slug-one` (line 4; first at line 3)',
    ]);
    expect(errs(spec('- **REQ-3** — a', '- **REQ-3** — b'), 12)).toHaveLength(1);
  });

  it('still makes the legacy numbers ascend', () => {
    expect(errs(spec('- **REQ-7** — a', '- **REQ-2** — b'), 12)).toEqual([
      '`REQ-2` (line 4) is out of order — it follows `REQ-7`',
    ]);
  });

  it('exempts slugs from order and from the gap warning — they are appended, not placed', () => {
    const mixed = spec('- **REQ-1** — a', '- **REQ-2** — b', '- **REQ-zzz-last** — c', '- **REQ-aaa-first** — d');
    expect(errs(mixed, 12)).toEqual([]);
    expect(warns(mixed, 12)).toEqual([]);
  });

  it('warns — never errors — on a gap in the legacy sequence', () => {
    const gapped = spec('- **REQ-1** — a', '- **REQ-3** — b');
    expect(errs(gapped, 12)).toEqual([]);
    expect(warns(gapped, 12)).toEqual(['gap in the REQ sequence: no REQ-2']);
  });
});

describe('duplicateSlugs — a slug names one requirement repo-wide', () => {
  it('reports the second declarer, so the first keeps the slug', () => {
    const byspec = new Map([
      ['alpha', declaredReqs(spec('- **REQ-shared-name** — a'))],
      ['beta', declaredReqs(spec('- **REQ-shared-name** — b'))],
    ]);
    const out = duplicateSlugs(byspec);
    expect(out).toHaveLength(1);
    expect(out[0]!.specId).toBe('beta');
    expect(out[0]!.message).toContain('already declared by alpha.md');
  });

  it('leaves numbers alone — every spec has a REQ-1', () => {
    const byspec = new Map([
      ['alpha', declaredReqs(spec('- **REQ-1** — a'))],
      ['beta', declaredReqs(spec('- **REQ-1** — b'))],
    ]);
    expect(duplicateSlugs(byspec)).toEqual([]);
  });
});

describe('declaredReqs — what counts as a declaration', () => {
  it('takes only a top-level bullet whose bold closes right after the id', () => {
    const text = spec(
      '- **REQ-real-one** — a',
      '- **REQ-two-and-three together** — bold running past the id is prose, not an id',
      '- REQ-unbolded — a bullet that merely starts with a reference',
      '  - **REQ-nested** — a sub-bullet elaborating the one above',
    );
    expect(declaredReqs(text).map((r) => r.tag)).toEqual(['real-one']);
  });

  it('stops at the first design/scenario heading, so a citation below is not a declaration', () => {
    const text = [
      '## Requirements', '', '- **REQ-in-window** — a', '',
      '## Technical design', '', '- **REQ-out-of-window** — a',
    ].join('\n');
    expect(declaredReqs(text).map((r) => r.tag)).toEqual(['in-window']);
  });

  it('spans an intermediate heading — a spec that grew in versioned rounds', () => {
    const text = [
      '## Requirements', '', '- **REQ-first** — a', '',
      '## v3 fix — the lane re-seeks', '', '- **REQ-second** — a', '',
      '## Scenarios (BDD)',
    ].join('\n');
    expect(declaredReqs(text).map((r) => r.tag)).toEqual(['first', 'second']);
  });

  it('reports the right line number in CRLF text', () => {
    expect(declaredReqs(spec('- **REQ-crlf-id** — a').split('\n').join('\r\n'))).toEqual([
      { tag: 'crlf-id', line: 3 },
    ]);
  });
});
