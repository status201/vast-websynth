# ADR-022 — A machine's bank count is its array length, not a stored field

```yaml
id: adr-022-bank-count-is-the-array-length
status: accepted
date: 2026-09-18
deciders: core
related:
  - ../features/banks
  - ../features/song-mode
  - ../features/arrangement
```

## Context / Forces

Every machine had exactly four pattern banks, and that number was written down in
two places that nothing reconciled — `BANK_COUNT` and a hand-written
`BANK_LABELS` — and hard-coded in five exact-length checks in the song validator,
in both published JSON schemas, in the authoring dialect's `A..D` alphabet and in
the prose of `public/llms.txt`. Four was also tight enough to bend the design
around it: [arrangement](../features/arrangement.md) REQ-a-seq-slot-carries-a-transpose says "four bars was the
entire melodic vocabulary of any song", and
[arrangement-rest](../features/arrangement-rest.md) REQ-rest-is-a-negative-sentinel exists so a lane can sit out a bar
"without spending one of the four banks" — while stating flatly that expanding
the count was out of scope.

Raising it means answering one question first: where does "how many banks does
this machine have" actually live? Songs are shareable documents that travel as
URLs, files and pasted payloads ([untrusted-input](../features/untrusted-input.md),
ADR-015), so whatever answers that question is a compatibility surface, and every
v1–v7 file must keep loading and sounding identical (ADR-007).

## Decision

**A machine's bank count is the length of that machine's bank array — there is no
separate count, in `PatternStore` or in the `SongFile`.** The four machines count
independently between `MIN_BANK_COUNT` (4) and `MAX_BANK_COUNT` (8);
`PatternStore.bankCount(machine)` returns the array length, `addBank`/`removeBank`
resize every parallel array that machine owns as one step, and `BANK_LABELS` is
**derived** from `MAX_BANK_COUNT` so a label can never go missing for a bank that
exists. The validator's five exact-length checks become range checks; nothing else
about the format moves. `Song.apply` is the single place arrays and chains are
reconciled, sizing each machine from
`max(arrayLength, highestChainRef + 1, MIN_BANK_COUNT)` before `restore()`, so a
chain can never outlive the banks it names ([banks](../features/banks.md)
REQ-a-machine-owns-its-bank-count, REQ-a-chain-reference-grows-the-machine).

`SONG_VERSION` still goes to 8. The bump buys nothing structural — it is there so
an older build meets "unsupported song version 8" instead of "seqBanks must have
4 banks", which reads like a corrupt file.

## Alternatives considered

- **A `bankCounts` field in the `SongFile`** — rejected: it is a second copy of a
  number the arrays already carry, so the two can disagree, and then the format
  owes a rule for which wins plus a validator to enforce it. Every drift bug this
  repo has designed out — one band table feeding both the EQ filters and the drawn
  curve, one `tempo-lock` table, one `laneHooks()` per machine — is the same
  lesson. The array length cannot lie about the payload it is the length of.
- **One global count for all four machines** — rejected: the drum machine would
  grow because the sequencer did, and every song would carry banks nobody asked
  for. The machines already have independent bank arrays, independent edit
  cursors and independent chain lanes, so per-machine is the shape that already
  exists; a single count would be the new concept.
- **Raising `BANK_COUNT` to 8 outright** — rejected: every song, share link and
  shipped demo would double in bank data for banks nobody filled (~16 KB of raw
  JSON per song), and the five exact-length validator checks would reject every
  file written before the change — the precise opposite of ADR-007.
- **A freely shrinkable count (delete any bank)** — rejected: removing a bank
  renumbers every bank above it, and chain slots (`ChainLane.steps`), undo
  entries (`PatternMutation`) and the four edit cursors are all bare integers.
  Deleting D from a six-bank machine would silently rewrite every chain naming E
  or F. Only the *highest* bank may be removed, and only while it is empty and
  unreferenced (REQ-a-bank-is-removed-only-when-unused).
- **Auto-growing a machine from a chain at any ingress, not just `Song.apply`** —
  rejected: it would let a malformed chain allocate banks at runtime, and it makes
  the count depend on two fields instead of one, which is what this decision
  exists to prevent. Growth happens once, at load, in the one place that already
  sees both halves.

## Consequences

- **Good:** there is exactly one representation of the count, so it cannot drift;
  a four-bank song serializes byte-for-byte as it did before v6, which keeps every
  shipped demo and `npm run check:demos` untouched; and a song pays bytes only for
  the machines it actually grew.
- **Good:** raising the ceiling again is one line, because `BANK_LABELS`, the
  validator ranges and the authoring guide all derive from `MAX_BANK_COUNT`, and
  `tests/state/authoring-docs.test.ts` pins the literals that cannot derive.
- **Trade-off:** a chain's valid range now depends on a *sibling* top-level array,
  which JSON Schema cannot express. The published schema's chain bound is
  therefore the loose `0..MAX_BANK_COUNT-1`, and `validateSongFile` deliberately
  matches it rather than being stricter, so the two never disagree; the per-machine
  reconciliation happens in `Song.apply` instead.
- **Trade-off:** array lengths are now load-bearing, so `restore()` must resize
  authoritatively rather than fill in place. That turned a latent inherit bug into
  a required fix (REQ-an-omitted-bank-restores-blank) — a cost paid once, and
  arguably a bug found rather than introduced.
- **Trade-off:** eight banks plus the `+`/`−` arms is ~180px wider than four, so
  the machine header row now wraps at widths where it used to fit
  ([responsive-machine-header](../features/responsive-machine-header.md)).
