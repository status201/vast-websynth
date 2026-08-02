# Brand block (VAST G1-J5 identity)

```yaml
id: brand
status: implemented
version: 1
owner: ui
related:
  - architecture
  - typography          # the display serif's flagship consumer
  - responsive-header   # the header consumer
  - factory-reset       # pins the About modal's card order
  - onboarding          # the About modal's other contents
source:
  - src/ui/components/brand.ts
  - src/ui/styles/brand.module.css
```

The product's on-screen identity — `VAST` + a boxed `G1-J5` + the tagline —
rendered from one place wherever it appears.

## Background / Why

The name appeared on three surfaces in two different shapes. The header drew the
real thing: `VAST` in the display serif, `G1-J5` boxed in monospace beside it,
and `Vast Audio Synthesis Technology` underneath — a faceplate, which is the
whole point of an instrument that is trying not to look like a web app. The
About modal and the "Tap to start" modal each hand-rolled a flattened
lookalike (`VAST G1-J5` as one serif line plus an italic tagline) using the
generic `Modal.titleClass` / `Modal.tagClass`.

Two renderings of one identity drift: a change to the model badge or the
tagline had to be made three times, and the modals' version was already a
different font, size, weight and colour from the header's. This is a facility,
not a feature — it owns markup and styling only, and has no state.

## Requirements

- **REQ-1** — `createBrand()` returns the block: a `.brand` column containing a
  `.brandRow` (`.brandName` `VAST` + `.brandModel` `G1-J5`) and a
  `.brandTagline` (`Vast Audio Synthesis Technology`). Every consumer renders
  **identical** markup and typography; there is no size or content variant.
- **REQ-2** — Consumers: the header (`ui/app.ts` `buildHeader`), the About modal
  (`ui/components/about.ts`), and the start modal (`main.ts` `showStartModal`).
  A new surface that shows the name calls this rather than restating it.
- **REQ-3** — **The block carries no outer framing.** `.brand` styles only its
  own contents (column flow, gap, line-height). The header's divider rule —
  `padding-right` / `border-right` / `margin-right` — lives in a header-only
  `.headerBrand` class in `layout.module.css`, composed on at the call site.
  Left in the shared class it would draw a stray vertical rule down the inside
  of a modal card, which is exactly the kind of leak that made the modals
  hand-roll their own version in the first place.
- **REQ-4** — Alignment is the **container's** business, not the block's. The
  header and the About card leave it left-aligned; `.start-card`
  (`src/styles/base.css`: `flex` + `align-items: center` + `text-align: center`)
  centres it with no cooperation from this component.
- **REQ-5** — `Modal.titleClass` / `Modal.tagClass` remain for modals whose
  heading is a *title*, not the product name (`ai-prompt.ts`). This component
  does not replace them.

## Technical design

### Contract / public interface

```ts
// src/ui/components/brand.ts
export function createBrand(): HTMLElement;
```

### Layer touchpoints & ordering

- Pure DOM component (`ui/components/`) — no bus, no engine, no state, so it is
  safe to call before audio exists (the start modal renders pre-gesture).
- Styling is `src/ui/styles/brand.module.css`; no media query alters it, so the
  block is identical at every width (the header's *surroundings* reflow —
  [responsive-header](responsive-header.md) — the brand itself does not).

### Persistence

None.

## Scenarios (BDD)

```gherkin
Scenario: every surface renders the same block
  Given the header, the About modal and the start modal are built
  Then each contains a brand block with VAST, a boxed G1-J5 and the tagline
   And the markup and classes are identical across all three
# pinned by: tests/ui/brand.test.ts

Scenario: the header's divider does not leak into a modal (REQ-3)
  Given the About modal is open
  Then its brand block carries no border-right/padding-right framing class
   And the header's block does carry it
# pinned by: tests/ui/brand.test.ts, tests/ui/about.test.ts
```

## Tests & verification

- Unit: `tests/ui/brand.test.ts` (structure + the framing rule), and
  `tests/ui/about.test.ts` (the About card renders it in place of a title/tag).
- E2E: `e2e/smoke.spec.ts` asserts the header's `G1-J5` after the start modal
  has left the DOM.
- Typecheck: `npm run typecheck`. Appearance is verified by eye — this spec is
  about a faceplate.
