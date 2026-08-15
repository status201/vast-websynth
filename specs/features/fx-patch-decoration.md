# FX patch decoration (the unpatched cable in the empty effect slot)

```yaml
id: fx-patch-decoration
status: implemented
version: 2   # v2: DORMANT. sidechain-ducking made the effect count six, so REQ-2's
             #     parity guard appends nothing. Anticipated by v1's open question,
             #     not a regression — a seventh effect restores it with no change.
owner: core
related:
  - effects          # the insert effects whose grid leaves the gap
  - sidechain-ducking # v2: the sixth panel that closed the gap
  - fx-group         # the other, compact FX header layout
  - responsive-header # the sibling breakpoint-driven UI rule
source:
  - src/ui/components/fx-patch-decoration.ts
  - src/ui/styles/fx-patch-decoration.module.css
  - src/ui/app.ts                       # buildFx — appends it on odd panel counts
  - src/ui/styles/layout.module.css     # .fxRow — the grid that leaves the gap
```

Purely decorative rack scenery that fills the empty cell the FX grid leaves on
narrow screens: an empty bay — faintly lit at the centre, falling to black at
the rim — with a colour-coded loom of patch cables dropping through it from the
rack above, and one unused lead dangling its 1/4" plug in mid-air.

## Background / Why

> **(v2) Dormant as shipped.** The FX section now holds **six** panels — a
> ducker joined the chain ([sidechain-ducking](sidechain-ducking.md) REQ-10) — so
> the grid divides evenly at both widths and REQ-2's parity guard appends
> nothing. The component and its unit tests are untouched and still cover
> REQ-3..REQ-10; only the mounting stopped. The section below describes the
> five-panel arrangement it was built for, kept because it is the condition the
> decoration returns under.

The FX section held **five** effect panels (distortion · wah · phaser · delay ·
reverb) in `.fxRow`, a grid of `repeat(5, …)` columns that drops to
`repeat(2, 1fr)` below 992px. Five items in two columns leave the last row
half-empty — a conspicuous hole next to Reverb in an otherwise dense rack.
Widening Reverb to span the row would break the panel rhythm; leaving the hole
looks unfinished. Filling it with the *back* of a patch bay turns the gap into
scenery that also says something true: there is room for one more effect here.

It must never compete with the controls, so it is drawn almost entirely in
near-black with heavily damped sheens, is fully static, and is inert to input
and to assistive tech.

## Requirements

- **REQ-1** (where) — The decoration occupies one `.fxRow` grid cell, appended
  after the last effect panel, and is visible **only** in the ≤992px 2-column
  layout — the only layout that leaves a gap. In the single-row desktop layout it
  is `display: none` (the row is full; one more child would wrap to a new row).
  The visibility breakpoint mirrors `.fxRow`'s in `layout.module.css`.
- **REQ-2** (parity-keyed) — `buildFx` appends it only when the panel count is
  **odd** (`fx.childElementCount % 2 === 1`), so adding a sixth effect drops the
  decoration automatically instead of pushing it onto a row of its own.
- **REQ-3** (inert) — `aria-hidden="true"`, `pointer-events: none`, and no
  focusable or interactive descendants. It carries no param, no state and no
  persistence; collapsing the FX section hides it with the row.
- **REQ-4** (two layers, undistorted connector) — The empty cell's aspect ratio
  swings from ~1.7:1 (390px phone) to ~4.7:1 (992px), so a single SVG cannot
  both reach the cell edges and keep the connector round. Two stacked,
  absolutely-positioned full-bleed SVGs solve it:
  - **cables layer** — `preserveAspectRatio="none"` over a `0 0 100 100`
    viewBox, every path `vector-effect="non-scaling-stroke"`: the stretch bends
    the *curves* (natural for slack cable) but never the stroke width. Its runs
    enter and leave through the cell edges so they read as continuing behind the
    rack, cross each other and include one loose coil.
  - **lead layer** — `preserveAspectRatio="xMidYMin meet"` over a `0 0 210 120`
    viewBox: aspect preserved so the plug is never distorted, but anchored
    **top**, because a centred `meet` letterboxes on a short cell and the hero
    cable then visibly begins in mid-air instead of entering through the edge.
    The drawing sits in the **right** half of that viewBox and stops well above
    its foot, so after `xMid` centring the plug hangs off-centre and clear of
    the bay's bottom rim. Composition is therefore steered by where the content
    sits *inside* the viewBox — never by nudging the layer with a transform,
    which would push it out of the bay on a narrow cell.
