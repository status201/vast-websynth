# Responsive synth panels (knob distribution across widths)

```yaml
id: responsive-synth-panels
status: implemented
version: 10  # v10: REQ-selectors-pin-to-the-panel-edges — a panel body is three zones: the
             #     wave / model selector on top, the knobs centred in the middle, SYNC /
             #     glide mode / LFO destination at the bottom, so selectors line up across panels;
             #     REQ-selectors-never-outgrow-their-panel — the switches tighten where the
             #     panel is narrow (the glide switch had spilled past MIXER below ~1520px)
             # v9: OSC 1 carries FM + RING (cross-modulation.md REQ-the-modulator-controls-live-on-osc-1),
             #     so its row break is `.rowBreak.six` and holds until 3200px, the six-knob step
             # v8: REQ-quad-panels-use-a-fixed-grid — FILTER ENV goes dice-five below 500px too;
             #     five across overlapped the 36px dials on the 2-column phone faceplate.
             #     Default --knob-size drops to 30px at ≤720px (layout.css).
             # v7: REQ-ultrawide-panels-are-one-row — above 2560px every knob group spreads
             #     evenly and goes to one row where it fits (FILTER from 3200px).
             #     The 1630px shapes had stayed put while panels doubled in width.
             # v6: REQ-quad-panels-use-a-fixed-grid — FILTER ENV goes dice-five (A · D / VEL / S · R) at
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
  - src/ui/panels/synth-panels.ts    # buildSynthPanels: the .quad/.hex rows
  - src/ui/components/panel.ts       # knobRow + panelZones: the row shapes, top / knobs / bottom
  - src/ui/styles/panel.module.css   # .quad + .hex grid rules, .panelKnobs
  - src/ui/styles/fx-rack.module.css # .fxRow (REQ-fx-panels-fit-their-knob-run)
```

## Background / Why

The synth faceplate is an 8-column grid of panels (`.main`, `synth-panels.module.css`)
that reflows to 4 columns ≤1280px and 2 columns ≤992px (`src/styles/layout.css`
also shrinks `--knob-size` at each step — 44 → 40 → 36px — and once more, to
30px, at ≤720px). As panels widen on the reflow, a panel
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

The wide end has the mirror problem. `.main` stays 8 columns at every width
above 1280px, so on an ultrawide the panels keep growing — a 281px knob row at
2560px is 601px at 5120px — while the 1630px shapes stay put. The result mixes
three looks side by side: `.spread` rows clustered in the middle at a 4px gap,
grid panels flung to their quarters, and 2×2 / 3×2 / dice-five blocks with room
for a whole row to spare. REQ-ultrawide-panels-are-one-row applies the reflow's
answer at that end too: spread evenly, and one row wherever a row fits.

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
  plus `filter.velAmount` (VEL) — uses `.quint`, which takes three shapes over
  five width ranges. None of them is ragged:

  | width | `.quint` | shape | why |
  | --- | --- | --- | --- |
  | ≥2561px | 5 columns | one row; the dice-five placements are undone | REQ-ultrawide-panels-are-one-row — five 52px boxes fit a 281px row |
  | 1630–2560px | 3 columns × 2 rows | **dice-five**: A · D over S · R in the corners, VEL in the middle column, spanning both rows and vertically centred | three rows stood ~42px taller than any neighbour (3×74 + 2×8 = 238px of knobs against a segmented + two rows ≈ 196px), and the faceplate row takes its tallest panel's height, out of the section below it. The panel fits three columns from here on (the `.hex` step, REQ-filter-hex-has-three-even-shapes) |
  | 1281–1629px | 2 columns | A D / S R / VEL, the fifth spanning the row and centred | FILTER (`.hex` 2×3 + its segmented) and OSC 1 already stand taller, so the third row costs nothing |
  | 500–1280px | 5 columns | one row; the span is undone | panels widen on the reflow, where five fit |
  | ≤499px | 3 columns × 2 rows | **dice-five**, the same rule as 1630–2560px | the 2-column phone faceplate (`.main` ≤992px; 30px dials in a 38px box from ≤720px) leaves a ~164px body at 420px: five cells of ~30px, dial against dial with no air — they overlapped outright at the earlier 36px size. Three columns give ~52px cells. The extra knob row costs nothing — the LFO beside it (tabs + wave + knobs + destination) stands taller |

  - **One dice-five, two ranges.** The placement is a single CSS block whose
    media list is `(min-width: 1630px) and (max-width: 2560px), (max-width: 499px)`,
    so the wide and the phone shape cannot drift apart.

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
- **REQ-above-1280-quads-are-two-by-two** — **From 1281px to 2560px** (the 8-column
  `.main` grid, narrow panels) `.quad` is a **2-column** grid → the knobs render
  as a **2×2** block. Row-major fill preserves each panel's pairing (SUB/UNI:
  S.OCT/S.LVL over UNISON/SPREAD; envelopes: A/D over S/R).
