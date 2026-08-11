/**
 * The mod matrix's vocabulary and its one routing rule — mod-matrix.md REQ-4/REQ-7.
 *
 * Pure and DOM-free, and deliberately in `state/` rather than `audio/`: the param
 * registry names these labels, the panel greys options with this rule, and the audio
 * layer refuses the same combination. One definition, so the three cannot disagree.
 * (`src/state/lfo-routing.ts` held the superseded REQ-12 rule in exactly this shape.)
 */

/**
 * APPEND-ONLY. A saved route stores the **index**, so inserting or reordering silently
 * re-targets every preset and song that predates the change. Index 0 must stay `off` —
 * it is the no-op default that keeps pre-matrix sounds unchanged (ADR-006).
 */
export const MOD_SOURCE_LABELS = [
  'off', 'lfo 1', 'lfo 2', 'mod wheel', 'random', 'filter env', 'amp env', 'velocity', 'key',
];

/** APPEND-ONLY, same reason. Index 0 must stay `none`. */
export const MOD_DEST_LABELS = [
  'none', 'cutoff', 'resonance', 'pitch', 'shape', 'amp', 'drive', 'pan',
];

/** The six user-assignable rows. LFO 1/2 are rows 0-1 and keep their own params (REQ-2). */
export const MOD_ROWS = 6;

/** Source indices, named so the rules below read as prose. */
export const MOD_SRC = {
  off: 0, lfo1: 1, lfo2: 2, modWheel: 3, random: 4,
  filEnv: 5, ampEnv: 6, velocity: 7, key: 8,
} as const;

/** Destination indices. */
export const MOD_DST = {
  none: 0, cutoff: 1, resonance: 2, pitch: 3, shape: 4, amp: 5, drive: 6, pan: 7,
} as const;

/**
 * Full-scale depth per destination, in that destination's own unit (REQ-8).
 *
 * Lives here, with the vocabulary, because **two** things read it and they must not
 * drift: the audio layer scales a route's gain by it, and the faceplate draws its
 * range arc from it. A second copy would let the arc quietly lie about what is heard.
 *
 * This is also the single place ADR-005's rule is enforced — cutoff modulators emit
 * **semitones**, never Hz — rather than it being restated by every contributor.
 */
export const MOD_DEST_SCALE: Record<number, number> = {
  [MOD_DST.cutoff]: 48,        // semitones
  [MOD_DST.resonance]: 4.2,    // the worklet's own range
  [MOD_DST.pitch]: 2400,       // cents
  [MOD_DST.shape]: 1,
  [MOD_DST.amp]: 0.5,          // around the tremolo VCA's base 1.0
  [MOD_DST.drive]: 4,
  [MOD_DST.pan]: 1,
};

/** Sources that exist once per voice, so their route chain must be per-voice too. */
const PER_VOICE_SOURCES: ReadonlySet<number> = new Set([
  MOD_SRC.filEnv, MOD_SRC.ampEnv, MOD_SRC.velocity, MOD_SRC.key,
]);

/** Destinations that exist once for the whole synth. */
const BUS_WIDE_DESTS: ReadonlySet<number> = new Set([MOD_DST.pan]);

export function isPerVoiceSource(src: number): boolean {
  return PER_VOICE_SOURCES.has(Math.round(src));
}

export function isBusWideDest(dst: number): boolean {
  return BUS_WIDE_DESTS.has(Math.round(dst));
}

/**
 * Destination indices that must be greyed out for `src` (REQ-7).
 *
 * Eight voices' envelopes summing into one `StereoPannerNode` is mush, not modulation —
 * so a per-voice source may not drive a bus-wide destination. Greyed, never removed:
 * the list must not reflow, and the reason has to be readable without hover
 * (ADR-014 law 6).
 */
export function blockedDests(src: number): number[] {
  return isPerVoiceSource(src) ? [...BUS_WIDE_DESTS] : [];
}
