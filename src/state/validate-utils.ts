/**
 * The shared machinery behind every payload validator: the canonical song
 * validator, the authoring dialect's expander, the preset validator and the
 * paste sniffer. See `specs/features/untrusted-input.md` REQ-3 — the limits
 * themselves live in `limits.ts`; this is the plumbing that reports on them.
 *
 * These had a copy each before. `isObject` especially is a security predicate —
 * REQ-5's reserved-key refusal and every shape check stand on it — and four
 * copies is four chances to drift apart without anyone noticing.
 *
 * Note what is deliberately NOT here: `checkUnit`/`checkRatchet` share a name
 * across `song-validate.ts` and `song-author.ts` but not a signature, because
 * the canonical validator refuses what the dialect coerces. That divergence is
 * the whole point of having two parsers (ADR-013), so it stays per-file.
 */

/** How many errors a validator collects before it stops walking the payload. */
export const MAX_ERRORS = 50;

/** Sink a validator pushes a path-prefixed message into. */
export type AddError = (msg: string) => void;

/**
 * A plain object — not null, not an array. Arrays are excluded deliberately:
 * every caller uses this to decide whether to read *named* fields, and an array
 * would answer `typeof 'object'` while carrying none of them.
 */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A value rendered for an error message. Strings are quoted so an empty or
 * space-padded one is visible; everything else falls back to its type name
 * ('object', 'undefined', 'function', …) rather than dumping a payload we do
 * not trust into a string.
 */
export function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  const t = typeof v;
  if (t === 'string') return `"${v as string}"`;
  if (t === 'number' || t === 'boolean') return String(v);
  return t;
}
