/**
 * The two-LFO vocabulary — lfo.md REQ-there-are-two-lfos.
 *
 * This module used to hold `blockedDests`, the REQ-destinations-are-no-longer-exclusive rule that stopped the two LFOs
 * sharing a destination. **That rule is gone (v8).** It only ever existed because each
 * LFO had exactly one destination slot, so sharing one meant losing a route; once the
 * [mod matrix](../../specs/features/mod-matrix.md) gives every route its own depth, the
 * cost disappears and blocking the combination merely withheld something the engine
 * always handled correctly (REQ-duplicated-destinations-sum-and-stay-bounded: duplicates sum, bounded).
 *
 * What greys a destination now is `mod-routing.ts`'s per-voice/bus-wide rule, which is
 * about something genuinely ill-defined rather than about a scarce slot.
 */

export const LFO_PREFIXES = ['lfo', 'lfo2'] as const;

/**
 * Full-scale depth per LFO destination, in that destination's own unit — the LFO's
 * counterpart of `MOD_DEST_SCALE` (lfo.md REQ-duplicated-destinations-sum-and-stay-bounded).
 *
 * Here, beside the vocabulary, for the same reason that table sits beside the matrix's:
 * **two** things read it and they must not drift. `LFO.update` scales each output by it,
 * and `mod-depth.ts` draws a knob's reach from it, so the arc cannot promise a sweep
 * the instrument does not play. Keyed by `LFO_DEST_LABELS` name; `off` and `pulse`
 * are absent — `pulse` has no node to scale (oscillators.md REQ-set-periodic-wave-is-immediate).
 */
export const LFO_DEST_SCALE = {
  pitch: 1200,  // cents — one octave either way
  cutoff: 24,   // semitones — two octaves
  amp: 0.5,     // around the tremolo VCA's base 1.0
  // Hard L↔R. StereoPannerNode.pan clamps to ±1, so this stays bounded whatever
  // the amount (lfo.md REQ-pan-sweeps-a-stereo-panner).
  pan: 1,
  // Of the POLY pole-mix morph, summed onto the knob. A no-op under the LADDER
  // model, which ignores shape (filter-models.md REQ-shape-is-poly-only).
  shape: 0.5,
  // Semitones of slave pitch, summed onto the SYNC knob — the same reach as
  // cutoff (oscillator-sync.md REQ-sync-is-a-modulation-destination).
  sync: 24,
} as const;

export type LfoPrefix = (typeof LFO_PREFIXES)[number];
