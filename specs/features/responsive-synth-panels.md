# Responsive synth panels (knob distribution across widths)

```yaml
id: responsive-synth-panels
status: implemented
version: 3   # v3: the 6-knob FILTER panel (.hex)
owner: ui
related:
  - responsive-header
  - architecture
  - filter-models
source:
  - src/ui/app.ts                    # buildMain: the .quad/.hex rows + row() helper
  - src/ui/styles/layout.module.css  # .quad + .hex grid rules and their overrides
```

## Background / Why

The synth faceplate is an 8-column grid of panels (`.main`, `layout.module.css`)
that reflows to 4 columns ≤1280px and 2 columns ≤992px (`src/styles/layout.css`
also shrinks `--knob-size` at each step). As panels widen on the reflow, a panel
holding **four** knobs has ample room to lay them on a single row.

Two of the four 4-knob panels — **SUB / UNI** and **FILTER** — were authored as
**two stacked `row()` divs** of 2 knobs each, so they render a fixed 2×2 at
*every* width, wasting a full knob-row of vertical space on tablets (e.g. iPad
Air ~820px, where the panel body is ~370px wide but 4 knobs need only ~188px).
The other two — **AMP ENV** and **FILTER ENV** — used a single flex-wrapping
`row()`, so they already collapsed to one row on tablets; but flex-wrap is
width-dependent, and on very wide (~1920px) monitors the 8-column panel is wide
enough for 3 knobs but not 4, so it wrapped **3+1**, breaking the 2×2 grouping.

The fix gives all four 4-knob panels one shared, deterministic layout: a CSS
grid that is 2×2 above 1280px and a single row at/below 1280px. Grid (unlike
flex-wrap) never produces a 3+1.

Once the 4-knob panels distribute their knobs across the full panel width on the
reflow, the remaining **3-knob** (OSC 1/2, MIXER) and **2-knob** (LFO) panels —
which keep a centred flex row with a tight 4px gap — read as **cramped** beside
them. So on the same ≤1280px reflow those rows also spread their knobs evenly
across the widened panel (`justify-content: space-evenly`), matching the `.quad`
panels' generosity. Above 1280px (narrow 8-column panels) they stay centred as
before. `space-evenly` on the flex row (rather than a rigid grid) keeps the
2-knob LFO from over-spreading to the far quarters.

## Requirements

- **REQ-1** — The 4-knob synth panels — **SUB / UNI**, **AMP ENV**,
  **FILTER ENV** — lay their knobs out via a shared `.quad` grid, not stacked
  `row()`s and not flex-wrap. (**FILTER** was one of them until it grew to six
  knobs; it now uses `.hex` — REQ-6.)
- **REQ-2** — **Above 1280px** (the 8-column `.main` grid, narrow panels) `.quad`
  is a **2-column** grid → the knobs render as a **2×2** block. Row-major fill
  preserves each panel's pairing (SUB/UNI: S.OCT/S.LVL over UNISON/SPREAD;
  envelopes: A/D over S/R).
- **REQ-3** — **At/below 1280px** (the 4-column and 2-column `.main` reflows,
  wider panels) `.quad` is a **4-column** grid → the knobs render as a **single
  row**. This holds across the whole ≤1280px range (knobs total ≤204px; the
  panel body is ≥205px throughout).
- **REQ-4** — No 3+1 (or other asymmetric) wrap at any width: because `.quad` is
  a fixed-column grid keyed to the same breakpoint as `.main`, the only two
  layouts possible are 2×2 (>1280px) and one row (≤1280px).
- **REQ-5** — The **3-knob** (OSC 1, OSC 2, MIXER) and **2-knob** (LFO) panels
  carry a `.spread` modifier on their knob row. **Above 1280px** it is inert —
  the row stays a centred flex cluster (`.panelRow`), unchanged. **At/below
  1280px** the row distributes its knobs `space-evenly` across the widened
  panel, so their spacing matches the neighbouring `.quad` panels rather than
  clustering in the middle.
