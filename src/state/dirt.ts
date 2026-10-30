/**
 * Dirt's TYPE as one table (dirt-types.md
 * REQ-the-dirt-type-is-one-append-only-table): each index's engine key and
 * label. One table so the param's labels and the engine's voicings cannot drift
 * apart — an index is a stored value in every preset, song and share link, so
 * the list is append-only. Index 0 is DISTORTION: Dirt as it always was.
 */
export const DIRT_TYPES = [
  ['distortion', 'DISTORTION'],
  ['overdrive', 'OVERDRIVE'],
  ['fuzz', 'FUZZ'],
] as const;

export type DirtType = (typeof DIRT_TYPES)[number][0];

export const DIRT_TYPE_LABELS: string[] = DIRT_TYPES.map((t) => t[1]);

/** What a stored `type` value selects; a non-finite or unknown index is DISTORTION (ADR-015). */
export function dirtTypeOf(v: number): DirtType {
  return DIRT_TYPES[Math.round(v)]?.[0] ?? 'distortion';
}
