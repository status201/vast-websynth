# Responsive machine header (pattern panel control row)

```yaml
id: responsive-machine-header
status: implemented
version: 3   # v3: .laneControls joins .fxCluster as a wrapped header cluster (REQ-8)
             # v2: the wide row's fit is font-metric-dependent, so REQ-4 is pinned from computed style
owner: ui
related:
  - responsive-header
  - fx-group
  - drum-machine
  - sampler
  - banks
  - step-grid-editing
source:
  - src/ui/styles/layout.module.css   # .patternPanelHeader wrap + .fxCluster
  - src/ui/panels/sampler-panel.ts    # DIST / PHASER / DELAY / REVERB cluster
  - src/ui/panels/drum-panel.ts       # COMP (+GR meter) / PHASER / DELAY / REVERB cluster
```

## Background / Why

Every machine tab (Sequencer / Drum Machine / Sampler / Motion) opens with a
control row — `.patternPanelHeader` — holding the machine on/off switch, its
MASTER knob, the `BankBar` (FOLLOW · A B C D · COPY), the undo button, any
per-machine action (e.g. the Sampler's "Record a sound") and, on the Drum and
Sampler tabs, the inline [fx-group](fx-group.md) effect groups.

The rule was `display: flex; align-items: center; gap: 12px` with **no**
`flex-wrap` and no `min-width: 0`. Flex children bottom out at min-content (and
the Sampler's `.rec`/`.load`/`.edit` are explicitly `flex-shrink: 0`), so the
row's min-content width won and the row overflowed its panel. Since
`tabs.module.css` `.content` is already an `overflow: auto` container, that
overflow dragged a horizontal scrollbar across the **whole panel** — the step
grid scrolled sideways with the header.

The Sampler row's min-content budget at desktop `--knob-size: 44px` is roughly
560 px of machine controls plus 190–220 px per **expanded** fx group: about
950 px with every effect bypassed, but **1450 px+** with all four engaged. The
clipping therefore appeared to come and go with the effect switches, because
`fxGroup` only reveals its knobs once `<prefix>.on >= 0.5` ([fx-group](fx-group.md)
REQ-2).

That machine-controls figure is a **budget, not a constant**, and it has since
grown: [step-grid-editing](step-grid-editing.md) REQ-6 added a `Clear ▾` control
to every machine header, ~82 px including its gap. At a 1280 px viewport the
sampler's panel is ~1186 px wide and the bypassed row measures ~1129 px — about
57 px of slack under Windows font metrics, and none under the wider default fonts
on Linux CI, where the cluster then wraps. That wrap is **correct** behaviour
(REQ-1), which is why REQ-4 is pinned from computed style rather than from
whether the row happens to fit at any one width. Anything else added to this row
should be measured against that ~57 px, not assumed free.

This row was the last non-wrapping control row in the app — `panelRow`,
`djFx`, `fxKnobs`, `tabs.bar`, `step-settings.edit` and the rest all already
wrap. The fix adopts the same idiom, plus the deterministic line-break trick
from [responsive-header](responsive-header.md) REQ-9 so the break lands
somewhere predictable rather than mid-cluster.

## Requirements

- **REQ-1** — `.patternPanelHeader` wraps (`flex-wrap: wrap`) at **every**
  width. The row must never clip content or force a horizontal scrollbar on its
  panel, at any viewport size or any combination of engaged effects. The wrap is
  deliberately *not* gated behind a media query: with all four effects engaged
  the row exceeds even a 1280 px panel, so a breakpoint-only rule would still
  clip on a wide screen.
- **REQ-2** — The effect groups of a machine are wrapped in a single
  **`.fxCluster`** container, so the row has two structural units: the machine
  controls (direct children, as before) and the FX cluster (one child). Panels
  with no effect groups (Sequencer, Motion, Arpeggiator) have no `.fxCluster`
  and are unchanged apart from REQ-1.
- **REQ-3** — From **≤1140px** — the existing wrap step of the documented
  1280 → 1140 → 992 → 720 cascade — `.fxCluster` takes `flex-basis: 100%`, so
  it leads its **own** full-width row. The machine controls keep the row(s)
  above and never reflow around individual fx groups.
- **REQ-4** — Above 1140px the layout is **visually identical to before**: the
  cluster is a plain content-sized run in the same DOM order (computed
  `flex-basis: auto`, never REQ-3's `100%`), with the same 12 px gap, and is
  *not* right-aligned (no `margin-left: auto`). The only observable difference at
  wide widths is that an over-long row now wraps instead of clipping (REQ-1).
  Sharing a row with the machine controls is a *consequence* of being
  content-sized, **not a guarantee at any particular width** — see the budget
  note above. The pin therefore reads the two properties directly at 1280 px and
  checks row membership only where there is headroom to spare.
- **REQ-5** — `.fxCluster` itself wraps internally (`flex-wrap: wrap`,
  `min-width: 0`), so once it owns a row its groups tile onto as many lines as
  needed rather than overflowing that row.
- **REQ-8** (v3) — **`.laneControls` is the header's second cluster.** The
  Chain / Mute / Solo trio ([machine-status](machine-status.md) REQ-9) is wrapped
  the same way `.fxCluster` is and for the same reason: the row's wrap points
  belong *between* groups, not through the middle of one, so the three never split
  across lines while space remains. It sits directly after the machine switch, is
  content-sized at every width (no `flex-basis: 100%` step — it is short), and
  wraps internally as a last resort. This consumes header slack, which REQ-4's
  budget note already warns is thin: ~57 px in the sampler header at 1280 px. The
  row wrapping (REQ-1) absorbs it — that is exactly what REQ-1 exists for — so a
  narrower fit is expected and correct, not a regression.
- **REQ-6** — Every `fxgroup-<prefix>` root stays rendered and non-zero-size at
  all widths. Nothing is `display: none`d. This is load-bearing:
  [fx-group](fx-group.md) REQ-5 anchors help badges to the group root precisely
  so help stays reachable for a *bypassed* effect, and InfoBadges hides badges on
  zero-size anchors.
- **REQ-7** — Existing testids and DOM identities are preserved. The
  `fxGroup(...)` calls, their arguments and their `fxgroup-<prefix>` testids are
  untouched; only their parent element changes. `bank-<lane>-*`,
  `sampler-record` and `seq-step-input` are unaffected. (`motion-view-x|y` has
  since moved out of the machine header into the Motion tab's own XY-lane row —
  see [motion-sequencer](motion-sequencer.md) REQ-8 — so this rule no longer
  covers it.)

## Technical design

### Contract / public interface

No new module and no new component — a wrapper `div` plus three CSS rules.

```css
.patternPanelHeader {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;        /* REQ-1 */
}

.fxCluster {              /* REQ-2 / REQ-5 */
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}

@media (max-width: 1140px) {
  .fxCluster { flex-basis: 100%; }   /* REQ-3 */
}
```

Panel side (Drum + Sampler only):

```ts
const fx = document.createElement('div');
fx.className = layout.fxCluster!;
fx.appendChild(fxGroup(bus, 'DIST', 'fx.sampler.dist', [ … ]));
// … PHASER / DELAY / REVERB
header.appendChild(fx);
```

### Layer touchpoints & ordering

- `src/ui/styles/layout.module.css` — `flex-wrap` added to
  `.patternPanelHeader` (~line 54); new `.fxCluster` rule beside it; the
  `flex-basis: 100%` line goes in the **existing** `@media (max-width: 1140px)`
  block, preserving the file's fixed breakpoint cascade order
  1280 → 1140 → 992 → 720.
- `src/ui/panels/sampler-panel.ts` — the four `fxGroup` calls move from
  `header.appendChild(...)` into the cluster div.
- `src/ui/panels/drum-panel.ts` — same for COMP (with its `GrMeter` trailing
  element) / PHASER / DELAY / REVERB.
- No JS change to `seq-panel.ts`, `motion-panel.ts` or `arp-panel.ts`.
- No change to `step-panel-scaffold.ts`: it shares lane plumbing
  (`bankBarFor`, `wrapGridWithRestOverlay`, `wirePlayhead`, `GridCursor`) and
  deliberately holds no header/layout code. A shared header builder would be a
  new concern for that module; with the fix being one wrapper div, it is not
  yet worth the abstraction.

### Why not the alternatives

- **Collapse the FX behind a disclosure button** (`createCollapseToggle`, the
  persisted `.collapsed` idiom) would save the vertical space, but it hides the
  knobs of effects the user has deliberately switched **on**, and zero-sizes the
  fx-group help anchors REQ-6 must preserve.
- **A horizontal scroll strip** on the cluster keeps the row single-line, but no
  such component exists in `src/ui/components/`, it fights `base.css`'s
  `touch-action: pan-y` for touch drag, and it makes off-screen knobs
  undiscoverable.

### Persistence

**None.** Pure CSS layout reacting to viewport width — nothing is stored, and
no `ParamBus` param or `SongFile` field is involved.

## Visual aids

```
 WIDE (>1140px) — unchanged, one row:
┌──────────────────────────────────────────────────────┐
│ [SAMPLER] (M) [FOLLOW][A B C D][COPY] [UNDO] [Rec]   │
│                    │DIST ●  │PHASER ● ○ ○ ○ ○        │
└──────────────────────────────────────────────────────┘

 NARROW (≤1140px) — deterministic two units:
┌────────────────────────────────────┐
│ [SAMPLER] (M) [FOLLOW][A B C D]    │  machine controls
│ [COPY] [UNDO] [Record a sound]     │  (wrap among themselves)
├────────────────────────────────────┤
│ │DIST ● ○ ○ ○   │PHASER ● ○ ○ ○ ○  │  .fxCluster, flex-basis:100%
│ │DELAY ●        │REVERB ●          │  (wraps internally)
└────────────────────────────────────┘
```

## Scenarios (BDD)

```gherkin
Scenario: The machine header never overflows its panel
  Given the app is open at a 1024px-wide viewport
  And the Sampler tab is selected
  When all four sampler effects are switched on
  Then the pattern panel does not scroll horizontally
  And all four fxgroup roots are visible with a non-zero size
# pinned by: e2e/machine-header.spec.ts

Scenario: FX take their own row below the wrap step
  Given the app is open at a 1024px-wide viewport
  And the Sampler tab is selected
  Then the FX cluster computes flex-basis 100%
  And it starts below the machine on/off switch
  And the machine controls share no row with any effect group
# pinned by: e2e/machine-header.spec.ts

Scenario: Wide layout is unchanged
  Given the app is open at a 1280px-wide viewport
  And the Sampler tab is selected
  Then the FX cluster computes flex-basis auto and is not right-aligned
  And the panel does not scroll horizontally
# pinned by: e2e/machine-header.spec.ts

Scenario: With headroom, the FX cluster shares the machine controls' row (edge)
  Given the app is open at a 1600px-wide viewport
  And the Sampler tab is selected with every effect bypassed
  Then the machine switch and the DIST group sit on the same row
  # Deliberately not asserted at 1280px: the bypassed row leaves only ~57px of
  # slack there, so wider font metrics legitimately wrap it (REQ-1).
# pinned by: e2e/machine-header.spec.ts

Scenario: A bypassed effect still anchors its help badge (regression)
  Given fx.sampler.reverb.on is 0 (the default)
  And the header has wrapped onto two rows
  Then the fxgroup-fx.sampler.reverb root still has a non-zero size
# pinned by: e2e/machine-header.spec.ts; contract in fx-group.md REQ-5
```

## Tests & verification

- E2E: `e2e/machine-header.spec.ts` — the no-overflow assertion follows the
  `scrollWidth` vs `clientWidth` pattern already used in
  `e2e/responsive-header.spec.ts`; row membership is asserted from
  `getBoundingClientRect()` tops.
- Existing E2E that must stay green: `e2e/compressor.spec.ts` (drum COMP
  `fxgroup-*` locators + GR meter), `e2e/sampler.spec.ts`.
- Typecheck: `npm run typecheck`.
- Manual: dev server, resize across 1140px on the Drum and Sampler tabs with
  effects both engaged and bypassed; confirm the machine controls never move and
  the step grid stays usable against `.patternRow`'s 240px/200px min-height.

## Open questions / future

- If a third panel grows effect groups, the cluster div is worth hoisting into a
  small shared helper (or into `step-panel-scaffold.ts`, accepting that it would
  gain a layout concern).
- The FX knob size is hardcoded in JS (`fxGroup` `opts.knobSize`, default 22). A
  CSS custom property shrinking at breakpoints — the `--knob-size` 44→40→36
  idiom — would let the cluster stay single-row a little longer before wrapping.