- **REQ-below-1280-quads-are-one-row** — **At/below 1280px** (the 4-column and
  2-column `.main` reflows, wider panels) `.quad` is a **4-column** grid → the
  knobs render as a **single row**. This holds across the whole ≤1280px range
  (knobs total ≤204px; the panel body is ≥205px throughout).
- **REQ-quads-never-wrap-asymmetrically** — No 3+1 (or other asymmetric) wrap at
  any width: because `.quad` is a fixed-column grid keyed to fixed breakpoints,
  the only two layouts possible are 2×2 (1281–2560px) and one row (≤1280px and
  ≥2561px).
- **REQ-spread-rows-distribute-when-wide** — The **3-knob** (OSC 1, OSC 2,
  MIXER) and **2-knob** (LFO) panels carry a `.spread` modifier on their knob
  row. **From 1281px to 2560px** it is inert — the row stays a centred flex
  cluster (`.panelRow`), unchanged. **At/below 1280px and from 2561px** the row
  distributes its knobs `space-evenly` across the widened panel, so their
  spacing matches the neighbouring grid panels rather than clustering in the
  middle. The LFO keeps its three zones (wave on top, knobs in the middle,
  destination at the bottom — REQ-selectors-pin-to-the-panel-edges); only its
  knob row spreads.
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
  | ≥3200px | 6 columns | one row | REQ-ultrawide-panels-are-one-row — the row is ≥361px, 60px cells for a 52px box |
  | 1630–3199px | 3 columns | 3×2 | the panel finally fits three, so it stops standing a row taller than the whole faceplate and reads like the 3-up OSC/MIXER rows next to it |
  | 1281–1629px | 2 columns | 2×3 | `.quad`'s desktop ceiling is 2 per row; six knobs cannot beat it |
  | ≤1280px | 3 columns | 3×2 | panels widen on the reflow, where `.quad` fits 4 — three long labels sit comfortably inside that |

- **REQ-ultrawide-panels-are-one-row** — (v7) **Above 2560px every synth panel
  spreads its knobs evenly and lays them on one row as soon as that row fits.**
  A knob row there is `(W − 312) / 8` px wide (281 @2560, 391 @3440, 601 @5120)
  and a one-row layout needs `n × 52 + (n − 1) × 4` px — the boxes, not the
  labels (≤41px ink), are the constraint:

  | from | change | row needed | row at the step |
  | --- | --- | --- | --- |
  | 2561px | `.spread` goes `space-evenly` (OSC 1, OSC 2, MIXER, LFO); `.quad` 4 columns (SUB/UNI, AMP ENV); `.quint` 5 columns, dice-five undone (FILTER ENV) | 220 / 276px | 281px |
  | 3200px | `.hex` 6 columns (FILTER) | 332px | 361px — 60px cells |

  - **OSC 1/2's WIDTH joins the row.** On the square wave each oscillator
    shows a fourth knob, WIDTH (oscillators.md REQ-oscillators-have-a-pulse-width).
    It is a child of the same `.spread` row, after a zero-height `.rowBreak`
    that takes a full line (`flex-basis: 100%`) up to 2560px — so there it sits
    on its own centred line exactly as before, never a 3+1 wrap, and the two
    4px row gaps either side of the break give the 8px a separate row had. From
    2561px the break is `display: none`, and the four knobs share one even row
    (220px of boxes in a ≥281px row). WIDTH's show/hide toggles the break with
    it, so a hidden WIDTH leaves no empty line.
  - **OSC 1's break holds until 3200px** (v9). OSC 1 always shows FM and RING
    behind its break ([cross-modulation](cross-modulation.md)
    REQ-the-modulator-controls-live-on-osc-1), so with WIDTH it has six knobs,
    which first fit one row at 3200px, the step `.hex` takes for the same six.
    Its break is therefore `.rowBreak.six`, kept by the 2561px block and dropped
    only at 3200px.
  - **Why ≤2560px is untouched.** 2560 is where the user judged the faceplate
    right, and where FILTER's six would not fit anyway (47px cells for a 52px
    box — REQ-a-cell-is-never-narrower-than-a-knob).
  - **Why FILTER waits for 3200px.** Six boxes first fit at ~2970px with no air
    between them; 3200px gives 8px, the same comfort `.hex`'s 1630px step chose.
    Between the two steps FILTER is the one 3×2 panel — and so sets the row's
    height exactly as it does at 2560px; nothing grows.
  - **The row gets shorter.** From 3200px the tallest panel is the LFO (tabs +
    wave + knobs + destination), and the faceplate row drops from 245px to
    ~203px — height the scope and keyboard below take up.

