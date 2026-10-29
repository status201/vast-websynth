/**
 * The delay's TYPE as one table (delay-types.md REQ-the-delay-type-is-one-append-only-table):
 * each index's engine key and label. One table so the param's labels and the
 * engine's dispatch cannot drift apart — an index is a stored value in every
 * preset, song and share link, so the list is append-only. Index 0 is DIGITAL:
 * the delay as it always was. What CHAR means per type is the spec's table.
 */
export const DELAY_TYPES = [
  ['digital', 'DIGITAL'],
  ['pingpong', 'PING PONG'],
  ['tape', 'TAPE'],
  ['bbd', 'BBD'],
  ['spaceecho', 'SPACE ECHO'],
  ['reverse', 'REVERSE'],
] as const;

export type DelayType = (typeof DELAY_TYPES)[number][0];

export const DELAY_TYPE_LABELS: string[] = DELAY_TYPES.map((t) => t[1]);

/** What a stored `type` value selects; a non-finite or unknown index is DIGITAL (ADR-015). */
export function delayTypeOf(v: number): DelayType {
  return DELAY_TYPES[Math.round(v)]?.[0] ?? 'digital';
}
