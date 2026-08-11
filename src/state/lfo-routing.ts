/**
 * The two-LFO vocabulary — lfo.md REQ-10.
 *
 * This module used to hold `blockedDests`, the REQ-12 rule that stopped the two LFOs
 * sharing a destination. **That rule is gone (v8).** It only ever existed because each
 * LFO had exactly one destination slot, so sharing one meant losing a route; once the
 * [mod matrix](../../specs/features/mod-matrix.md) gives every route its own depth, the
 * cost disappears and blocking the combination merely withheld something the engine
 * always handled correctly (REQ-13: duplicates sum, bounded).
 *
 * What greys a destination now is `mod-routing.ts`'s per-voice/bus-wide rule, which is
 * about something genuinely ill-defined rather than about a scarce slot.
 */

export const LFO_PREFIXES = ['lfo', 'lfo2'] as const;

export type LfoPrefix = (typeof LFO_PREFIXES)[number];

export function otherLfo(p: LfoPrefix): LfoPrefix {
  return p === 'lfo' ? 'lfo2' : 'lfo';
}
