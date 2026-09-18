# Responsive synth panels (knob distribution across widths)

```yaml
id: responsive-synth-panels
status: implemented
version: 6   # v6: REQ-quad-panels-use-a-fixed-grid — FILTER ENV goes dice-five (A · D / VEL / S · R) at
             #     ≥1630px. Its third knob row stood ~42px taller than every
             #     neighbour there and set the height of the whole faceplate row.
             # v5: REQ-fx-panels-fit-their-knob-run — the FX rack sizes panels to their knob runs above
             #     1360px. Equal columns had started wrapping the four-knob
             #     panels, and the rack's extra height pushed the panel below it
             #     past the fold.
             # v4: the LFO panel's title row now carries a tab strip (REQ-spread-rows-distribute-when-wide)
             # v3: the 6-knob FILTER panel (.hex)
owner: ui
related:
  - responsive-header
  - architecture
  - filter-models
source:
  - src/ui/app.ts                    # buildMain: the .quad/.hex rows + row() helper
  - src/ui/styles/layout.module.css  # .quad + .hex grid rules, .fxRow (REQ-fx-panels-fit-their-knob-run)
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

The **FX rack** (`.fxRow`) is a second grid of panels holding knobs, and REQ-fx-panels-fit-their-knob-run
brings it under the same rule for the same reason: a column count that ignores
what a panel actually holds eventually meets a panel it cannot hold. It is here
rather than in a spec of its own because the failure and the fix are REQ-a-cell-is-never-narrower-than-a-knob's,
one grid over — and because the two must be read together the next time a panel
count changes.

## Requirements

- **REQ-quad-panels-use-a-fixed-grid** — The 4-knob synth panels — **SUB / UNI**
  and **AMP ENV** — lay their knobs out via a shared `.quad` grid, not stacked
  `row()`s and not flex-wrap. Two panels have since outgrown it and kept the
  same idea under their own class: **FILTER** at six knobs uses `.hex`
  (REQ-filter-hex-has-three-even-shapes), and **FILTER ENV** at five — A/D/S/R
  plus `filter.velAmount` (VEL) — uses `.quint`, which takes three shapes. None
  of them is ragged:

  | width | `.quint` | shape | why |
  | --- | --- | --- | --- |
  | ≥1630px | 3 columns × 2 rows | **dice-five**: A · D over S · R in the corners, VEL in the middle column, spanning both rows and vertically centred | three rows stood ~42px taller than any neighbour (3×74 + 2×8 = 238px of knobs against a segmented + two rows ≈ 196px), and the faceplate row takes its tallest panel's height, out of the section below it. The panel fits three columns from here on (the `.hex` step, REQ-filter-hex-has-three-even-shapes) |
  | 1281–1629px | 2 columns | A D / S R / VEL, the fifth spanning the row and centred | FILTER (`.hex` 2×3 + its segmented) and OSC 1 already stand taller, so the third row costs nothing |
  | ≤1280px | 5 columns | one row; the span is undone | panels widen on the reflow, where five fit |

  - **Why the dice-five is not the label-ink problem REQ-a-cell-is-never-narrower-than-a-knob guards.** The
    corners sit in columns 1 and 3 and VEL in column 2, so no two knob boxes
    share a column, and VEL, offset half a row, shares no label line with a
    corner. `.hex`'s 1630px threshold is set by three six-character labels on
    one line; the envelope's one-to-three-character labels are nowhere near it.
  - **Placement is explicit, not auto-flow.** Each child is placed by position
    (`nth-child`), so the shape cannot depend on rule order, and the DOM order
    (A, D, S, R, VEL) — hence Tab order — is untouched.
  - **The corners mirror AMP ENV.** Its 2×2 spreads across the panel the same
    way, so the two envelope panels side by side read as the same instrument,
    with VEL filling the space AMP ENV leaves empty.
- **REQ-above-1280-quads-are-two-by-two** — **Above 1280px** (the 8-column
  `.main` grid, narrow panels) `.quad` is a **2-column** grid → the knobs render
  as a **2×2** block. Row-major fill preserves each panel's pairing (SUB/UNI:
  S.OCT/S.LVL over UNISON/SPREAD; envelopes: A/D over S/R).
- **REQ-below-1280-quads-are-one-row** — **At/below 1280px** (the 4-column and
  2-column `.main` reflows, wider panels) `.quad` is a **4-column** grid → the
  knobs render as a **single row**. This holds across the whole ≤1280px range
  (knobs total ≤204px; the panel body is ≥205px throughout).
- **REQ-quads-never-wrap-asymmetrically** — No 3+1 (or other asymmetric) wrap at
  any width: because `.quad` is a fixed-column grid keyed to the same breakpoint
  as `.main`, the only two layouts possible are 2×2 (>1280px) and one row
  (≤1280px).
- **REQ-spread-rows-distribute-when-wide** — The **3-knob** (OSC 1, OSC 2,
  MIXER) and **2-knob** (LFO) panels carry a `.spread` modifier on their knob
  row. **Above 1280px** it is inert — the row stays a centred flex cluster
  (`.panelRow`), unchanged. **At/below 1280px** the row distributes its knobs
  `space-evenly` across the widened panel, so their spacing matches the
  neighbouring `.quad` panels rather than clustering in the middle.
  - (v4) The LFO panel's **title row is a two-tab strip**
    ([panel-tabs](panel-tabs.md), [lfo](lfo.md) REQ-the-two-lfos-share-one-panel). It replaces the title
    rather than joining it, holds a plain `.panelTitle`'s height so the panel
    stays on its neighbours' baseline, and its tabs take an even share of the
    row — so the labels fit the ~191 px 8-column cell by construction at every
    width, with no metric to re-tune per breakpoint.
- **REQ-filter-hex-has-three-even-shapes** — The **6-knob FILTER** panel
  ([filter-models.md](filter-models.md) added SHAPE and KEYTRK) uses a `.hex`
  grid with **three** shapes, each an even split — no 4+2 or 5+1, the same rule
  as REQ-quads-never-wrap-asymmetrically:

  | width | `.hex` | shape | why |
  | --- | --- | --- | --- |
  | ≥1630px | 3 columns | 3×2 | the panel finally fits three, so it stops standing a row taller than the whole faceplate and reads like the 3-up OSC/MIXER rows next to it |
  | 1281–1629px | 2 columns | 2×3 | `.quad`'s desktop ceiling is 2 per row; six knobs cannot beat it |
  | ≤1280px | 3 columns | 3×2 | panels widen on the reflow, where `.quad` fits 4 — three long labels sit comfortably inside that |

- **REQ-a-cell-is-never-narrower-than-a-knob** — **A column count may never make
  a cell narrower than a knob's ink.** The knob box is a fixed `--knob-size +
  8px` (52/48/44px by breakpoint) and its label is *centred on the knob, not
  clipped to the box*, so an over-ambitious column count makes knobs overlap
  rather than merely crowd. The 6-up first cut of `.hex` did exactly that at
  ≤1280px: ~40px cells for a 52px box. Verified by measuring label-text extents
  (knob centre ± `scrollWidth`/2) for every knob in every panel at 360–2560px;
  the dial's glow ring is excluded, since its negative inset bleeds outside the
  box by design.

- **REQ-fx-panels-fit-their-knob-run** — (v5) **No FX rack panel is ever
  narrower than its own knob run.** The rack (`.fxRow`) holds panels of
  *unequal* content — a four-knob panel (PHASER, DUCK) spends `4×52 + 3×4 =
  220px` on its run, a three-knob panel 164px — so a single equal column width
  cannot serve them all, exactly as a 4+2 split cannot serve `.hex`
  (REQ-filter-hex-has-three-even-shapes). Above **1360px** the tracks are
  `minmax(min-content, 1fr)`, which is an equal share with a floor: `1fr` hands
  every panel the same width, and the `min-content` floor lifts a four-knob
  panel off it when that share falls below the 242px its run plus 22px of
  padding and border needs.
  - **So the rack is equal-width when it can afford to be.** Above ~1546px the
    equal share clears 242px on its own and every panel is the same width, as
    before. Between 1360px and there, the four-knob panels hold at 242px and the
    three-knob ones absorb the difference — at 1440px, 242px against 210px.
    Only the tight case is treated specially, which is why the rule reads as no
    visible change on a wide monitor.
  - **`.fxKnobs` must not wrap for this to mean anything.** A wrapping flex row's
    min-content is **one knob**, so the track would ask for 52px and the rule
    would collapse back to equal columns. `flex-wrap: nowrap` above the step is
    safe and is the only place it is safe: the track is guaranteed ≥ the run, and
    the run is font-independent (fixed knob boxes), so nothing is left to wrap
    for.
  - **Why 1360px.** It is where the six minimums first fit:
    `2×242 + 4×186 + 5×10` of gaps `+ 44` of side margin ≈ 1350px. A grid cannot
    wrap, so below that the rule would spill past the rack's right edge and be
    **clipped silently** — the equal-column fallback takes over instead and lets
    the knob rows wrap, which is what this rack did below ~1294px when it held
    five panels.
  - **This is REQ-a-cell-is-never-narrower-than-a-knob for a second grid, and it is not cosmetic.** Six equal
    columns need 1546px before a four-knob panel clears 242px. When the rack went
    from five panels to six, each column fell to 220px at 1440px, PHASER and DUCK
    each dropped a knob onto a second row, and the rack grew **177px → 255px**.
    The faceplate is a fixed-height grid that does not scroll, so that 78px came
    out of the panel below: the sequencer's step-settings row went past the fold,
    taking its `position: fixed` info badge with it — unreachable, since a fixed
    element cannot be scrolled into view.

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
  `row([...], styles.quad!)` / `row([...], styles.hex!)` (SUB/UNI keeps its
  `sub.wave` Segmented above the row unchanged).
- **AMP ENV** passes `styles.quad!` and **FILTER ENV** `styles.quint!` to their
  existing single `row(...)`.
- **OSC 1**, **OSC 2**, **MIXER** (3 knobs) and **LFO** (2 knobs) pass
  `styles.spread!` to their existing `row(...)` (REQ-spread-rows-distribute-when-wide). The LFO's is in
  `src/ui/panels/lfo-panel.ts`, not `app.ts`.

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

  `.spread` (REQ-spread-rows-distribute-when-wide) is inert by default (its `.panelRow` centred flex stands);
  the same `@media (max-width: 1280px)` block (which already switches `.main` to
  4 columns) adds both overrides:

  ```css
  .quad   { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .spread { justify-content: space-evenly; }
  ```

  Breakpoint cascade in the file: 1280 → 1140 → 992 → 720; the overrides live in
  the 1280 block so they apply through every narrower width.

  `.hex` (REQ-filter-hex-has-three-even-shapes) is the same shape with three columns as its base, and `.quint`
  (REQ-quad-panels-use-a-fixed-grid) is `.quad`'s two columns with the odd fifth child spanning. Both change
  shape in the file's one `min-width` block, at 1630px — the wide end is
  otherwise unbroken, since `.main` stays 8 columns above 1280px and panels just
  grow — and again on the reflow:

  ```css
  .hex { grid-template-columns: repeat(2, minmax(0, 1fr)); }          /* 1281–1629 */
  .quint { grid-template-columns: repeat(2, minmax(0, 1fr)); }        /* A D / S R / VEL */
  .quint > *:last-child { grid-column: 1 / -1; }

  @media (min-width: 1630px) {
    .hex { repeat(3, minmax(0, 1fr)); }
    .quint { repeat(3, minmax(0, 1fr)); }                             /* dice-five */
    .quint > :nth-child(1) { grid-column: 1; grid-row: 1; }           /* A */
    .quint > :nth-child(2) { grid-column: 3; grid-row: 1; }           /* D */
    .quint > :nth-child(3) { grid-column: 1; grid-row: 2; }           /* S */
    .quint > :nth-child(4) { grid-column: 3; grid-row: 2; }           /* R */
    .quint > *:last-child { grid-column: 2; grid-row: 1 / span 2; }   /* VEL */
  }
  @media (max-width: 1280px) {
    .hex { repeat(3, minmax(0, 1fr)); }
    .quint { repeat(5, minmax(0, 1fr)); }
    .quint > *:last-child { grid-column: auto; }
  }
  ```

  The spanning VEL is vertically centred by `.quint`'s own `align-items:
  center`; nothing extra is needed. The two media blocks never overlap, so the
  1630px placements cannot leak into the reflow.
- `src/ui/app.ts` — the `row()` helper + seven `panel()` call sites: two `.quad`
  (SUB/UNI, AMP ENV), one `.hex` (FILTER), one `.quint` (FILTER ENV) and three
  `.spread` (OSC 1, OSC 2, MIXER). The eighth faceplate panel, **LFO**, is built
  by `buildLfoPanel` through `createTabbedPanel` and carries the fourth
  `.spread`. No other construction changes.

### Persistence

None. Pure layout; no state, params, or audio touched.

## Scenarios (BDD)

> Every claim here is about *rendered geometry at a given viewport width*, which
> jsdom cannot measure and which a screenshot test would pin to a font stack
> rather than to the rule. `e2e/responsive-panels.spec.ts` measures it instead:
> it recovers each panel's rows from the knob testids grouped by `offsetTop`
> (panels carry no testid of their own), so the assertion is the row *shape*,
> never a class name or a pixel image. REQ-a-cell-is-never-narrower-than-a-knob is a measurement there too, not an
> eyeball — label ink as `centre ± scrollWidth/2`, swept 360-2560px.

```gherkin
Scenario: 4-knob panels are a single row on a tablet
  Given the app is open at an 820px-wide viewport
  Then the SUB / UNI knobs (S.OCT, S.LVL, UNISON, SPREAD) share one row
  And the FILTER ENV knobs (A, D, S, R, VEL) share one row — .quint's span is undone
  And the six FILTER knobs (CUTOFF, RESO, SHAPE, DRIVE, ENV, KEYTRK) render 3x2
# pinned by: e2e/responsive-panels.spec.ts (the wide panels each collapse to a
#            single row on a tablet)

Scenario: 4-knob panels are a 2x2 block on a wide desktop
  Given the app is open at a 1440px-wide viewport
  Then the SUB / UNI knobs render as a 2x2 block
  And the layout stays 2x2 (never 3+1) at 1920px
# pinned by: e2e/responsive-panels.spec.ts (4-knob panels are a 2x2 block on the
#            desktop, never 3+1 — swept 1281/1440/1920/2560px)

Scenario: FILTER ENV takes each of its three shapes (REQ-quad-panels-use-a-fixed-grid)
  Given the app is open at a 1440px-wide viewport
  Then the FILTER ENV knobs render A D / S R / VEL
  And VEL is centred across the panel, not left-ragged
  When the viewport widens to 1630px
  Then A and D share the top row and S and R the bottom one, in the outer columns
  And VEL sits in the middle column, centred both across the panel and between the two rows
  And no corner knob's box reaches into VEL's column
  And the FILTER ENV knobs stand no taller than the AMP ENV knobs beside them
  When the viewport narrows to 1629px
  Then they render A D / S R / VEL again
  When the viewport narrows to 1280px
  Then all five share one row
# pinned by: e2e/responsive-panels.spec.ts (the 5-knob FILTER ENV panel takes each
#            of its three shapes — dice-five asserted at 1630px and 1920px)

Scenario: 3-knob panels spread across the widened panel on a tablet
  Given the app is open at an 820px-wide viewport
  Then the MIXER knobs (NOISE, GLIDE, DRIFT) are distributed evenly across the panel
  And they are not clustered in the centre with a tight gap
# pinned by: e2e/responsive-panels.spec.ts (3-knob rows spread on a tablet …)

Scenario: 3-knob panels stay centred on a narrow desktop panel
  Given the app is open at a 1440px-wide viewport
  Then the OSC 1 knobs stay a centred cluster (the .spread modifier is inert)
  And the claim is about the modifier, not the row count: an 8-column panel is
    ~141px wide there, so the flex row wraps 2+1 and each row is centred at the
    row's own 4px gap (one row of three from ~1630px, where the panel fits it)
# pinned by: e2e/responsive-panels.spec.ts (… and stay a centred cluster on the
#            desktop — asserted per rendered row at 1440px and 1920px)

Scenario: The 6-knob FILTER panel takes each of its three shapes (REQ-filter-hex-has-three-even-shapes)
  Given the app is open at a 1920px-wide viewport
  Then the FILTER knobs render 3 across in 2 rows
  When the viewport narrows to 1400px
  Then they render 2 across in 3 rows
  When the viewport narrows to 820px
  Then they render 3 across in 2 rows again
  And no row is ever a 4+2 or 5+1 split
# pinned by: e2e/responsive-panels.spec.ts (the 6-knob FILTER panel takes each of
#            its three shapes — including the 1629/1630 and 1280 thresholds)

Scenario: No knob's label ever reaches its neighbour (REQ-a-cell-is-never-narrower-than-a-knob)
  Given the app is open at any width from 360px to 2560px
  Then for every pair of knobs sharing a row in a panel
  And measuring each label's ink as its centre plus/minus scrollWidth/2
  Then the two extents do not overlap
  Except in SUB / UNI below 768px, where the 4-up cell is narrower than its
    six-character labels — the pre-existing collision in "Open questions"
    below, carried in the test as a bounded exception scoped to that one panel
    so it is stated rather than skipped
# pinned by: e2e/responsive-panels.spec.ts (no knob label ever reaches its
#            neighbour)

Scenario: No FX rack panel wraps its knob run at desktop widths (REQ-fx-panels-fit-their-knob-run)
  Given the app is open at 1360px, 1440px, 1600px or 1920px
  And every effect in the synth FX rack is engaged
  Then each panel lays its knobs on exactly one row
  And the rack is one panel row tall
  And no four-knob panel is narrower than a three-knob one
  And below 1546px, where the equal share stops clearing 242px,
    the four-knob panels are strictly wider
# pinned by: e2e/responsive-panels.spec.ts (no FX rack panel wraps its knob run)
```

## Tests & verification

- E2E: `e2e/responsive-panels.spec.ts` — `npm run e2e`. Row shapes at
  820/1281/1400/1440/1629/1630/1920/2560px (viewports changed *within* a test:
  each boot is a full AudioContext), plus REQ-a-cell-is-never-narrower-than-a-knob's label-ink sweep and REQ-fx-panels-fit-their-knob-run's
  FX rack sweep at 1360/1440/1600/1920px.
- Typecheck: `npm run typecheck` (confirms `styles.quad` / `.hex` / `.quint` compile).
- Manual (`npm run dev`), device-emulate / resize:
  - **820px** (iPad Air): SUB/UNI and AMP ENV show 4 knobs on one row, FILTER ENV
    shows 5 on one row; FILTER shows 3×2.
  - **~1280px**: still one row each (4-column `.main`); FILTER still 3×2.
  - **1440px**: `.quad` is a clean 2×2 (no 3+1); FILTER ENV is A D / S R / VEL
    with VEL centred across the row; FILTER 2×3.
  - **1630px and up**: FILTER flips to 3×2 (REQ-filter-hex-has-three-even-shapes) and FILTER ENV to the
    dice-five (REQ-quad-panels-use-a-fixed-grid), both at the same step; the synth panel row is no taller
    than a segmented + two knob rows, and VEL's glow ring does not crowd the
    corner dials.
- REQ-a-cell-is-never-narrower-than-a-knob is a **measurement**, not an eyeball: at each width, read every knob's
  label extent as `centre ± scrollWidth/2` and assert no two in a row overlap.
  Comparing bounding boxes instead gives false positives — the dial's glow ring
  has a negative inset and deliberately bleeds past the box. (This is what the
  e2e does; the manual pass is for judging whether the result *looks* right.)

## Open questions / future

- **SUB / UNI labels touch at phone widths** (`.quad` 4-up). The knob box is a
  fixed `--knob-size + 8px` — 44px at that breakpoint — while a six-character
  label (`S.LVL`, `UNISON`, `SPREAD`) at 9px/0.12em inks past it, so in a 4-up
  cell that narrow it meets its neighbour. It is the only such collision in the
  app: every other panel is clear at every width from 360px to 2560px.

  **How much** depends on the font stack, which is why the test bounds it rather
  than pinning a figure. `UNISON`/`SPREAD` overlap ~5px at 360px on Windows and
  ~11.5px on the Linux CI runner, where `S.LVL`/`UNISON` also meets (~3.5px) and
  on Windows does not. `e2e/responsive-panels.spec.ts` therefore excuses only
  this panel, only below 768px, and only up to 20px — so a real regression still
  fails while a font difference does not. Closing this question means deleting
  that block. The fix is a label-width rule (ellipsis, tighter tracking, or
  shorter words), not a column count — but it belongs to whoever owns knob
  typography, not to a filter change.

- A future panel needing a knob count other than 4 or 6 makes a third hand-rolled
  grid class; at that point generalise to a count-parameterised one rather than
  adding `.oct`. `.hex` was added (v3) rather than generalising because two
  classes is not yet a pattern.
- **`.hex` could go 3-up below 1630px.** The labels ink only ~39px against a 52px
  box, so three columns already fit at ~1400px (49px cells). 1630px was chosen
  for comfort — 55px cells, ~16px of air — not because anything collides below
  it. Lower the `min-width` if the shorter panel is worth the tighter spacing.
