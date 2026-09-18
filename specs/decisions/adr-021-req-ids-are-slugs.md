# ADR-021 — A REQ id is a slug, not a number

```yaml
id: adr-021-req-ids-are-slugs
status: accepted
date: 2026-09-18
deciders: core
related:
  - ../README
  - adr-000-spec-driven-development
```

## Context / Forces

A REQ id was allocated as "the next free number" in its spec — a counter with no
owner. That is fine with one writer and unsound with two: two branches each
appending a requirement to the same spec both reach for the same number. Git
resolves that badly in both directions. A conflict in the requirements list is the
good outcome, because someone has to look at it. The bad outcome is a clean
auto-merge — the two bullets land in different hunks, both survive, and the spec
now has one id covering two unrelated requirements, with every citation of it in
the tree pointing at a coin flip.

Nothing caught that. The lint's duplicate check only fires if both bullets end up
in one file, and it has never had anything to say about the citations, which is
where the damage actually lands: a 2026-09 review found three specs citing the
arrangement spec's REQ 16 for a rule that lives at REQ-8, and that was a single
writer misremembering, not a merge.

The second force is that a number carries no meaning. Roughly 3,900 references —
`(REQ-13/REQ-14)` in a source comment, `Scenario: … (REQ-9)` in a spec — name no
target spec, and a bare number cannot be resolved without one, so the
cross-reference lint has always been blind to them.

## Decision

**A requirement id is a kebab-case slug naming the rule** — `REQ-reset-auto-start`,
`REQ-cutoff-is-a-midi-note` — allocated from what the requirement says rather than
from a counter. Two branches collide only when they are writing the same
requirement, which is a conflict worth having. A slug is unique across all specs,
not merely within one, so a citation of it resolves on its own.

`scripts/lib/spec-reqs.mjs` owns the grammar (`reqKind`), the per-spec rules
(`checkSpecReqs`) and repo-wide uniqueness (`duplicateSlugs`), with
`tests/scripts/spec-reqs.test.ts` showing each one refusing what it exists to
refuse. Because the lint has no git history to consult, "is this id new?" is
answered by `scripts/lib/req-legacy.mjs`: a frozen table of the highest number
each spec held at the freeze, seeded once. A declared number above its spec's
ceiling — or any number in a spec with no entry, so a new spec is slug-only from
its first line — is an error. The table is only ever shrunk, as specs migrate; when
it is empty, numbers are gone for good.

The existing numbers are migrated to slugs spec by spec rather than left in place.
Both grammars are accepted meanwhile, because a half-migrated tree is the normal
state for as long as that takes.

## Alternatives considered

- **Leave it to convention — write it in the template and ask nicely** — rejected
  for the reason ADR-000 already gives about specs themselves: an unenforced
  convention is silently skipped under any deadline, which is indistinguishable
  from not having it.
- **Give each branch a reserved number range** — rejected: it makes the ids
  meaningless *and* fragile, needs a human registry of who holds which range, and
  fails the moment someone forgets to claim one. It also does nothing for the
  unreadability of a number at the citation site.
- **Grandfather the numbers forever and slug only new requirements** — rejected,
  though it is the cheap option and was the first proposal. It leaves the bare-id
  references permanently unlintable, and leaves every spec with two id systems to
  explain to the next reader.
- **Renumber on merge, by hand or by tool** — rejected: an id is cited from code
  comments and tests, so renumbering is a tree-wide rewrite performed under merge
  pressure, which is exactly when it will be done badly.
- **A random or hashed id (`REQ-a3f1`)** — rejected: collision-free, and no better
  than a number to read. The naming is the point, not the uniqueness.

## Consequences

- **Good:** an id collides only when two people write the same requirement, and a
  bad merge can no longer quietly fuse two requirements into one.
- **Good:** a citation says what it refers to. A comment citing
  `REQ-slot-transpose` survives a reader who has not opened the spec; the same
  comment citing `REQ-8` does not.
- **Good:** once the migration is done, a bare reference is resolvable, putting
  ~3,900 references under the cross-reference lint for the first time.
- **Trade-off:** naming is harder than counting. A slug has to be chosen, and a
  bad one is worse than a number because it can be *wrong* rather than merely
  opaque.
- **Trade-off:** a rename is a tree-wide change, so an id is even more permanent
  than it was. `(vN)` markers and the append-only habit stay as they were.
- **Trade-off:** two grammars coexist until the migration finishes, and the freeze
  table is a second place a spec rename has to be reflected.
