<!--
  Copy this file to features/<name>.md or recipes/<name>.md and fill it in.
  Keep it lean (see ../README.md "Format rules"): Markdown for narrative, flat
  YAML for structured schemas, reference code by symbol name not line number.
  Delete any section that genuinely does not apply — don't leave empty headings.
-->

# <Feature name>

```yaml
id: <kebab-case-id>          # matches the filename
status: draft                # draft | active | implemented
version: 1                   # bump when the contract changes
owner: <name or team>
related:                     # other specs this depends on / extends
  - architecture
source:                      # the code that implements this spec
  - src/...
```

## Background / Why

<!-- The context behind the "what". What problem does this solve? What was the
     state before, and what is the intended outcome? Enough for an agent to reason
     ahead about steps it will need. 2-5 sentences. -->

## Requirements

<!-- The design broken into discrete, testable pieces. -->

- **REQ-1** — …
- **REQ-2** — …
- **REQ-3** — …

## Technical design

### Contract / public interface

<!-- The methods/types other layers call. The surface a re-implementation must
     preserve. -->

### Data shapes

<!-- Schemas. Use a flat YAML block when nesting goes beyond ~3 levels. -->

```yaml
# example
ParamDef:
  id: string
  min: number
  max: number
  default: number
```

### Layer touchpoints & ordering

<!-- Which files collaborate, and any construction/ordering constraints
     (e.g. "X is built before Y so Z is settled first"). -->

### Persistence

<!-- localStorage keys, file format, AND what is deliberately NOT persisted.
     Delete if the feature holds no persistent state. -->

### Worklet message contract

<!-- If an AudioWorklet is involved: the port messages in/out, rate, shape.
     Delete if not applicable. -->

## Visual aids

<!-- A diagram if it clarifies, plus tools/libraries with explicit versions if
     the feature pulls any in. -->

## Scenarios (BDD)

```gherkin
Scenario: <happy path>
  Given <state>
  When <action>
  Then <outcome>
# pinned by: tests/..., e2e/...

Scenario: <failure / edge case>
  Given <state>
  When <action>
  Then <outcome>
# pinned by: tests/...
```

## Tests & verification

<!-- Which suites exercise this, and how to run them. -->

- Unit: `tests/...` — `npm test`
- E2E: `e2e/...` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.bus.get('<id>')` (DEV only)

## Open questions / future

- …
