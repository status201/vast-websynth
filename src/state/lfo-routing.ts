/**
 * Which LFO destinations each LFO may select — lfo.md REQ-12.
 *
 * Pure and DOM-free on purpose. The rule is domain logic (two modulators, one
 * destination each) even though only the UI enforces it: `preset-validate` and
 * `song-validate` keep accepting both `dest` params anywhere in range,
 * independently, so a hand-authored or MCP-authored file that duplicates a
 * destination still loads. REQ-13 says what that sounds like; this module only
 * says what the panel offers.
 */

/** Index 0 of `LFO_DEST_LABELS`. Both LFOs may hold it at once. */
const OFF = 0;

export const LFO_PREFIXES = ['lfo', 'lfo2'] as const;

export type LfoPrefix = (typeof LFO_PREFIXES)[number];

export function otherLfo(p: LfoPrefix): LfoPrefix {
  return p === 'lfo' ? 'lfo2' : 'lfo';
}

/**
 * Destination indices this LFO must not offer, given its own current index and
 * the other LFO's.
 *
 * Two things are never blocked, and both matter:
 *   - `off`, because "no destination" is not a resource anyone can take; and
 *   - the LFO's **own** current value, so a file that put both LFOs on one
 *     destination still renders truthfully instead of showing a disabled row as
 *     the selection.
 */
export function blockedDests(mine: number, theirs: number): number[] {
  const t = Math.round(theirs);
  if (t === OFF || t === Math.round(mine)) return [];
  return [t];
}