- **REQ-6** — The **6-knob FILTER** panel ([filter-models.md](filter-models.md)
  added SHAPE and KEYTRK) uses a `.hex` grid with **three** shapes, each an even
  split — no 4+2 or 5+1, the same rule as REQ-4:

  | width | `.hex` | shape | why |
  | --- | --- | --- | --- |
  | ≥1630px | 3 columns | 3×2 | the panel finally fits three, so it stops standing a row taller than the whole faceplate and reads like the 3-up OSC/MIXER rows next to it |
  | 1281–1629px | 2 columns | 2×3 | `.quad`'s desktop ceiling is 2 per row; six knobs cannot beat it |
  | ≤1280px | 3 columns | 3×2 | panels widen on the reflow, where `.quad` fits 4 — three long labels sit comfortably inside that |

- **REQ-7** — **A column count may never make a cell narrower than a knob's
  ink.** The knob box is a fixed `--knob-size + 8px` (52/48/44px by breakpoint)
  and its label is *centred on the knob, not clipped to the box*, so an
  over-ambitious column count makes knobs overlap rather than merely crowd. The
  6-up first cut of `.hex` did exactly that at ≤1280px: ~40px cells for a 52px
  box. Verified by measuring label-text extents (knob centre ± `scrollWidth`/2)
  for every knob in every panel at 360–2560px; the dial's glow ring is excluded,
  since its negative inset bleeds outside the box by design.

## Technical design

### Contract / public interface

No new module. In `buildMain` (`src/ui/app.ts`) the local `row()` helper grows an
optional second argument — an extra CSS class appended to `.panelRow`:

```ts
function row(children: HTMLElement[], extraClass?: string): HTMLElement {
  const r = document.createElement('div');
  r.className = extraClass ? `${styles.panelRow!} ${extraClass}` : styles.panelRow!;
  for (const c of children) r.appendChild(c);
  return r;
}
```

- **SUB / UNI** and **FILTER** each collapse their two `row()` calls into one
  `row([...four knobs], styles.quad!)` (SUB/UNI keeps its `sub.wave` Segmented
  above the row unchanged).
- **AMP ENV** and **FILTER ENV** pass `styles.quad!` to their existing single
  `row(...)`.
- **OSC 1**, **OSC 2**, **MIXER** (3 knobs) and **LFO** (2 knobs) pass
  `styles.spread!` to their existing `row(...)` (REQ-5).

### Layer touchpoints & ordering

- `src/ui/styles/layout.module.css` — `.quad` layers additively over `.panelRow`
  (declared after it), overriding `display: flex` with a grid:

  ```css
  .quad {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 4px;
    justify-items: center;
    align-items: center;
    width: 100%;
  }
  ```

  `.spread` (REQ-5) is inert by default (its `.panelRow` centred flex stands);
  the same `@media (max-width: 1280px)` block (which already switches `.main` to
  4 columns) adds both overrides:

  ```css
  .quad   { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .spread { justify-content: space-evenly; }
  ```

  Breakpoint cascade in the file: 1280 → 1140 → 992 → 720; the overrides live in
  the 1280 block so they apply through every narrower width.

  `.hex` (REQ-6) is the same shape with three columns as its base, plus the one
  `min-width` rule in the file — the wide end is otherwise unbroken, since
  `.main` stays 8 columns above 1280px and panels just grow:

  ```css
  .hex { grid-template-columns: repeat(2, minmax(0, 1fr)); }          /* 1281–1629 */
  @media (min-width: 1630px) { .hex { repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 1280px) { .hex { repeat(3, minmax(0, 1fr)); } }
  ```
- `src/ui/app.ts` — the `row()` helper + the eight panel call sites (three
  `.quad`, one `.hex`, four `.spread`). No other construction changes.

### Persistence

None. Pure layout; no state, params, or audio touched.

