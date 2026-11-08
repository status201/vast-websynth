# Brand block (VAST G1-J8 identity)

```yaml
id: brand
status: implemented
version: 6
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

The product's on-screen identity — `VAST` + a boxed `G1-J8` + the tagline —
rendered from one place wherever it appears.

## Background / Why

The name appeared on three surfaces in two different shapes. The header drew the
real thing: `VAST` in the display serif, `G1-J8` boxed in monospace beside it,
and `Vast Audio Synthesis Technology` underneath — a faceplate, which is the
whole point of an instrument that is trying not to look like a web app. The
About modal and the "Tap to start" modal each hand-rolled a flattened
lookalike (`VAST G1-J8` as one serif line plus an italic tagline) using the
generic `Modal.titleClass` / `Modal.tagClass`.

Two renderings of one identity drift: a change to the model badge or the
tagline had to be made three times, and the modals' version was already a
different font, size, weight and colour from the header's. This is a facility,
not a feature — it owns markup and styling only, and has no state.

## Requirements

- **REQ-brand-block-has-no-variants** — `createBrand()` returns the block: a
  `.brand` column containing a `.brandRow` (`.brandName` `VAST` + `.brandModel`
  `G1-J8`) and a `.brandTagline` (`Vast Audio Synthesis Technology`). Every
  consumer renders **identical** markup and typography; there is no size or
  content variant *in the block*. A consumer may still scale the whole block
  from its own framing class (REQ-a-consumer-may-scale-the-block).
- **REQ-name-surfaces-call-create-brand** — Consumers: the header (`ui/shell/header.ts`
  `buildHeader`), the About modal (`ui/components/about-modal.ts`, whose
  `buildModal` calls `createBrand()`), and the start modal (`main.ts`
  `showStartModal`). A new surface that shows the name calls this rather than
  restating it.
- **REQ-brand-block-carries-no-framing** — **The block carries no outer
  framing.** `.brand` styles only its own contents (column flow, gap,
  line-height). The header's divider rule — `padding-right` / `border-right` /
  `margin-right` — lives in a header-only `.headerBrand` class in
  `header.module.css`, composed on at the call site. Left in the shared class it
  would draw a stray vertical rule down the inside of a modal card, which is
  exactly the kind of leak that made the modals hand-roll their own version in
  the first place.
- **REQ-a-consumer-may-scale-the-block** (v3) — **Scale, like framing, is the
  consumer's.** The block stays size-agnostic; a consumer that wants it smaller
  scales it as a whole from its own class, so the proportions (and the badge's
  optical centring, REQ-model-badge-is-optically-centred) survive untouched. The
  header does: below 1680px `.headerBrand` is `zoom: 0.6` — the faceplate reads
  as a small badge beside the controls rather than competing with them — and
  from 1680px up it is drawn at full size, since a very wide header has the room
  and the small badge looks lost there. At every width it is
  `flex-shrink: 0` and `white-space: nowrap`, so a tight header row can never
  squeeze the tagline onto a second line (its min-content was only the longest
  word). The divider's `padding-right` matches the margin plus the header's gap
  on the other side — 18px at full size, 24px *before* the zoom at 60% — so the
  rule sits evenly between the logo and the preset cluster at either size. The
  About and start modals always draw the block at full size.
- **REQ-brand-alignment-belongs-to-the-container** — Alignment is the
  **container's** business, not the block's. The header and the About card leave
  it left-aligned; `.start-card` (`src/styles/base.css`: `flex` + `align-items:
  center` + `text-align: center`) centres it with no cooperation from this
  component.
- **REQ-modal-title-classes-are-not-replaced** — `Modal.titleClass` /
  `Modal.tagClass` remain for modals whose heading is a *title*, not the product
  name (`ai-prompt.ts`). This component does not replace them.
- **REQ-model-badge-is-optically-centred** (v2) — **The model badge's padding is
  optically centred, so it is deliberately asymmetric.** `G1-J8` in a symmetric
  box sits visibly high and left, because the box is sized from metrics this
  string never uses: Courier New reserves 5px of descent under a 15px line and a
  model number has no descender (ink 1px above centre), and `letter-spacing` is
  applied after the *last* glyph too (0.14em of extra air on the right). The
  padding takes both back — `4px calc(8px - 0.14em) 2px 8px` — leaving the
  border-box height unchanged, so nothing in the header row reflows.
  - This is a correction to **this string in this face at this size**. If the
    model number, the font or the size changes, re-measure rather than carrying
    the numbers over; a string with a descender would need none of it.
  - It is not covered by an automated test, and cannot usefully be — the target
    is what the eye reads as centred. It is written down here because a
    symmetric `padding: 3px 8px` looks like the tidy version, and reverting to
    it is the obvious wrong move.

- **REQ-the-tagline-spans-the-badge-row** (v6) — **The tagline ends near the
  end of the `G1-J8` badge**, within a few pixels, in every theme and on every
  platform: its tracking is 0.15em everywhere, and it is the row that a theme
  keeps in proportion to it. The tagline and `VAST` share `--serif`, so a face's
  width moves both.
  - A tracking tuned to one platform's fallback overshoots on the others, and a
    wider tagline stretches the block. That is why tracking is not per theme.
- **REQ-the-name-weight-stays-in-the-family** (v6) — **`VAST` must not change
  width class with the platform.** `.brandName` is 900 unless the theme sets
  `--brand-name-weight`. On Windows the browser treats Arial Narrow and Arial
  Black as one family, so 900 under `'Arial Narrow'` draws `VAST` in Arial Black,
  21px wider than the Arial Narrow Bold other platforms draw. A condensed theme
  therefore sets 700, which is bold in that family everywhere; Pastel does.
- **REQ-pastel-names-a-narrow-face-per-platform** (v6) — **Pastel's `--serif`
  names a narrow face for each platform before any normal-width one**: Arial
  Narrow (Windows, macOS), Liberation Sans Narrow, Roboto Condensed,
  `sans-serif-condensed` (Android's name for it) and DejaVu Sans Condensed. A
  machine with none of them falls to Helvetica Neue or Arial, which behave as
  Classic does on that platform.
  - Tagline minus row, full-size, measured in Chromium on Windows with each font
    file: Arial Narrow −3px, Roboto Condensed −6.7px, DejaVu Sans Condensed
    −3.1px, Arial +10.7px. Liberation Sans Narrow is Arial Narrow's metric clone.
  - Only Windows has been seen. On the others the face is what these names are
    documented to resolve to; a face added to the stack is measured the same way.

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
  block is identical at every width (the header's 60% below 1680px is a `zoom`
  on `.headerBrand`, REQ-a-consumer-may-scale-the-block) (the header's *surroundings* reflow —
  [responsive-header](responsive-header.md) — the brand itself does not).

### Persistence

None.

## Scenarios (BDD)

```gherkin
Scenario: every surface renders the same block
  Given the header, the About modal and the start modal are built
  Then each contains a brand block with VAST, a boxed G1-J8 and the tagline
   And the markup and classes are identical across all three
