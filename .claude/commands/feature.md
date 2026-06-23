---
description: Build a feature the SDD way (spec → review → implement → test → reconcile)
argument-hint: <short feature description>
---
Implement this feature spec-first. Feature: $ARGUMENTS

Follow the procedure in `specs/README.md` → "Procedure by change type". Do NOT edit
production code (`src/**`, `public/worklets/**`) before the spec exists — the SDD
hook will block it (that's expected).

1. **Spec first** — create or update `specs/features/<name>.md` from
   `specs/_template.md`, `status: draft`. Fill: background/why, requirements
   (`REQ-n`), contract/public interface, data shapes (flat YAML if nested >3 deep),
   and BDD scenarios (Given/When/Then), each naming the test that will pin it.
   Reuse existing patterns — read `specs/architecture.md` and the nearest existing
   feature spec first.
2. **Review** — present the spec for human review (in plan mode, this is the
   plan-approval step). Then set `status: active`.
3. **Implement** the code to satisfy the spec.
4. **Test** — add tests mapping to each Gherkin scenario (`tests/` unit and/or
   `e2e/`). Run `npm run typecheck && npm test`.
5. **Reconcile** — set `status: implemented`; make the spec match what shipped, and
   add the new spec to `specs/README.md`'s folder map.
