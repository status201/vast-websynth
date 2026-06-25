# ADR-000 — Spec-Driven Development as the working method

```yaml
id: adr-000-spec-driven-development
status: accepted
date: 2026-05-15
deciders: core
related:
  - ../README
  - ../architecture
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's `draft | active |
> implemented`.

## Context / Forces

This codebase is built largely by AI agents acting on a current, authoritative
description of intent. If that description lives only in code, an agent re-derives
intent from a stale snapshot and the architecture drifts. The load-bearing
constraints (UI/audio separation, no-op defaults, the param registry) are easy to
break by accident because the *why* is invisible at the call site. We needed the
architectural intent to live somewhere durable, machine-readable, and **kept in
sync with the code by force**, not goodwill.

## Decision

We adopt **Spec-Driven Development**: `specs/` is the architectural source of
truth, and a change that edits production code (`src/**`, `public/worklets/**`)
must create/update a spec in the *same* change. This is enforced by
`scripts/sdd-guard.mjs` — wired as Claude Code hooks (PreToolUse blocks an
unspecced `Edit`/`Write`; Stop blocks finishing such a turn) and as a CI job that
catches non-Claude agents and direct commits. The `/feature`, `/fix`, and `/spec`
flows drive the procedure; this very ADR layer adds the *Why* tier on top of the
*What* (features) and *How* (recipes).

## Alternatives considered

- **Docs-after-code (write specs when convenient)** — rejected: documentation
  that isn't on the critical path rots; the gap between code and intent reopens
  immediately.
- **An unenforced convention ("please write specs")** — rejected: under any
  deadline it is silently skipped, which is indistinguishable from not having it.
- **Generating docs from code** — rejected: code captures *what* the system does,
  never *why* a rejected alternative was rejected; that intent can't be recovered
  by extraction.

## Consequences

- **Good:** every production change ships with a current spec; agents act from
  intent, not archaeology; the enforcement is cross-tool (hooks for Claude, CI for
  everything).
- **Trade-off:** a spec edit is required alongside every non-trivial production
  change. Genuinely trivial tweaks use an explicit escape hatch — `touch
  .sdd-skip` locally, or `[skip-sdd]` in a commit / the `skip-sdd` PR label in CI.
- **Trade-off:** the guard checks that a spec *changed*, not that it is *good* —
  spec quality still rests on human review.
