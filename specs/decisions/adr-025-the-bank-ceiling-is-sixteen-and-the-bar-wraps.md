# ADR-025 — The bank ceiling is sixteen, and the bank bar wraps rather than pages

```yaml
id: adr-025-the-bank-ceiling-is-sixteen-and-the-bar-wraps
status: accepted
date: 2026-10-02
deciders: core
related:
  - ../features/banks
  - ../features/song-mode
  - ../features/song-authoring-dialect
  - ../features/responsive-machine-header
```

## Context / Forces

[ADR-022](adr-022-bank-count-is-the-array-length.md) made a machine's bank count
the length of its bank array, between `MIN_BANK_COUNT` (4) and `MAX_BANK_COUNT`
(8), and predicted that raising the ceiling again would be one line. Eight banks
(A–H) turned out to be a real limit for longer arrangements. Raising it meant
deciding three things ADR-022 did not cover: what an older build should say when
it meets a song with more banks than it knows, how the authoring dialect labels
the new banks, and where sixteen banks go on a phone-width bank bar.

ADR-022 is accepted, and ADRs are append-only, so the new ceiling is recorded
here rather than written into ADR-022.

## Decision

**`MAX_BANK_COUNT` is 16 (A–P), and `SONG_VERSION` goes to 9.** The bump adds no
field. It is there for the same reason ADR-022's v8 bump was: an older build
should report "unsupported song version 9", not "must have 4..8 banks", which
reads like a corrupt file ([song-mode](../features/song-mode.md)
REQ-song-file-v9-raises-the-bank-ceiling). The authoring dialect's chain
alphabet runs A..P, and its version ladder gains a v9 rung, so an AI-written
song is stamped v9 only when it needs more than eight banks
([song-authoring-dialect](../features/song-authoring-dialect.md)).

**The bank bar wraps instead of paging.** At sixteen banks plus the `+`/`−`
arms the segment is wider than a phone. It wraps onto a second line
([responsive-machine-header](../features/responsive-machine-header.md)
REQ-the-bank-segment-wraps-internally), so a bank that holds data is always one
tap away ([banks](../features/banks.md) REQ-the-bank-bar-wraps-rather-than-pages).

## Alternatives considered

- **Page the bank bar (A–H, then I–P behind an arrow)**: rejected. A bank on the
  hidden page is invisible, so a chain naming it points at something the user
  cannot see, and every edit to it costs an extra tap
  ([ADR-014](adr-014-dont-make-me-think.md) law 1).
- **Raise the ceiling without a version bump**: rejected. A v8 build would reject
  a 12-bank song with a range error that reads like corruption. The bump costs
  one integer and turns that into an honest "newer song" message.
- **A larger ceiling**: rejected for now. Sixteen already wraps to two lines on
  a phone, and nothing has asked for more. Going past sixteen is a design change
  to the bank bar, not another one-line raise ([banks](../features/banks.md)).

## Consequences

- **Good:** as ADR-022 predicted, the code change was `MAX_BANK_COUNT = 16`.
  Everything that reads it moved with it, and `tests/state/authoring-docs.test.ts`
  named each literal that could not: `maxItems`, the chain `maximum`s and the
  letter regexes in both schemas, and the `llms.txt` prose.
- **Good:** a song that uses eight banks or fewer saves exactly as before, apart
  from the version stamp.
- **Trade-off:** two costs the prediction did not count. The version bump needed
  a new top rung in the dialect's version ladder, and the machine header needed a
  wrapping layout.
