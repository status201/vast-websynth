---
description: Scaffold a new spec from the template (no code)
argument-hint: <feature-id> <one-line purpose>
---
Create a new spec only — no code changes this turn. Input: $ARGUMENTS

1. Copy `specs/features/_feature-template.md` to `specs/features/<feature-id>.md`
   (kebab-case id matching the filename). If it's a repeatable how-to, copy
   `specs/recipes/_recipe-template.md` to `specs/recipes/<recipe-id>.md` instead.
2. Fill the metadata block (`id`, `status: draft`, `version: 1`, `owner`, `related`,
   `source`) and as much of the body as is known: background/why, requirements
   (`REQ-n`), contract, data shapes (flat YAML if nested >3 deep), and BDD
   scenarios. Cross-link related specs and read `specs/architecture.md` first.
3. Add the new spec to `specs/README.md`'s folder map.
4. **Stop for review** — do not implement yet. Hand the spec back for human review.
