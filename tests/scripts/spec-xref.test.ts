import { describe, it, expect } from 'vitest';
import { citationsIn, staleNamesIn, hasReq, EXTERNAL_NAMES } from '../../scripts/lib/spec-xref.mjs';

/**
 * The cross-reference half of `spec-lint` (specs/README.md → "Enforcement &
 * exemptions"). The lint passing on the real tree only shows the tree is clean;
 * these show each check actually FAILS on the drift it exists for — including the
 * exact defects a 2026-09 review found by hand.
 */

const reqs = new Map<string, Set<string>>([
  ['arrangement', new Set(['1', '2', '8', '12'])],
  ['motion-sequencer', new Set(['22', '23'])],
  ['transport-position', new Set(['6', '8'])],
]);
const knownMd = new Set(['arrangement.md', 'motion-sequencer.md', 'transport-position.md', 'README.md']);
const cite = (text: string, inSpec = false): string[] => citationsIn(text, reqs, knownMd, inSpec);

describe('citationsIn', () => {
  it('flags a `.md` citation of a REQ the spec does not declare — the 2026-09 transpose bug', () => {
    expect(cite('# seqTranspose   (arrangement.md REQ-16)')).toEqual([
      'line 1: `arrangement.md REQ-16` — arrangement.md declares no REQ-16',
    ]);
    expect(cite('see arrangement.md REQ-8')).toEqual([]);
  });

  it('checks the bare `spec-id REQ-n` form code comments use', () => {
    expect(cite('// |semitones| on a chain slot (arrangement REQ-16)')).toHaveLength(1);
    expect(cite('// the seek contract (transport-position REQ-6)')).toEqual([]);
  });

  it('never reads an ordinary word before REQ-n as a spec', () => {
    expect(cite('the REQ-99 above; this spec REQ-99; see ADR-015 REQ-99')).toEqual([]);
  });

  it('checks every REQ in a run, not just the first', () => {
    expect(cite('transport-position.md REQ-6/REQ-7, REQ-8')).toEqual([
      'line 1: `transport-position.md REQ-7` — transport-position.md declares no REQ-7',
    ]);
  });

  it('accepts a lettered part of a declared REQ, and nothing else', () => {
    expect(cite('(motion-sequencer REQ-23a)')).toEqual([]);
    expect(cite('(motion-sequencer REQ-24a)')).toHaveLength(1);
  });

  it('flags a citation of a spec that does not exist, but not of a real non-spec file', () => {
    expect(cite('renamed-spec.md REQ-3')).toEqual(['line 1: cites `renamed-spec.md`, which is no spec']);
    expect(cite('README.md REQ-3')).toEqual([]);
  });

  it('leaves ADRs alone — they declare no REQs', () => {
    expect(cite('adr-015-untrusted-input-is-bounded.md REQ-4')).toEqual([]);
  });

  it('inside a spec, skips the link form the per-spec pass already checks', () => {
    const link = 'the ruler ([arrangement](arrangement.md) REQ-99)';
    expect(cite(link, true)).toEqual([]);
    expect(cite(link, false)).toHaveLength(1);
    expect(cite('([arrangement](../features/arrangement.md) REQ-99)', true)).toEqual([]);
  });

  it('reports CRLF text on the right line', () => {
    expect(cite('fine\r\nalso fine\r\narrangement.md REQ-3')).toEqual([
      'line 3: `arrangement.md REQ-3` — arrangement.md declares no REQ-3',
    ]);
  });

  it('hasReq: the lettered-part rule on its own', () => {
    const s = new Set(['5', '5b']);
    expect(hasReq(s, '5')).toBe(true);
    expect(hasReq(s, '5a')).toBe(true);   // part (a) of REQ-5
    expect(hasReq(s, '6a')).toBe(false);
  });
});

const ids = new Set(['Clock', 'seek', 'setStepRouter', 'demoMetaOf', 'clearDatasetMirror', 'LFO', 'bind']);
const stale = (text: string): string[] => staleNamesIn(text, ids);

describe('staleNamesIn', () => {
  it('flags a renamed function, in each shape the review found', () => {
    expect(stale('`demoMeta` derives them')).toEqual([
      'line 1: `demoMeta` names `demoMeta`, which the code does not have',
    ]);
    expect(stale('`clearPeakDataset()` runs on reset')).toHaveLength(1);
    expect(stale('`demoMetaOf` derives them; `clearDatasetMirror()` runs')).toEqual([]);
  });

  it('flags `Class.member` when either half is gone — `Lfo.bind` against `LFO`', () => {
    expect(stale('`Lfo.bind` routes through it')).toEqual([
      'line 1: `Lfo.bind` names `Lfo`, which the code does not have',
    ]);
    expect(stale('`Clock.setStepRouter(fn)` and `Clock.pause()`')).toEqual([
      'line 1: `Clock.pause()` names `pause`, which the code does not have',
    ]);
    expect(stale('`LFO.bind` and `Clock.seek`')).toEqual([]);
  });

  it('ignores backticks that are not code-shaped', () => {
    expect(stale('`AudioParam` · `transport.bpm` · `.on` · `seq-panel` · `REQ-4` · `start`')).toEqual([]);
  });

  it('lets a line about the past name what is gone', () => {
    expect(stale('v6\'s `toggleManual` downloaded unconditionally')).toEqual([]);
    expect(stale('`addTransport` replaces `attachTransport`')).toEqual([]);
    expect(stale('`attachTransport` is still the entry point')).toHaveLength(1);
  });

  it('lets Open questions name what does not exist yet — and only there', () => {
    const doc = [
      '## Open questions / future',
      '- extract a `segmentedGroup()` primitive',
      '## Technical design',
      '- `segmentedGroup()` builds the bar',
    ].join('\n');
    expect(stale(doc)).toEqual([
      'line 4: `segmentedGroup()` names `segmentedGroup`, which the code does not have',
    ]);
  });

  it("accepts a name the document defines as a key in its own fenced block", () => {
    const doc = ['```yaml', 'linkIdleMs: 3000   # the link is dead', '```', 'within `linkIdleMs` of a message'].join('\n');
    expect(stale(doc)).toEqual([]);
  });

  it('accepts the short, reasoned list of platform names the code deliberately avoids', () => {
    expect(EXTERNAL_NAMES.has('shadowColor')).toBe(true);
    expect(stale('draws with no `shadowBlur`/`shadowColor`; `setPositionState` is unset')).toEqual([]);
  });
});
