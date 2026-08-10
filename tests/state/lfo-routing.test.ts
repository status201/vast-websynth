import { describe, it, expect } from 'vitest';
import { blockedDests, LFO_PREFIXES, otherLfo } from '../../src/state/lfo-routing';
import { LFO_DEST_LABELS } from '../../src/state/params';

/**
 * Which destinations each LFO may offer (lfo.md REQ-12).
 *
 * The rule is a UI affordance, not a data invariant: `preset-validate` and
 * `song-validate` still accept both `dest` params anywhere in range,
 * independently. So the interesting cases here are the two exemptions that keep
 * a duplicated file rendering truthfully.
 */

const OFF = LFO_DEST_LABELS.indexOf('off');
const CUTOFF = LFO_DEST_LABELS.indexOf('cutoff');
const PITCH = LFO_DEST_LABELS.indexOf('pitch');

describe('LFO destination exclusivity', () => {
  it('blocks the destination the other LFO holds', () => {
    expect(blockedDests(OFF, CUTOFF)).toEqual([CUTOFF]);
  });

  it('never blocks off — both LFOs may sit there', () => {
    expect(blockedDests(CUTOFF, OFF)).toEqual([]);
    expect(blockedDests(OFF, OFF)).toEqual([]);
  });

  it('never blocks an LFO own current destination (edge)', () => {
    // Only a hand-authored file can produce this, and the panel must still show
    // "cutoff" as the selection rather than a disabled row.
    expect(blockedDests(CUTOFF, CUTOFF)).toEqual([]);
  });

  it('blocks nothing else — one destination, one block', () => {
    expect(blockedDests(PITCH, CUTOFF)).toEqual([CUTOFF]);
    expect(blockedDests(PITCH, CUTOFF)).not.toContain(PITCH);
  });

  it('rounds a fractional index rather than missing the match (edge)', () => {
    // Motion/XY lanes store normalized values, so a dest can arrive off-integer.
    expect(blockedDests(OFF, CUTOFF + 0.4)).toEqual([CUTOFF]);
    expect(blockedDests(CUTOFF + 0.4, CUTOFF)).toEqual([]);
  });

  it('pairs the two prefixes symmetrically', () => {
    expect(LFO_PREFIXES).toEqual(['lfo', 'lfo2']);
    expect(otherLfo('lfo')).toBe('lfo2');
    expect(otherLfo('lfo2')).toBe('lfo');
    for (const p of LFO_PREFIXES) expect(otherLfo(otherLfo(p))).toBe(p);
  });
});
