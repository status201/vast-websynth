---
description: Fix a bug the SDD way (govern by spec + add a regression scenario)
argument-hint: <bug description>
---
Fix this bug spec-driven. Bug: $ARGUMENTS

Follow `specs/README.md` → "Procedure by change type". The SDD hook blocks edits to
production code (`src/**`, `public/worklets/**`) without a spec change, so resolve
the spec side first.

1. **Locate the governing spec** under `specs/features/`. Decide which case applies:
   - *Spec is wrong or missing* → correct/add the spec (the behaviour was never or
     wrongly specified).
   - *Code merely diverged from a correct spec* → add a **regression scenario**
     (Given/When/Then) to that spec capturing the bug.
2. **Implement the fix**, plus a test that maps to the new/updated scenario.
3. Run `npm run typecheck && npm test`. Keep the spec's other scenarios green.

If the fix is genuinely trivial (typo/comment) and touches production code, you may
`touch .sdd-skip` to bypass — but a real bug fix should almost always pin a
regression scenario instead.
