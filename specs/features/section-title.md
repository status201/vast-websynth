# Section title (the heading on a full-width faceplate section)

```yaml
id: section-title
status: implemented
version: 4   # v4: a folded section's selected tab dims too — the same yellow burning
             #     low, never the heading's --text-dim; its LED is untouched (REQ-folded-selected-tab-dims)
             # v3: the tabs' smaller type starts at 1030px, not 992px, so the MACHINES icon
             #     cannot push a tab label onto a second line (REQ-compact-drops-text-not-icon)
             # v2: FX and MACHINES get new glyphs (the pedal and step grid did not
             #     read at 14px), and a heading dims while its section is folded (REQ-folded-heading-dims)
owner: ui
related:
  - equalizer        # REQ-9 — the first titled TabContainer
  - machine-status   # the pattern row's tab LEDs, beside which MACHINES now sits;
                     # REQ-folded-selected-tab-dims leaves them exactly as they are
  - iconography      # the three glyphs live in UI_ICONS
  - typography       # the heading is display type (REQ-one-component-draws-every-heading there)
  - ../decisions/adr-014-dont-make-me-think
source:
  - src/ui/components/section-title.ts
  - src/ui/styles/section-title.module.css
  - src/ui/components/tabs.ts          # TabOptions.title renders one
  - src/ui/components/ui-icons.ts      # waveBurst / padMachine / sliders
  - src/ui/app.ts                      # FX bar + the MACHINES row
  - src/ui/panels/eq-panel.ts          # the EQUALIZER row
  - src/ui/styles/layout.module.css    # .fxSectionBar's padding
  - src/ui/styles/tabs.module.css      # REQ-folded-selected-tab-dims: the folded row's selected tab
  - src/styles/theme.css               # REQ-folded-selected-tab-dims: --accent-secondary-dim
```

One heading look for the three full-width sections that fold: **FX**,
**MACHINES** and **EQUALIZER**. Each is a white icon followed by white text, at
the same left inset.

## Background / Why

The three sections grew their headers separately, and it showed. FX had a
hand-built bar with a sans title in the active tab's yellow. The machine-tabs
row (Arpeggiator through Song) had no heading. The Equalizer had a serif title
(first in yellow, then white, [equalizer](equalizer.md) REQ-the-eq-section-is-a-folded-tab-container). Side by side,
the FX title read like a tab, the machine row looked unlabelled, and no two left
edges agreed.