- **REQ-a-cell-is-never-narrower-than-a-knob** — **A column count may never make
  a cell narrower than a knob's ink.** The knob box is a fixed `--knob-size +
  8px` (52/48/44/38px by breakpoint) and its label is *centred on the knob, not
  clipped to the box*, so an over-ambitious column count makes knobs overlap
  rather than merely crowd. The 6-up first cut of `.hex` did exactly that at
  ≤1280px: ~40px cells for a 52px box. Verified by measuring label-text extents
  (knob centre ± `scrollWidth`/2) for every knob in every panel at 360–2560px;
  the dial's glow ring is excluded, since its negative inset bleeds outside the
  box by design.
  - (v8) **Label ink cannot see a dial collision when the labels are short.**
    FILTER ENV's five-across row at 420px overlapped its 36px dials while
    `A`/`D`/`S`/`R`/`VEL` stayed clear of each other, so the sweep passed. The
    FILTER ENV scenario therefore asserts box clearance directly in each
    dice-five range.

- **REQ-selectors-pin-to-the-panel-edges** — (v10) **A synth panel body is three
  zones, and the selectors sit on its edges.** The wave / model selector opens
  the body (OSC 1, OSC 2, SUB / UNI and LFO's wave pickers, FILTER's LADDER /
  POLY); the mode control closes it (OSC 2's SYNC, MIXER's glide mode, the LFO
  destination dropdown); and the knobs sit in a zone that takes all the height
  between them and centres its contents. A panel with no selector at an edge has
  nothing there, so its knobs centre in what is left — AMP ENV and FILTER ENV
  centre in the whole body, exactly as before.
  - **Why this lines them up.** Every panel header is 21px (the LFO's tab strip
    included, pinned by `tests/ui/panel-header-height.test.ts`), and the grid
    stretches every panel in a faceplate row to the same height — so every body
    starts and ends at the same y, and a selector pinned to an edge lands on its
    neighbours' line at every width. The segmented controls are one height
    whether their buttons carry icons or text (the 26px button floor decides
    both), so the top line is exact. Before this every body centred *all* its
    children, so each selector's height depended on how much else its panel
    held, and the faceplate read as ragged even though each panel was fine alone.
  - **The LFO's pulse-rate hint belongs to the knob zone**, under the RATE knob
    it explains (oscillators.md REQ-pwm-rate-is-clamped). In the bottom zone it
    would push the destination dropdown up off the line whenever `pulse` is
    picked.
  - **The knob zone is the only centring that matters.** `.panelBody` still
    centres, but with the zone at `flex: 1` it has no free space left to
    distribute — so a panel built without `panelZones` would silently fall back
    to the old ragged look; every faceplate panel goes through it.

- **REQ-selectors-never-outgrow-their-panel** — (v10) **No switch on a synth
  panel is ever wider than its panel body.** `panelZones` marks the top and bottom
  controls `.panelEdge`, which is `max-width: 100%`, and where the bodies are
  narrow the segmented switches tighten: less horizontal button padding, the
  `min-width` floor dropped, and the wave icons drawn 2px narrower. The labels
  keep their size and tracking, so a tightened switch is the same switch with
  less air, not smaller type.
  - **Where it applies: 1281–1629px and ≤499px**, the two ranges where a body is
    narrower than a natural-width switch (121–161px on the 8-column faceplate,
    138–158px on a phone). They are viewport ranges, like every other rule in
    this spec, because the faceplate grid fixes a body's width at each viewport
    width. A container query would also work, but the codebase uses none, and the
    sweep below proves the ranges. Everywhere else the switches keep their
    natural padding.
  - **What it fixed.** Measured at natural width, the glide switch (169px)
    spilled past the MIXER panel's border at every 8-column width below ~1520px
    (14px a side at 1281px) and on a 360px phone. At 1281px OSC 2's sync switch
    (141px) and the wave pickers (156px) ran into the panel padding too. Tightening
    alone was not enough for the glide switch: OFF / ALWAYS / LEGATO is still
    ~139px, hence ON (voicing.md REQ-the-glide-switch-reads-on).
  - The LFO destination dropdown is a `.panelEdge` too, but it is full-width by
    construction; the tightening targets the segmented switches' buttons only
    (`:not(.dropdown)`, the dropdown's global bridge class).

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

Every faceplate knob row is built by one helper, `knobRow` in
`src/ui/components/panel.ts`: `.panelRow` plus an optional row-shape class.
(v10: it was a local `row()` in `synth-panels.ts` with a second copy in
`lfo-panel.ts`, and moved beside `panelZones` so the body's shape is composed in
one module.)

```ts
export function knobRow(children: HTMLElement[], shape?: string): HTMLElement {
  const r = document.createElement('div');
  r.className = shape ? `${styles.panelRow!} ${shape}` : styles.panelRow!;
  for (const c of children) r.appendChild(c);
  return r;
}
```

- **SUB / UNI** and **FILTER** each build one row,
  `knobRow([...], styles.quad!)` / `knobRow([...], styles.hex!)`, where they
  once stacked two.
- **AMP ENV** passes `styles.quad!` and **FILTER ENV** `styles.quint!`.
- **OSC 1**, **OSC 2**, **MIXER** (3 knobs) and **LFO** (2 knobs) pass
  `styles.spread!` (REQ-spread-rows-distribute-when-wide). The LFO's is in
  `src/ui/panels/lfo-panel.ts`, not `synth-panels.ts`.

(v10, REQ-selectors-pin-to-the-panel-edges) Every faceplate panel then fills its
body through one builder in `src/ui/components/panel.ts`, beside the panel
shell, so the body's shape is written down once for both the plain panels and
the LFO's tabbed pages:

```ts
export function panelZones(body: HTMLElement, z: PanelZones): void
interface PanelZones { top?: HTMLElement; knobs: HTMLElement[]; bottom?: HTMLElement }
```

It appends `top`, a `.panelKnobs` wrapper holding `knobs`, then `bottom`. The
LFO page passes its knob row **and** the pulse-rate hint as `knobs`.

### Layer touchpoints & ordering

- `src/ui/styles/panel.module.css` — `.quad` layers additively over `.panelRow`
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
  }
  @media (max-width: 1280px) {
    .hex { repeat(3, minmax(0, 1fr)); }
    .quint { repeat(5, minmax(0, 1fr)); }
    .quint > *:last-child { grid-column: auto; }
  }
  /* Last in the file, so at ≤499px it beats the 1280px block on source order. */
  @media (min-width: 1630px) and (max-width: 2560px), (max-width: 499px) {
    .quint { repeat(3, minmax(0, 1fr)); }                             /* dice-five */
    .quint > :nth-child(1) { grid-column: 1; grid-row: 1; }           /* A */
    .quint > :nth-child(2) { grid-column: 3; grid-row: 1; }           /* D */
    .quint > :nth-child(3) { grid-column: 1; grid-row: 2; }           /* S */
    .quint > :nth-child(4) { grid-column: 3; grid-row: 2; }           /* R */
    .quint > *:last-child { grid-column: 2; grid-row: 1 / span 2; }   /* VEL */
  }
  ```

  The spanning VEL is vertically centred by `.quint`'s own `align-items:
  center`; nothing extra is needed. The dice-five block stops at 2560px, so the
  ultrawide block only has to undo the base span on VEL, as the 1280px block
  does.

  `.panelKnobs` (REQ-selectors-pin-to-the-panel-edges) is the knob zone — a
  centring flex column at `flex: 1`, the same 8px gap as `.panelBody`, so the
  spacing between a selector and the knobs is unchanged when the panel has no
  spare height. It is breakpoint-free: the zones hold at every width.
  `.panelEdge` (REQ-selectors-never-outgrow-their-panel) is `max-width: 100%`
  everywhere and tightens its switch's buttons in one block,
  `@media (min-width: 1281px) and (max-width: 1629px), (max-width: 499px)`. It is
  in layer `chrome`, above `segmented.module.css`'s `controls`, so it wins without
  `!important`.
- `src/ui/panels/synth-panels.ts` — seven `panel()` call sites, each a `knobRow`: two `.quad`
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

Scenario: FILTER ENV takes each of its shapes (REQ-quad-panels-use-a-fixed-grid)
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
  And they still share one row at 500px
  When the viewport narrows to 499px, and again at 420px and 360px
  Then they render the dice-five again, VEL centred across and between the rows
  And no corner knob's box reaches into VEL's column
# pinned by: e2e/responsive-panels.spec.ts (the 5-knob FILTER ENV panel takes each
#            of its shapes — dice-five asserted at 360, 420, 499, 1630 and 1920px)

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

Scenario: An ultrawide lays each panel on one even row (REQ-ultrawide-panels-are-one-row)
  Given the app is open at a 2800px-wide viewport
  Then the SUB / UNI, AMP ENV and FILTER ENV knobs each share one row
  And the FILTER knobs still render 3x2
  And the OSC 1 and MIXER knobs are distributed evenly across their panels
  When the viewport widens to 3200px
  Then the six FILTER knobs share one row
  And at 3440px and 5120px every panel's knobs share one row
  When the viewport narrows to 2560px
  Then every panel takes its 1630px shape again
# pinned by: e2e/responsive-panels.spec.ts (an ultrawide lays each panel on one
#            even row — 2560/2800/3199/3200/3440/5120px)

Scenario: OSC WIDTH joins its row on an ultrawide (regression)
  Given OSC 2 is on the square wave, so its WIDTH knob is shown
  When the app is open at a 2800px-wide viewport
  Then OCT, TUNE, LEVEL and WIDTH share one row, spread evenly
  When the viewport narrows to 2560px
  Then WIDTH sits alone on the line below OCT, TUNE and LEVEL, centred
  And on the saw wave the row holds only OCT, TUNE and LEVEL at either width
# Bug: WIDTH was a separate row element, so the ultrawide one-row rule could not
# reach it and it stayed below the others at every width.
# pinned by: e2e/responsive-panels.spec.ts (OSC WIDTH joins its row on an ultrawide)

Scenario: No knob's label ever reaches its neighbour (REQ-a-cell-is-never-narrower-than-a-knob)
  Given the app is open at any width from 360px to 5120px
  Then for every pair of knobs sharing a row in a panel
  And measuring each label's ink as its centre plus/minus scrollWidth/2
  Then the two extents do not overlap
  Except in SUB / UNI below 768px, where the 4-up cell is narrower than its
    six-character labels — the pre-existing collision in "Open questions"
    below, carried in the test as a bounded exception scoped to that one panel
    so it is stated rather than skipped
# pinned by: e2e/responsive-panels.spec.ts (no knob label ever reaches its
#            neighbour)

Scenario: Selectors line up on the panel edges (REQ-selectors-pin-to-the-panel-edges)
  Given the app is open at 1440px, 820px or 400px
  Then the OSC 1, OSC 2, SUB / UNI and LFO wave pickers and FILTER's model switch
    each sit flush with the top of their panel body
  And OSC 2's SYNC, MIXER's glide mode and the LFO destination
    each sit flush with the bottom of their panel body
  And at 1440px, where all eight panels share one row, the five top selectors
    share one top edge and the three bottom controls share one bottom edge
  When LFO 1's destination is set to pulse, so its rate hint shows
  Then the destination dropdown does not move
# pinned by: e2e/responsive-panels.spec.ts (selectors line up on the panel edges)

Scenario: No switch outgrows its panel (REQ-selectors-never-outgrow-their-panel)
  Given the app is open at any width from 360px to 1920px
  Then every wave picker, FILTER's model switch, OSC 2's sync switch and MIXER's
    glide switch is no wider than its panel body
  And the glide switch reads OFF / ON / LEGATO (voicing.md REQ-the-glide-switch-reads-on)
# pinned by: e2e/responsive-panels.spec.ts (no switch outgrows its panel)

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
  360/420/499/500/820/1281/1400/1440/1629/1630/1920/2560px, and 2800/3199/3200/3440/5120px for
  REQ-ultrawide-panels-are-one-row (viewports changed *within* a test:
  each boot is a full AudioContext), plus REQ-a-cell-is-never-narrower-than-a-knob's label-ink sweep and REQ-fx-panels-fit-their-knob-run's
  FX rack sweep at 1360/1440/1600/1920px.
- Typecheck: `npm run typecheck` (confirms `styles.quad` / `.hex` / `.quint` compile).
- Manual (`npm run dev`), device-emulate / resize:
  - **360–499px** (phones): FILTER ENV is the dice-five, its dials clear of each
    other, the panel no taller than the LFO beside it.
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
  fixed `--knob-size + 8px` — 38px at that breakpoint — while a six-character
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