## Scenarios (BDD)

```gherkin
Scenario: 4-knob panels are a single row on a tablet
  Given the app is open at an 820px-wide viewport
  Then the SUB / UNI knobs (S.OCT, S.LVL, UNISON, SPREAD) share one row
  And the FILTER knobs (CUTOFF, RESO, DRIVE, ENV) share one row

Scenario: 4-knob panels are a 2x2 block on a wide desktop
  Given the app is open at a 1440px-wide viewport
  Then the SUB / UNI knobs render as a 2x2 block
  And the layout stays 2x2 (never 3+1) at 1920px

Scenario: 3-knob panels spread across the widened panel on a tablet
  Given the app is open at an 820px-wide viewport
  Then the MIXER knobs (NOISE, GLIDE, DRIFT) are distributed evenly across the panel
  And they are not clustered in the centre with a tight gap

Scenario: 3-knob panels stay centred on a narrow desktop panel
  Given the app is open at a 1440px-wide viewport
  Then the OSC 1 knobs stay a centred cluster (the .spread modifier is inert)

Scenario: The 6-knob FILTER panel takes each of its three shapes (REQ-6)
  Given the app is open at a 1920px-wide viewport
  Then the FILTER knobs render 3 across in 2 rows
  When the viewport narrows to 1400px
  Then they render 2 across in 3 rows
  When the viewport narrows to 820px
  Then they render 3 across in 2 rows again
  And no row is ever a 4+2 or 5+1 split

Scenario: No knob's label ever reaches its neighbour (REQ-7)
  Given the app is open at any width from 360px to 2560px
  Then for every pair of knobs sharing a row in a panel
  And measuring each label's ink as its centre plus/minus scrollWidth/2
  Then the two extents do not overlap
```

## Tests & verification

- Typecheck: `npm run typecheck` (confirms `styles.quad` / `styles.hex` compile).
- Manual (`npm run dev`), device-emulate / resize:
  - **820px** (iPad Air): SUB/UNI, AMP ENV, FILTER ENV each show 4 knobs on one
    row; FILTER shows 3×2.
  - **~1280px**: still one row (4-column `.main`); FILTER still 3×2.
  - **1440px**: clean 2×2 (no 3+1); FILTER 2×3.
  - **1630px and up**: FILTER flips to 3×2 (REQ-6).
- REQ-7 is a **measurement**, not an eyeball: at each width, read every knob's
  label extent as `centre ± scrollWidth/2` and assert no two in a row overlap.
  Comparing bounding boxes instead gives false positives — the dial's glow ring
  has a negative inset and deliberately bleeds past the box.
- Optional e2e (`e2e/`): at an 820px viewport assert `knob-sub.octave` and
  `knob-unison.detune` share the same `offsetTop`.

## Open questions / future

- **`UNISON` / `SPREAD` labels touch at 360px** (SUB / UNI, `.quad` 4-up). The
  knob box is a fixed `--knob-size + 8px` — 44px at that breakpoint — while a
  six-character label at 9px/0.12em inks about 61px, so the label bleeds past
  its box and, in a 4-up cell that narrow, meets its neighbour by ~4.5px.
  Measured, pre-existing, and the only such collision in the app. The fix is a
  label-width rule (ellipsis, tighter tracking, or shorter words), not a column
  count — but it belongs to whoever owns knob typography, not to a filter change.

- A future panel needing a knob count other than 4 or 6 makes a third hand-rolled
  grid class; at that point generalise to a count-parameterised one rather than
  adding `.oct`. `.hex` was added (v3) rather than generalising because two
  classes is not yet a pattern.
- **`.hex` could go 3-up below 1630px.** The labels ink only ~39px against a 52px
  box, so three columns already fit at ~1400px (49px cells). 1630px was chosen
  for comfort — 55px cells, ~16px of air — not because anything collides below
  it. Lower the `min-width` if the shorter panel is worth the tighter spacing.