A heading and a tab share the faceplate's serif caps, so colour and a glyph are
the only cues that tell them apart. Yellow belongs to the active tab, so a
yellow heading reads as a control that does nothing when clicked
([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 1).

## Requirements

- **REQ-one-component-draws-every-heading** — **One component draws every
  section heading.** `createSectionTitle({ text, icon, compact? })` returns the
  element; both a `TabContainer` (`TabOptions.title`) and the FX bar (`buildFx`)
  use it. Neither keeps its own title rule, so the three cannot drift apart in
  type, colour or inset.

- **REQ-heading-is-white-and-inert** — **The heading is the faceplate's white,
  undimmed, and inert.**
  - Type: `--serif`, 11 px, uppercase, 0.18em tracking, weight 700, the tabs'
    own legend type ([typography](typography.md) REQ-serif-is-display-type-only, a heading).
  - Colour: `var(--text)` with no `opacity`. No tab state and no other rule in
    the tab stylesheet uses that colour, so white means heading and yellow means
    active tab.
  - `pointer-events: none`: a click lands on the bar, which folds the section,
    exactly as before the heading existed.
  - That colour is the **open** state; a folded section's heading dims (REQ-folded-heading-dims).

- **REQ-heading-is-icon-then-text** — **Icon first, then text, from
  `UI_ICONS`.**
  - The glyph comes from `UI_ICONS` ([iconography](iconography.md) REQ-a-control-glyph-is-inline-svg/REQ-one-icon-builder-four-sets)
    and is `aria-hidden`; the text is the accessible name (REQ-heading-is-icon-then-text there).
  - One glyph per section:

    | Section | Icon | Drawing |
    | --- | --- | --- |
    | FX | `waveBurst` | one burst on a scope: flat in, narrow peaks of different heights, flat out |
    | MACHINES | `padMachine` | a groovebox from above: display and knob, a row of three pads |
    | EQUALIZER | `sliders` | three faders at different heights |

  - The glyph is drawn at **1.27em** of the 11 px heading (about 14 px). Even
    at 14 px a detailed drawing fails, and both v1 glyphs did:
    - a stompbox (body, two knobs, footswitch) had its knobs and footswitch
      merge into a speaker grille;
    - a step grid mixing lit squares with unlit dots read as noise.
  - v2 uses shapes with one idea each:
    - The **wave burst** is one sound event as a scope draws it: a flat line
      in, a run of narrow peaks at different heights, a flat line out. It is
      traced from a reference drawing the user supplied, then made taller, with
      narrower peaks, so they keep about 1 px apart at 14 px. The flat lead-in and
      lead-out are what keep it distinct from the oscillator waveforms
      (`wave-icons.ts`), which are periodic edge to edge. Its path to here:
      - a stompbox, rejected above;
      - a hard-clipped sine, which read as a plain sine with smooth shoulders
        and as a squared-off "N" with hard ones;
      - a sine with a small spike, which the user rejected in every placement.
    - The **pad machine** is the silhouette of a drum machine, the thing the row
      holds, rather than a pattern inside one. It is **landscape**: an upright
      box with a display over 2×2 pads read as a calculator.
  - Both were chosen from a side-by-side render of candidates at the heading's
    real size and colour, at 1× and 3×. Redraw them the same way, not by
    reasoning about coordinates.

- **REQ-heading-icons-share-one-x** — **Every heading's icon sits on the same
  x.**
  - The heading carries its own padding (`8px 14px 8px 10px`), and both bars give
    it the same left padding: `.bar` (tabs) is `0 10px 0 6px`, and
    `.fxSectionBar` now matches it exactly.
  - The same vertical padding means the FX bar and the two tab bars share a
    height too.
  - The sections themselves share one outer margin, `var(--side-margin)`.
    `.fxSection` had a literal `22px` from before the token existed. That equals
    the token at desktop widths, but the token drops to 8 px at ≤992 px, which
    left the FX icon 14 px right of the other two on tablets and phones
    (measured: x = 47 vs 33 at 900 px).
  - Pinned in e2e at 1400 px and 900 px: the three icons' left edges agree
    within 1 px.

- **REQ-compact-drops-text-not-icon** — **`compact` drops the text, not the
  icon, at ≤1140 px.** The pattern row passes `compact: true`, because it cannot
  fit a title:
  - Its seven tabs and fold caret need about 911 px (measured 2026-09-14,
    Chromium, Windows).
  - A full heading adds 113 px of text (the measured EQUALIZER title width) plus
    the icon and gap, about 1057 px in all.
  - That fits at a 1140 px viewport (1070 px of bar, 13 px spare) and not at
    1080 px (1010 px).
  - So the text hides from **1140 px down**. 1140 is a step already in the
    documented 1280 → 1140 → 992 cascade, and at exactly 1140 the 13 px margin
    is too thin to trust across font fallbacks.

  The text is **visually hidden**, not `display: none`, so the heading keeps its
  accessible name. FX and EQUALIZER have room at every width and do not opt in.

  (v3) **The icon alone still costs ~30 px, so the tabs' smaller type starts at
  1030 px** (`tabs.module.css`; it was 992 px, and the bar's wrap rule stays
  there).
  - At full size the row needs ~957 px of bar, and a label wrapped onto a second
    line (42 px tabs instead of 30 px) across **993–1027 px**, measured
    2026-09-14, Chromium, Windows.
  - About 4 px of that band already wrapped before the heading existed.
  - 1030 covers the whole band. Just above it, at 1031 px, the full-size row has
    only 4 px to spare, so a platform whose serif runs wider may still wrap a
    few pixels above 1030. That is the place to look first if one does.

- **REQ-folded-heading-dims** (v2) — **A heading dims to `--text-dim` while its
  section is folded.** Open is `--text`; folded is `--text-dim`, icon included,
  since it draws in `currentColor`.
  - It says at a glance which sections are open without reading the caret.
  - It stays clear of the tab colours: `--text-dim` is not a tab state either, so
    REQ-heading-is-white-and-inert's white-means-heading distinction holds in both states.
  - The rule is `:global(.collapsed) > :first-child > .root`:
    - `createCollapseToggle` puts the global `.collapsed` class on the section
      itself (`TabContainer.el`, or `.fxSection` for FX);
    - in both, the bar is that element's first child and the heading is the
      bar's first child;
    - so the child combinators reach exactly the folded section's own heading,
      never one that is merely somewhere under an unrelated `.collapsed`
      ancestor.
  - There is no transition: a fold is a one-off state change, and the tab colours
    beside it don't animate either.

- **REQ-folded-selected-tab-dims** (v4) — **A folded section's selected tab dims
  as well.** Folding dimmed the heading (REQ-folded-heading-dims) but left the
  selected tab in the bright yellow, glow and underline that mean *this page is
  on screen* — a promise a folded row cannot keep. The tab is still selected
  (unfolding shows that page, and a tab click unfolds straight to it), so it
  keeps the selected *hue* and loses only the brightness:
  - **text** `--accent-secondary-dim` — the active yellow burning low — with **no
    glow**, and the **underline** dimmed to match;
  - **not `--text-dim`**: that is the heading's dim, and REQ-folded-heading-dims keeps it out of
    every tab state, because colour is all that tells an icon-less tab from a
    heading. A dim *yellow* is still unmistakably a tab, and still brighter than
    its unselected siblings in `--text-faint`, so "selected, but hidden" reads at
    a glance;
  - it is the vocabulary the tab **LEDs** already speak: their half-lit state is
    the same red burning low ([machine-status](machine-status.md) REQ-a-machine-has-three-states). Those
    LEDs are **untouched** by a fold — no rule reaches `.led` — because they
    report the machine, not the view, and a folded row is exactly where that
    report is still wanted;
  - the rule is `.root:global(.collapsed) > .bar > .tab:global(.active)`: child
    combinators, for the reason REQ-folded-heading-dims gives, so only the folded row's own tabs
    dim;
  - no transition, as REQ-folded-heading-dims.

## Technical design

### Contract / public interface

```yaml
# src/ui/components/section-title.ts
SectionTitleOptions:
  text: string        # title-case in source; CSS uppercases it
  icon: IconName      # a UI_ICONS key
  compact?: boolean   # REQ-compact-drops-text-not-icon — text visually hidden at <=1140px
createSectionTitle(opts): HTMLElement   # <span class=root [compact]><svg/><span class=icon-label/></span>

# src/ui/components/tabs.ts
TabOptions.title?: SectionTitleOptions  # was `string` (equalizer.md REQ-the-eq-section-is-a-folded-tab-container)
```

### Layer touchpoints & ordering

```yaml
section-title.ts -> ui-icons.ts iconTextEl   # icon + .icon-label, text stays a text node
tabs.ts          -> first child of .bar      # before any tab; the caret stays last
app.ts buildFx   -> first child of .fxSectionBar, before the collapse toggle
```

## Gesture inventory (ADR-014)

| Gesture | Target | Outcome |
| --- | --- | --- |
| tap | the heading | **Nothing of its own.** The heading is inert; the tap lands on the bar, which folds or unfolds the section, as it did before. |

## Scenarios (BDD)

```gherkin
Scenario: A heading is an icon followed by its text (REQ-one-component-draws-every-heading, REQ-heading-is-icon-then-text)
  Given createSectionTitle with text "Equalizer" and icon "sliders"
  Then its first child is an aria-hidden svg.ui-icon and its text is "Equalizer"
# pinned by: tests/ui/section-title.test.ts

Scenario: The heading is white, undimmed, and no tab borrows the colour (REQ-heading-is-white-and-inert)
  Given the section-title and tab stylesheets
  Then .root is coloured var(--text) with no opacity
  And no rule in tabs.module.css is coloured var(--text)
# pinned by: tests/ui/section-title.test.ts

Scenario: Compact keeps the text for assistive tech (REQ-compact-drops-text-not-icon)
  Given a compact heading
  Then it carries the compact class and its text is still in the DOM
  And the stylesheet hides it without display:none
# pinned by: tests/ui/section-title.test.ts

Scenario: The three sections carry their headings (REQ-one-component-draws-every-heading, REQ-heading-is-icon-then-text, REQ-compact-drops-text-not-icon)
  Given the app is loaded
  Then the FX bar reads FX with the wave burst, the pattern row MACHINES with the pad
    machine (compact), and the equalizer EQUALIZER with the sliders
# pinned by: e2e/equalizer.spec.ts

Scenario: The icons line up and the bars match (REQ-heading-icons-share-one-x)
  Given a 1400px-wide viewport, and again a 900px one
  Then the three heading icons' left edges agree within 1px
  And at 1400px the FX bar, the pattern row's bar and the equalizer's bar are the same height within 1px
# pinned by: e2e/equalizer.spec.ts

Scenario: A folded section's heading dims, and brightens when opened (REQ-folded-heading-dims)
  Given the equalizer, which ships folded
  Then its heading's computed colour is --text-dim
  When the section is unfolded
  Then its heading's colour is --text
  And the FX heading follows its own fold the same way
# pinned by: tests/ui/section-title.test.ts, e2e/equalizer.spec.ts

Scenario: A folded section's selected tab dims, its LED does not (v4, REQ-folded-selected-tab-dims)
  Given the pattern row is open with a machine tab selected
  When the row is folded
  Then that tab's text is --accent-secondary-dim, with no glow
  And no tab rule uses the heading's --text-dim
  And every tab LED keeps the colour it had before the fold
  When the row is unfolded
  Then the tab is --accent-secondary again
# pinned by: tests/ui/section-title.test.ts, e2e/equalizer.spec.ts

Scenario: No machine tab wraps its label just above the 992px step (v3, REQ-compact-drops-text-not-icon)
  Given a 1010px-wide viewport, inside the band that used to wrap
  Then every machine tab is one line tall, the same height as the equalizer's tabs
  And the tabs use the smaller type, while at 1080px they use the full size
# pinned by: e2e/equalizer.spec.ts

Scenario: MACHINES shows its word only where it fits (REQ-compact-drops-text-not-icon)
  Given a 1280px-wide viewport
  Then the MACHINES text is visible and the pattern row's bar does not overflow
  When the viewport is 1140px wide
  Then the MACHINES text is visually hidden and the icon remains
# pinned by: e2e/equalizer.spec.ts
```

## Tests & verification

- Unit: `tests/ui/section-title.test.ts`, `tests/ui/eq-panel.test.ts`,
  `tests/ui/typography.test.ts` (the allowlisted serif selector),
  `tests/ui/iconography.test.ts` (the three glyphs).
- E2E: `e2e/equalizer.spec.ts`.
- By eye, which is what signs this off: screenshots of the three bars at 1400 px
  and at 1140 px.
