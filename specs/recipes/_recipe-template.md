<!--
  Copy this file to <name>.md in this folder (recipes/) and fill it in. This is
  the RECIPE template: a repeatable how-to / playbook (the "how"), NOT a feature
  (the "what" — use ../features/_feature-template.md for that). A recipe captures
  a pattern that recurs across the codebase, with a concrete worked instance
  linked from `related`. Keep it lean (see ../README.md "Format rules"): Markdown
  for narrative, reference code by symbol name + file path, not line number.
  Delete any section that genuinely does not apply — don't leave empty headings.
-->

# Recipe — <do the thing>

```yaml
id: <kebab-case-id>          # matches the filename
status: implemented          # draft | active | implemented
version: 1                   # bump when the steps change
owner: <name or team>
related:                     # the worked instance(s) + specs this leans on
  - architecture
  - ../features/<the-canonical-example>
source:                      # the files these steps edit
  - src/...
```

A repeatable **playbook**, not a feature. <One sentence: why this is a fixed
pattern — e.g. "the strict ParamBus ↔ Engine separation means every new scalar
follows the same edits.">  The concrete worked instance is
[`<example>`](../features/<example>.md).

## Background / Why

<!-- The context: what invariant/contract makes this a repeatable pattern, and
     what following it buys you (back-compat, testability, …). 2-4 sentences. -->

## Steps

<!-- The ordered edits. Rename this heading to fit if it reads better
     ("The three edits", "Steps (v2 → v3)"). Each step names the file(s) it
     touches and shows a short, copyable snippet. -->

### 1. <Define it> — `src/...`

```ts
// minimal illustrative snippet
```

### 2. <Wire it> — `src/...`

### 3. <Expose / verify it>

```bash
npm run typecheck   # primary gate
npm test            # add the case that pins it
```

## Gotchas

<!-- The non-obvious traps specific to this pattern. Link the governing ADR/spec
     where a constraint is load-bearing (e.g. no-op defaults, worklet loadModule). -->

- …

## Scenarios (BDD)

```gherkin
Scenario: <following the recipe yields a working, persisted result>
  Given <starting state>
  When <the steps are applied>
  Then <the observable outcome>
# pinned by: tests/...
```

## Tests & verification

<!-- Which suites exercise the pattern, and how to run them. -->

- `tests/...` — <what it pins>.
- `npm run typecheck` / `npm test` (and `npm run e2e` if UI-facing).
