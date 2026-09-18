import { describe, it, expect } from 'vitest';
import { citationsIn, staleNamesIn, hasReq, EXTERNAL_NAMES } from '../../scripts/lib/spec-xref.mjs';

/**
 * The cross-reference half of `spec-lint` (specs/README.md → "Enforcement &
 * exemptions"). The lint passing on the real tree only shows the tree is clean;
 * these show each check actually FAILS on the drift it exists for — including the
 * exact defects a 2026-09 review found by hand.
 */

const reqs = new Map<string, Set<string>>([
  // Both id grammars, because a half-migrated tree is the normal state for as long
  // as the migration runs (ADR-021). These ids are fixtures, not the real spec's —
  // `req-migrate.mjs` skips this file for exactly that reason.
  ['arrangement', new Set(['1', '2', '8', '12', 'slot-transpose', 'rest-clears-lane'])],
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

  it('checks a citation split across a line break', () => {
    // The spec name ends one line and the id opens the next. 130 citations in the
    // tree wrap this way and none of them were checked until this existed — which
    // is also how a rename pass silently repointed 17 of them at the wrong spec.
    expect(cite('buffers to match ([arrangement](arrangement.md)\nREQ-8). Because it', true)).toEqual([]);
    expect(cite('buffers to match ([arrangement](arrangement.md)\nREQ-16). Because it', true)).toEqual([
      'line 2: `arrangement.md REQ-16` — arrangement.md declares no REQ-16',
    ]);
  });

  it('does not carry an anchor once prose has resumed', () => {
    // Only the head of the line continues the citation; a later id is its own.
    expect(cite('see arrangement.md\nthe REQ-16 above is unrelated')).toEqual([]);
    // A previous line that already carries an id is a complete citation, not a head.
    expect(cite('arrangement.md REQ-8 is the rule\nREQ-16 here means something else')).toEqual([]);
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

  it('resolves a slug id in both citation forms', () => {
    expect(cite('# the per-slot transpose (arrangement.md REQ-slot-transpose)')).toEqual([]);
    expect(cite('// a resting bank (arrangement REQ-rest-clears-lane).')).toEqual([]);
    expect(cite('see arrangement.md REQ-slot-transposes')).toEqual([
      'line 1: `arrangement.md REQ-slot-transposes` — arrangement.md declares no REQ-slot-transposes',
    ]);
  });

  it('ends the id at the last word, so trailing punctuation is never part of it', () => {
    // `[a-z0-9]+(?:-[a-z0-9]+)*` cannot end on a hyphen, and an em-dash is outside
    // the class — both would otherwise be swallowed into the slug and never resolve.
    expect(cite('arrangement.md REQ-slot-transpose — the slot carries it')).toEqual([]);
    expect(cite('arrangement REQ-rest-clears-lane, and the bar flags itself')).toEqual([]);
  });

  it('checks a run that mixes a legacy number and a slug', () => {
    expect(cite('arrangement.md REQ-8/REQ-slot-transpose, REQ-nope')).toEqual([
      'line 1: `arrangement.md REQ-nope` — arrangement.md declares no REQ-nope',
    ]);
  });

  it('checks the backticked form the root docs and ADRs use', () => {
    // `` `specs/architecture.md` REQ-1 `` — the closing backtick used to end the
    // match, so 45 of these went unchecked and one had already gone stale.
    expect(cite('write via the bus — see `specs/arrangement.md` REQ-8.')).toEqual([]);
    expect(cite('see `specs/arrangement.md` REQ-16.')).toEqual([
      'line 1: `arrangement.md REQ-16` — arrangement.md declares no REQ-16',
    ]);
  });

  it('flags a citation of a spec that does not exist, but not of a real non-spec file', () => {
    expect(cite('renamed-spec.md REQ-3')).toEqual(['line 1: cites `renamed-spec.md`, which is no spec']);
    expect(cite('README.md REQ-3')).toEqual([]);
  });

  it('checks a bare slug against every spec — what a bare number could never be', () => {
    // No spec is named, so the id has to resolve on its own. This is the payoff
    // ADR-021 argued for: ~3,900 references in the tree are written this way.
    expect(cite('// a resting bank (REQ-rest-clears-lane)')).toEqual([]);
    expect(cite('// a resting bank (REQ-rest-clears-lanes)')).toEqual([
      'line 1: `REQ-rest-clears-lanes` is declared by no spec',
    ]);
  });

  it('never bare-checks a number, and never re-reports an anchored id', () => {
    // A bare number is unresolvable by construction — it is not an error, it is
    // simply outside what this check can see.
    expect(cite('// the release path (REQ-4)')).toEqual([]);
    // And an id a `.md` citation already resolved is reported once, not twice.
    expect(cite('see arrangement.md REQ-slot-transposes')).toEqual([
      'line 1: `arrangement.md REQ-slot-transposes` — arrangement.md declares no REQ-slot-transposes',
    ]);
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

  it('hasReq: never resolves a slug by stripping its last word', () => {
    // Every slug ends in a letter, so the lettered-part rule would answer
    // `REQ-reset-auto-start` by looking for a `REQ-reset-auto-` nobody wrote.
    expect(hasReq(new Set(['reset-auto-start']), 'reset-auto-start')).toBe(true);
    expect(hasReq(new Set(['reset-auto']), 'reset-auto-start')).toBe(false);
    expect(hasReq(new Set(['reset-auto-']), 'reset-auto-start')).toBe(false);
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