# pinned by: tests/ui/brand.test.ts

Scenario: the header's divider does not leak into a modal (REQ-brand-block-carries-no-framing)
  Given the About modal is open
  Then its brand block carries no border-right/padding-right framing class
   And the header's block does carry it
# pinned by: tests/ui/brand.test.ts, tests/ui/about.test.ts

Scenario: the header logo never wraps (REQ-a-consumer-may-scale-the-block)
  Given the app is open at any width from 360px to 1920px
  Then the header's brand tagline sits on a single line
   And the header's brand block is zoomed to 0.6 below 1680px and to 1 from 1680px up
# pinned by: e2e/responsive-header.spec.ts (a very long preset name never overflows at any width)

Scenario: Pastel's logo keeps its width without Arial Narrow's Windows quirk (regression, REQ-the-tagline-spans-the-badge-row, REQ-the-name-weight-stays-in-the-family, REQ-pastel-names-a-narrow-face-per-platform)
  Given the Pastel theme on a platform where Arial Narrow is missing, or where 900 is not Arial Black
  Then the tagline is tracked at 0.15em, as in every other theme
   And VAST is set bold in the same narrow family, not black in a wider one
   And the stack reaches a narrow face before any normal-width one
# pinned by: tests/ui/brand.test.ts (the width itself: measured, jsdom lays out no text)
```

## Tests & verification

- Unit: `tests/ui/brand.test.ts` (structure + the framing rule), and
  `tests/ui/about.test.ts` (the About card renders it in place of a title/tag).
- E2E: `e2e/smoke.spec.ts` asserts the header's `G1-J8` once the start gate is
  past — which on an autoplay-permitting browser means no start modal was shown
  at all ([audio-lifecycle](audio-lifecycle.md) REQ-the-gesture-is-required-only-when-required), so the header's block is
  the only one in the DOM either way. The faceplate splash is therefore a
  first-run-on-a-blocked-browser sight, not a guaranteed one; the header and the
  About card carry the identity on every load.
- Typecheck: `npm run typecheck`. Appearance is verified by eye — this spec is
  about a faceplate.
