<!--
  Copy this file to adr-NNN-<slug>.md and fill it in. Keep it lean (see
  ../README.md "Format rules"): Markdown narrative, reference code by symbol name
  not line number. An ADR records ONE decision and is immutable once accepted —
  to change a decision, write a new ADR that supersedes this one (don't rewrite
  history). Delete any section that genuinely does not apply.
-->

# ADR-NNN — <decision, stated as a short title>

```yaml
id: adr-NNN-<slug>           # matches the filename
status: accepted             # proposed | accepted | superseded by adr-XXX | deprecated
date: 2026-06-25             # when the decision was taken
deciders: core
related:                     # the specs this decision governs (relative ids)
  - ../architecture
```

> ADR `status` is its own decision lifecycle and is **not** the feature-spec
> `draft | active | implemented`. A decision is `proposed`, then `accepted`; a
> later ADR can mark it `superseded by adr-XXX` or `deprecated`. Records are
> append-only — supersede, don't rewrite.

## Context / Forces

<!-- The situation and the constraints in play when the decision was made: the
     forces pulling in different directions (requirements, prior decisions, the
     platform). Enough that a reader understands why a choice was even needed.
     2-5 sentences. -->

## Decision

<!-- One sentence stating what was chosen, then a short elaboration of how it
     works in this repo (reference symbols/files). -->

## Alternatives considered

<!-- Each option that was rejected, and the SPECIFIC reason it lost. This is the
     load-bearing part — it's what stops a future contributor re-litigating a
     settled choice. -->

- **<Option A>** — rejected because …
- **<Option B>** — rejected because …

## Consequences

<!-- What this buys us (the good), AND the trade-offs/costs we accept by living
     with it (the bad). Be honest about the costs. -->

- **Good:** …
- **Trade-off:** …