- **REQ-5** (a lead left hanging, nothing to plug into) — The hero cable drops in
  through the **top** edge, takes a lazy S under its own weight and dangles a TS
  plug (boot, barrel, knurl, collar, sleeve, ring groove, tip) near-vertically at
  the end — an unused lead hanging from the rack above. It hangs rather than
  lies: gravity makes the pose self-explanatory, where a cable snaking in from
  the side needed a knot to look slack and the knot never read as cable. There is
  deliberately **no** jack socket either: an empty bay plus a plug dangling in
  open air reads as "unpatched" on its own, and a drawn socket at this size read
  as a smudge.
- **REQ-6** (recedes) — Near-black sheaths; the brightest pixel stays at or
  below `--panel-border` so the decoration never out-contrasts a real panel.
  Colours live in the CSS module — the SVG markup carries no `stroke`/`fill`
  attributes (the `wave-icons.ts` / `header-icons.ts` / `rest-glyph.ts`
  convention).
- **REQ-7** (static + cheap) — No animation, so nothing needs gating behind
  `prefers-reduced-motion`. Lighting is doubled paths (a wide dark sheath plus a
  thin low-opacity sheen), **not** SVG filters or `drop-shadow`, keeping paint
  cost trivial.
- **REQ-8** (the empty slot) — The bay is **inset from its grid cell** by a 5%
  margin and has **no border**. The inset is the whole trick: the reveal of
  background around it reads as the space a module's front plate would cover, so
  the cell becomes a visibly *empty slot* rather than a panel that happens to
  contain a drawing. A border would undo that by outlining it as an object
  again — the slot is defined only by its recessed face, lit faintly at the
  centre and falling to black at the rim, plus a vignette painted **over** both
  SVG layers (`::after`, generated last) so the loom sinks into the dark at the
  edges instead of being cut off by `overflow: hidden`. Percentage margins
  resolve against the cell's width on all four sides, so the reveal stays square
  as the bay grows; `min-height` is kept well under the row height so the slot
  can never drive how tall the FX row is.
- **REQ-9** (the loom) — The background cables **drop from the top and leave
  through the bottom**, plus a few draping in from the panel on the left. None
  runs to or ends at the **right** edge: this is the last bay in the row, so
  there is nothing over there to connect to and a cable stopping at that edge
  reads as a cut-off drawing. The ~55–85% band is left clear of *near* cables as
  the lane the hero lead hangs in — a near strand crossing the plug reads as if
  it were patched into it.
  The loom is two ranks deep. A `.far` rank of ten runs is drawn **first** (so
  it paints behind), at ~44% opacity and a finer gauge, with less sway —
  distance dims a cable, thins it and flattens its slack. Only the near rank
  respects the hero's lane; the far rank passes behind the plug, which is what
  sells the depth. The curtain fades further on phones, where ten runs compress
  into a narrow bay and would otherwise read as stripes rather than distance.
  Real bays are colour-coded, so the loom is too: six hues (brown, red, blue,
  green, amber, violet), each taken down to near-black with its sheen the only
  trace of the actual colour. A hue is a class setting `--wire`/`--wire-lit` on
  the cable's `<g>` (the inline-custom-prop pattern `StepButton` uses), so one
  pair of stroke rules serves every wire. Gauges and slack are mixed (a `.thin`
  modifier; some strands hang taut, some sway wide) so the loom never reads as a
  repeating pattern, and every gauge thins again below 560px — the strokes are
  non-scaling, so on a phone-sized bay full-gauge cable reads as spaghetti.
- **REQ-10** (sheens are centred, not offset) — A cable's sheen is drawn
  **on** its sheath, not offset from it. An offset "specular" is only correct
  for one cable orientation: with the loom running vertically a `translateY`
  highlight lies along each strand's whole length instead of beside it and
  lights the bundle up. A round cable reads fine as a lit core.

## Technical design

### Contract / public interface

```yaml
fx-patch-decoration.ts:
  fxPatchDecoration(): HTMLElement
    # <div data-testid="fx-patch-decoration" aria-hidden="true"> wrapping
    # exactly two inline <svg> layers (cables, lead). No options, no state,
    # no disposer — build it and append it.
testids: fx-patch-decoration
```

### Layer touchpoints & ordering

