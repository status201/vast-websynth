import { describe, it, expect } from 'vitest';
import {
  checkSpecLean, danglingRelated, REQ_BYTES_WARN, SPEC_BYTES_WARN,
} from '../../scripts/lib/spec-lean.mjs';

/**
 * The leanness half of `spec-lint` (specs/README.md → "Not in a spec"). The lint
 * passing on the real tree only shows the tree is clean; these show each rule
 * REFUSES the shape it exists to refuse, and lets its legitimate neighbour pass.
 *
 * Every fixture is a deliberately wrong spec, which is why `spec-lint.mjs`'s
 * `NOT_OURS` exempts this file from the citation sweep.
 */

const meta = (...lines: string[]): string =>
  ['```yaml', 'id: x', 'status: implemented', ...lines, '```', ''].join('\n');
const reqs = (...bullets: string[]): string =>
  ['## Requirements', '', ...bullets, '', '## Technical design', ''].join('\n');
const errs = (text: string): string[] => checkSpecLean(text).errors;
const warns = (text: string): string[] => checkSpecLean(text).warnings;

describe('the metadata block holds an integer version, not a changelog', () => {
  it('refuses a version comment run', () => {
    expect(errs(meta('version: 3', '# v2: added the thing', '# v3: fixed it'))).toHaveLength(2);
  });

  it('refuses a vN: note on the value', () => {
    expect(errs(meta('version: 3   # v3: fixed the thing'))).toHaveLength(1);
  });

  it('accepts a plain integer, and an ordinary comment', () => {
    expect(errs(meta('version: 3', 'owner: core   # the team'))).toEqual([]);
  });
});

describe('no section is named after a version', () => {
  it('refuses ## / ### / #### vN headings', () => {
    for (const h of ['## v3 fix — reordering', '### v7 — files', '#### v12']) {
      expect(errs(`${meta('version: 1')}\n${h}\n`), h).toHaveLength(1);
    }
  });

  it('accepts a heading that merely contains a v-word, and one inside a code fence', () => {
    expect(errs(`${meta('version: 1')}\n## Files\n\n### vowel handling\n`)).toEqual([]);
    expect(errs(`${meta('version: 1')}\n\`\`\`md\n## v3 fix\n\`\`\`\n`)).toEqual([]);
  });
});

describe('a REQ body carries no version tag past its landing marker', () => {
  it('refuses (vN), (vN, …), (vN; …), **(vN)** and *(vN)* inside a body', () => {
    for (const body of [
      'The rule. (v7) More rule.',
      'The rule (v7, see x).',
      'The rule (v2; was y).',
      '**(v14) Also this.**',
      'alert copy is `dialog-copy` *(v5)*.',
    ]) {
      expect(errs(reqs(`- **REQ-a-rule** — ${body}`)), body).toHaveLength(1);
    }
  });

  it('accepts the landing marker, with or without a dash and a note', () => {
    expect(errs(reqs('- **REQ-a-rule** (v5) — The rule.'))).toEqual([]);
    expect(errs(reqs('- **REQ-a-rule** — (v5) The rule.'))).toEqual([]);
    expect(errs(reqs('- **REQ-a-rule** · **REQ-b-rule** (v5, merged) — The rule.'))).toEqual([]);
  });

  it('leaves scenarios, design and code fences alone', () => {
    const text = [
      reqs('- **REQ-a-rule** (v5) — The rule.'),
      '```gherkin', 'Scenario: it still works (v5, regression)', '```',
      '## Open questions / future', '', '- Revisit (v9).', '',
    ].join('\n');
    expect(errs(text)).toEqual([]);
  });

  it('refuses a tag on a REQ continuation line, not only the first', () => {
    expect(errs(reqs('- **REQ-a-rule** (v5) — The rule,', '  and then (v9) another clause.'))).toHaveLength(1);
  });
});

describe('outlier sizes are warnings, never errors', () => {
  it('flags a REQ body over the budget', () => {
    const long = `- **REQ-a-long-rule** — ${'word '.repeat(REQ_BYTES_WARN / 4)}`;
    expect(warns(reqs(long)).some((w) => w.includes('REQ-a-long-rule'))).toBe(true);
    expect(errs(reqs(long))).toEqual([]);
  });

  it('flags a spec over the budget', () => {
    const text = `${meta('version: 1')}\n${'x'.repeat(SPEC_BYTES_WARN)}\n`;
    expect(warns(text).some((w) => w.includes('bytes'))).toBe(true);
    expect(errs(text)).toEqual([]);
  });

  it('is quiet for a small spec', () => {
    expect(warns(`${meta('version: 1')}\n${reqs('- **REQ-a-rule** — Short.')}`)).toEqual([]);
  });
});

describe('danglingRelated — every related: entry names a spec', () => {
  const ids = new Set(['transport', 'adr-015-untrusted-input-is-bounded', 'README']);

  it('resolves bare ids, relative paths, .md suffixes and trailing comments', () => {
    const block = [
      'id: x', 'related:', '  - transport   # the clock',
      '  - ../decisions/adr-015-untrusted-input-is-bounded', '  - ../README.md', 'source:', '  - src/x.ts',
    ].join('\n');
    expect(danglingRelated(block, ids)).toEqual([]);
  });

  it('names an entry that matches no spec', () => {
    expect(danglingRelated('related:\n  - lane-mixer\n  - transport', ids)).toEqual(['lane-mixer']);
  });

  it('strips a trailing comment on the LAST line of a CRLF block (regression)', () => {
    // A CRLF block's last line keeps a lone \r, which `.` does not match.
    expect(danglingRelated('related:\r\n  - transport    # the loop wrap\r', ids)).toEqual([]);
  });
});
