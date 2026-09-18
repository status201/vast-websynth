/**
 * The numeric REQ ids that predate slug ids — spec id → the highest number that
 * spec declared at the freeze (ADR-021).
 *
 * A REQ id used to be "the next free number", which is a shared counter with no
 * coordination: two branches appending a requirement to the same spec both pick
 * the same one, and the merge either conflicts or — worse — succeeds, leaving two
 * unrelated requirements under one id and every citation of it pointing at a coin
 * flip. New ids are slugs (`REQ-reset-auto-start`), allocated from the
 * requirement's meaning instead of its position.
 *
 * This table is what lets `spec-lint` tell an OLD number from a NEW one without
 * git: a declared `REQ-<n>` above its spec's ceiling — or any number in a spec
 * with no entry here — is an error.
 *
 * **It is now empty, and that is the finished state.** Every spec was migrated,
 * each losing its entry as it went, and an empty map gives every spec a ceiling
 * of 0 — so a number is refused everywhere rather than nowhere. The file stays
 * because that emptiness is the rule: it is what makes "ids are slugs" absolute
 * instead of a convention, and it is the one place a number could be re-admitted
 * deliberately, as a visible diff, if some future spec ever had to carry one.
 */
export const LEGACY_REQ_CEILING = new Map([
]);

/** The highest numeric REQ `specId` may declare. 0 — the default — means none. */
export function legacyCeiling(specId) {
  return LEGACY_REQ_CEILING.get(specId) ?? 0;
}