```yaml
app.ts buildFx: five fxPanel(...) appends, then
  if (fx.childElementCount % 2 === 1) fx.appendChild(fxPatchDecoration());
  # must run AFTER the panels (it counts them) and BEFORE section.appendChild(fx)
layout.module.css: .fxRow's @media (max-width: 992px) 2-column rule is the
  breakpoint the component's module mirrors; a comment links the two.
collapse: the decoration sits inside .fxRow, so
  .fxSection.collapsed .fxRow { display: none } hides it for free.
```

### Persistence

None. Not a `ParamBus` param, not in presets/songs, no localStorage key —
purely presentational.

## Visual aids

```
   .fxRow cell (≤992px, right of REVERB) — the slot is inset inside it
 ┌────────────────────────────────────────────────────────────┐
 │        ← 5% reveal: where a front plate would sit →         │
 │   ╭──────────────────────────────────────────────────╮     │
 │   │┊│┊ │ ┊│ ┊ │ ┊  ╭╯ ┊   ┊  │ ┊ │ ┊  ┊│ ┊ │ ┊       │     │
 │   │╲│┊ │ ┊│ ┊ │ ┊  │  ← hero lead   │ ┊ ┊ │┊        │     │
 │   │ ╲ ┊│ ┊│ ┊ │ ┊ ╭╯  ┊   ┊  │ ┊ │ ┊  ┊│ ┊ │┊       │     │
 │   │  ╲│┊ ┊│ ┊ │ ┊ ▐▓▌ ← plug hangs, high and right   │     │
 │   │ drapes ↙ ·· centre lit, rim dark, no border ··   │     │
 │   ╰──────────────────────────↓↓↓─────────────────────╯     │
 └────────────────────────────────────────────────────────────┘
    │ = near loom      ┊ = far rank (dimmer, finer, behind)
   lead anchored xMidYMin, so its cable enters through the top edge
```

## Scenarios (BDD)

```gherkin
Scenario: The empty cell is filled on a narrow screen
  Given a 900px-wide viewport with the FX section expanded
   And an ODD number of effect panels
  Then the FX row is 2 columns and the patch decoration is visible
   And it sits on the same row as, and to the right of, the last effect panel
   And it is inset from its cell on every side, with no border of its own
# unpinned (v2): dormant at six panels, so no live surface renders it. The
# geometry assertions moved to tests/ui/fx-patch-decoration.test.ts; restore the
# e2e pin if a seventh effect lands.

Scenario: A full row shows no decoration
  Given a 1400px-wide viewport with the FX section expanded
  Then the FX row is one cell per effect and no decoration is rendered
# pinned by: e2e/fx-patch.spec.ts

Scenario: The decoration is inert (edge)
  Given the decoration is rendered
  Then it is aria-hidden, has no focusable descendants and ignores pointer events
# pinned by: tests/ui/fx-patch-decoration.test.ts

Scenario: The hero cable never starts in mid-air (REQ-4)
  Given a cell far shorter than the lead layer's aspect ratio
  Then the lead layer is anchored xMidYMin, so its cable is clipped by the
       cell's top edge rather than floating inside a letterbox
# pinned by: tests/ui/fx-patch-decoration.test.ts

Scenario: No cable ends at the right edge (REQ-9)
  Given the last bay in the row has nothing to its right to connect to
  Then every loom run stays within the box horizontally and leaves through the
       top or bottom instead
# pinned by: tests/ui/fx-patch-decoration.test.ts

Scenario: The far rank sits behind the near loom (REQ-9)
  Given the loom is drawn two ranks deep
  Then every .far run precedes the near runs in document order, so it paints
       behind them, and is dimmer and finer
# pinned by: tests/ui/fx-patch-decoration.test.ts

Scenario: A sixth effect drops the decoration (edge, REQ-2)
  Given the FX row is built with an even number of effect panels
  Then no decoration is appended (the 2-column grid has no gap to fill)
# pinned by: e2e/fx-patch.spec.ts  (v2: this is now the shipped state, not an edge)
```

## Tests & verification

- Unit: `tests/ui/fx-patch-decoration.test.ts` — `npm test`
- E2E: `e2e/fx-patch.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Visual: `npm run dev`, narrow the window below 992px and expand FX.

## Open questions / future

- **(v2) This happened.** [sidechain-ducking](sidechain-ducking.md) made the count
  six and REQ-2 dropped the decoration, exactly as v1 predicted. A *seventh*
  effect brings it back in the new gap with no change here. The trade was
  accepted deliberately: a working effect earns a rack cell ahead of scenery
  whose whole job was to admit "there is room for one more effect here" — which
  is now filled rather than admitted.
