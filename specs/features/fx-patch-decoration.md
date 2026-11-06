# FX patch decoration (the unpatched cable in the empty effect slot)

```yaml
id: fx-patch-decoration
status: implemented
version: 3
owner: core
related:
  - effects          # the insert effects whose grid leaves the gap
  - sidechain-ducking
  - fx-group         # the other, compact FX header layout
  - responsive-header # the sibling breakpoint-driven UI rule
source:
  - src/ui/components/fx-patch-decoration.ts
  - src/ui/styles/fx-patch-decoration.module.css
  - src/ui/panels/fx-rack.ts             # buildFxRack — imports it on odd panel counts
  - src/ui/styles/fx-rack.module.css     # .fxRow — the grid that leaves the gap
```

Decorative rack scenery for the empty cell an **odd** number of FX panels leaves in
the ≤992 px 2-column grid: an empty bay, lit faintly at the centre and black at the
rim, with a colour-coded loom of patch cables dropping through it and one unused
lead dangling its 1/4" plug.

## Background / Why

**Dormant as shipped.** The rack holds six panels (the phaser, flanger and chorus
share one, [fx-slot-picker](fx-slot-picker.md)), so the grid divides evenly and
nothing is mounted. The component and its unit tests stand, and a seventh panel
brings it back with no change here. Filling a half-empty row with the *back* of a
patch bay says something true: there is room for one more effect. It must never
compete with the controls: near-black, static, and inert.

## Requirements

- **REQ-decoration-occupies-one-grid-cell** — One `.fxRow` cell after the last
  panel, visible **only** in the ≤992 px 2-column layout. It is `display: none`
  in the single-row layout. Its breakpoint mirrors `.fxRow`'s.
- **REQ-decoration-is-parity-keyed** — `buildFxRack` appends it only when
  `fx.childElementCount % 2 === 1`. It is **imported at that mount**, so while the
  count is even it is never fetched. A failed import leaves the cell empty and
  reports nothing ([lazy-load-failure](lazy-load-failure.md)
  REQ-lazy-report-is-the-backstop).
- **REQ-the-decoration-is-inert** — `aria-hidden="true"`, `pointer-events: none`,
  and nothing focusable. No param, state or persistence. Collapsing the FX section
  hides it with the row.
- **REQ-two-layers-undistorted-connector** — The cell's aspect swings ~1.7:1 to
  ~4.7:1, so there are two stacked full-bleed SVGs. The **cables** layer uses
  `preserveAspectRatio="none"` with `vector-effect="non-scaling-stroke"`, so the
  stretch bends curves, never stroke width. The **lead** layer uses `xMidYMin meet`,
  so the plug is never distorted. It is anchored top so the cable enters through
  the edge rather than starting mid-air. Composition is steered by where content
  sits inside the viewBox, never by transforming the layer.
- **REQ-a-lead-left-hanging** — The hero cable drops in through the **top**, takes a
  lazy S and dangles a TS plug near-vertically. There is deliberately **no** jack
  socket: a plug in open air reads as "unpatched", and a socket at this size reads
  as a smudge.
- **REQ-the-decoration-recedes** — Near-black sheaths; the brightest pixel stays at
  or below `--panel-border`. Colours live in the CSS module, and the SVG carries no
  `stroke`/`fill` (the `wave-icons.ts` convention).
- **REQ-the-decoration-is-static-and-cheap** — No animation. Lighting is doubled
  paths (dark sheath + thin sheen), never SVG filters or `drop-shadow`.
- **REQ-the-bay-is-inset-from-its-cell** — A 5 % inset and **no border**, so the
  reveal reads as an empty slot where a front plate would sit. A vignette `::after`
  painted over both layers sinks the loom into the rim. `min-height` stays under
  the row height, so the slot never sets the row's height.
- **REQ-the-loom-drops-from-the-top** — Cables drop from the top and leave through
  the bottom, with a few draping in from the left. None runs to the **right** edge,
  since this is the last bay. The ~55–85 % band is kept clear of *near* cables as
  the hero's lane. A `.far` rank (drawn first, ~44 % opacity, finer, less sway)
  passes behind the plug for depth. Six hues, each nearly black, are set as
  `--wire`/`--wire-lit` classes on each `<g>`, with mixed gauges and slack. Gauges
  thin below 560 px.
- **REQ-sheens-are-centred-not-offset** — A sheen sits **on** its sheath. An offset
  highlight is right for one orientation only, and on a vertical loom it lights the
  whole strand.

## Technical design

```yaml
fx-patch-decoration.ts:
  fxPatchDecoration(): HTMLElement
    # <div data-testid="fx-patch-decoration" aria-hidden="true"> wrapping
    # exactly two inline <svg> layers (cables, lead). No options, no state, no disposer.
fx-rack.ts buildFxRack: after the panels,
  if (fx.childElementCount % 2 === 1) import(fx-patch-decoration).then(append)
fx-rack.module.css: .fxRow's @container viewport (max-width: 992px) rule is the breakpoint mirrored
collapse: inside .fxRow, so .fxSection.collapsed .fxRow { display: none } hides it
```

## Scenarios (BDD)

```gherkin
Scenario: The empty cell is filled on a narrow screen
  Given a 900px-wide viewport with the FX section expanded
   And an ODD number of effect panels
  Then the FX row is 2 columns and the patch decoration is visible
   And it sits on the same row as, and to the right of, the last effect panel
   And it is inset from its cell on every side, with no border of its own
# unpinned: dormant at six panels, so no live surface renders it. The geometry
# assertions live in tests/ui/fx-patch-decoration.test.ts; restore an e2e pin if a
# seventh panel lands.

Scenario: A full row shows no decoration
  Given a 1400px-wide viewport with the FX section expanded
  Then the FX row is one cell per effect and no decoration is rendered
# pinned by: e2e/fx-patch.spec.ts

Scenario: The decoration is inert (edge)
  Given the decoration is rendered
  Then it is aria-hidden, has no focusable descendants and ignores pointer events
# pinned by: tests/ui/fx-patch-decoration.test.ts

Scenario: The hero cable never starts in mid-air (REQ-two-layers-undistorted-connector)
  Given a cell far shorter than the lead layer's aspect ratio
  Then the lead layer is anchored xMidYMin, so its cable is clipped by the
       cell's top edge rather than floating inside a letterbox
# pinned by: tests/ui/fx-patch-decoration.test.ts

Scenario: No cable ends at the right edge (REQ-the-loom-drops-from-the-top)
  Given the last bay in the row has nothing to its right to connect to
  Then every loom run stays within the box horizontally and leaves through the
       top or bottom instead
# pinned by: tests/ui/fx-patch-decoration.test.ts

Scenario: The far rank sits behind the near loom (REQ-the-loom-drops-from-the-top)
  Given the loom is drawn two ranks deep
  Then every .far run precedes the near runs in document order, so it paints
       behind them, and is dimmer and finer
# pinned by: tests/ui/fx-patch-decoration.test.ts

Scenario: An even panel count drops the decoration (REQ-decoration-is-parity-keyed)
  Given the FX row is built with an even number of effect panels
  Then no decoration is appended (the 2-column grid has no gap to fill)
# pinned by: e2e/fx-patch.spec.ts
```

## Tests & verification

- `tests/ui/fx-patch-decoration.test.ts`, `e2e/fx-patch.spec.ts` — `npm test` /
  `npm run e2e`. Visual: `npm run dev`, below 992 px, with an odd panel count.
