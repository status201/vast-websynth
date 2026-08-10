# Panel tabs — pages inside a faceplate panel

```yaml
id: panel-tabs
status: implemented
version: 2
owner: core
related:
  - architecture
  - testids                    # owns the ptab-/ppage- namespace rule
  - typography                 # the no-new-serif-module constraint (REQ-4)
  - responsive-synth-panels    # why the strip must fit an 8-column cell
  - lfo                        # the first and only consumer
  - onboarding                 # info-badges must re-observe a hidden page
  - dropdown
  - ../decisions/adr-014-dont-make-me-think
source:
  - src/ui/components/panel-tabs.ts
  - src/ui/components/panel.ts
  - src/ui/styles/layout.module.css
```

A tab strip that lives **inside an existing panel's title row**, paging that one
panel's body. Not a panel container — a strip plus a page stack, handed back as
two separate elements for the caller to place.

## Background / Why

The synth faceplate is a fixed 8-column grid (`layout.module.css` `.main`), and
all eight columns are taken. Any feature that wants a ninth panel either wraps the
grid to a second row or shares an existing panel. [lfo](lfo.md) REQ-15 needed the
second, so a panel had to grow pages.

`TabContainer` (`src/ui/components/tabs.ts`) already does tabs — but it builds its
**own panel chrome**: `TabContainer.el` is a `.root` with background, border,
radius and shadow, i.e. a whole panel. Dropping it inside a `layout.panel` would
double-frame it, and its `.bar` is sized for the full-width pattern row
(`padding: 0 10px 0 6px`, a gradient, `.tab` at `padding: 8px 18px`). Two tabs at
those metrics measure ~230 px against an ~191 px faceplate cell. What was missing
was not "tabs" but a **decomposed** strip that a caller places itself. That is the
whole of this component.

## Requirements

- **REQ-1** — `createPanelTabs` returns the strip (`bar`) and the page stack
  (`body`) as **two separate elements**, plus `activate` / `activeId` /
  `setLit` / `onChange` / `destroy`. It renders no panel chrome of its own and
  makes no assumption about where either element is placed. This is the one thing
  `TabContainer` cannot do, and the reason this is a new component rather than a
  refactor of it.

- **REQ-2** — The selected page is **session-only view state**: never a
  `ParamBus` param, never persisted. A `*.page` ParamDef would be snapshotted into
  every preset, song and share link, published to AI authors through
  `public/params.json`, and offered as a Motion/XY automation axis (the pickers
  read `bus.ids()`) — "automate which tab is visible" is nonsense. The precedents
  are explicit: `motion-panel.ts`'s X/Y graph toggle is "a local view state, never
  persisted", and `TabContainer`'s active tab is not persisted either. In this app
  only *collapse* survives a reload (`websynth.ui.collapsed.*`).

- **REQ-3** — Testids are **prefix-namespaced**, `ptab-<prefix>-<pageId>` for a
  tab button and `ppage-<prefix>-<pageId>` for its page shell, minted in the
  factory from a required `prefix` option (testids.md REQ-2, the `BankBar`
  pattern). Deliberately **not** `tab-<id>` / `panel-<id>`: that namespace belongs
  to `TabContainer` and is anchored by e2e specs, `info-badges.ts` and
  `UiBridge.showTab`. Deliberately not `seg-…` either, which `Segmented` mints
  from param ids.

- **REQ-4** — The tab **declares no `font-family`**, so it inherits the sans like
  the `.panelTitle` it replaces. This is a consequence of REQ-9, not a style
  preference: the active tab has to *be* the panel heading, and panel headings
  are content-adjacent sans in this app, not serif faceplate legends. It is the
  one place [typography](typography.md) REQ-1's "tab labels are serif" does not
  apply, and that spec records the carve-out rather than this one.
  - It also keeps the component off the serif allowlist.
    `tests/ui/typography.test.ts` asserts an **exact set match** between every
    selector declaring `font-family: var(--serif)` and its `DISPLAY_TYPE` list,
    so a serif here would fail the suite until someone added the
    whitespace-normalised selector string.
  - All of this component's classes (`.panelTabs`, `.panelTab`, `.panelPage`,
    `.panelTabLamp`) live in `layout.module.css` and set no `font-family`.

- **REQ-5** — **Every page stays in the DOM**; switching toggles the global
  `visible` class on page shells, mirroring `TabContainer`'s
  `.content:global(.visible)` idiom. Hidden pages keep their `bus.subscribe`
  registrations, so a song or preset load repaints them and a page is already
  correct the instant it is revealed. Pages are **not** rebuilt on switch, and a
  control is never re-bound to a different `paramId` — a component's testid is
  minted from its param id at construction (testids.md REQ-1), so re-binding would
  mutate a testid at runtime and make every e2e selector race the tab state. It
  would also break ADR-008: a component whose param moves is not self-wired.

- **REQ-6** — `setLit(id, on)` puts a **lamp** on a tab whose page is doing
  something the user cannot currently see. Without it, a page-2 modulation is
  invisible state, which ADR-014 law 5 forbids. The component only paints the
  lamp; *what counts as active* is the caller's rule (for the LFO panel,
  lfo.md REQ-15).

- **REQ-7** — A tabbed panel carries `data-help` on the **tab row**, never on a
  tab button: `info-badges.ts` anchors via `byHelp(topic)`, and an anchor that
  moved or vanished with the selected page would take the ⓘ badge with it. The
  row is the title's replacement (REQ-9), so it inherits the title's role as the
  anchor. Because a page shell is a `display:none ↔ flex` container, the **first
  page's shell must be added to `info-badges`' `ResizeObserver` selector list** —
  the same treatment `[data-testid="panel-seq"]` already gets — or badges
  anchored inside it do not return when the user switches back.

- **REQ-8** — `createPanel` and `createTabbedPanel` build the same `.panel` box,
  so a tabbed panel is structurally an ordinary panel: one header element, one
  body. `createPanel` keeps the existing `panel(title, build, helpId?)`
  signature, so no existing call site changes.

- **REQ-9** — **The strip replaces the title; it does not sit beside it.** Each
  tab names its own page in full (`LFO 1`, `LFO 2`), so a separate heading would
  only repeat them, and a title-plus-strip row costs vertical space that the
  8-column faceplate does not have. The row therefore occupies **exactly a plain
  `.panelTitle`'s height** (21 px today: a 13 px line box + 3 px padding + 1 px
  border top and bottom, against the title's 14 px line box + 6 px padding + 1 px
  rule), so a tabbed panel's controls stay on the same baseline as its untabbed
  neighbours across the grid.
  - **Both sides of the match declare their `line-height` in px.** Leaving
    either to the font makes the equality a property of the machine rather than
    of the stylesheet: `--sans` is `'Inter', system-ui, …` and no build ships
    Inter as a webfont, so `line-height: normal` at 10 px resolves against
    whatever the OS substitutes — a 14 px line box on Segoe UI, 11 px on the
    Linux CI runner's fallback. That is exactly how a title that measured 21 px
    on the author's box measured 18 px under a 21 px tab row in CI: the tab had
    its explicit line-height from the start; `.panelTitle`, which predates this
    component, did not.
  - Because the drift only shows where the fonts differ, the requirement is
    pinned **twice**: as CSS text (`tests/ui/panel-header-height.test.ts`, which
    runs everywhere and computes both box heights from the declarations), and by
    measuring the laid-out rows in a real browser (`e2e/lfo2.spec.ts` — jsdom has
    no layout engine, so only an E2E assertion can see the rendered box).
  - **Unselected** tabs use the `Switch` well (`linear-gradient(180deg, #1a1410,
    #0a0805)` + `--panel-border`), so the page you are *not* on reads as a
    control to press. **Selected** wears the panel-title look exactly — same
    size, spacing, weight and `--accent-secondary` — over the panel's own
    ground, distinguished only by a subtle `rgba(244, 205, 94, 0.28)` outline and
    top-rounded corners. The shape is what says "tab" at this size; nothing
    shouts.

- **REQ-10** — Tabs **share the row evenly** (`flex: 1 1 0`): 50/50 for two,
  33/33/33 for three. A content-width strip would jitter as labels changed and
  would leave the header visibly unbalanced against the panel's full-width
  dropdowns.

## Technical design

### Contract / public interface

```yaml
PanelTabPage:
  id: string
  label: string
  content: HTMLElement

PanelTabsOptions:
  prefix: string          # required — the testid namespace (REQ-3)
  pages: PanelTabPage[]
  initialId?: string      # defaults to pages[0].id

PanelTabs:
  bar:  HTMLElement       # place in the panel title row
  body: HTMLElement       # place where the panel body goes
  activeId: string
  activate(id): void
  setLit(id, on): void    # REQ-6
  onChange(fn): () => void
  destroy(): void

createPanelTabs(opts: PanelTabsOptions) -> PanelTabs

# src/ui/components/panel.ts
createPanel(title, build, helpId?) -> HTMLElement                    # unchanged surface
createTabbedPanel({ prefix, help?, pages: [{ id, label, build }] })
  -> { el: HTMLElement, tabs: PanelTabs }
```

### Layer touchpoints & ordering

```yaml
panel.ts:      createPanel        -> .panel > .panelTitle + .panelBody   (unchanged)
               createTabbedPanel  -> .panel > tabs.bar + tabs.body
                                     data-help goes on tabs.bar (REQ-7)
panel-tabs.ts: bar  = div.panelTabs > button.panelTab per page (span.panelTabLamp
                      out of flow + a label span, so setLit cannot wipe the text)
               body = div per page, .panelPage, toggled with the global `visible` class
app.ts:        `const panel = createPanel` — the seven untabbed panels are unchanged
consumers:     src/ui/panels/lfo-panel.ts (the only one today)
```

Ordering: each page's `build(body)` runs during `createTabbedPanel`, before the
strip is activated, so `activate(initialId)` paints against a fully built stack.

### Persistence

**Deliberately none.** See REQ-2. The component reads and writes no
`localStorage` key and registers no param; a reload always opens the initial page.

## Scenarios (BDD)

```gherkin
Scenario: The strip and the page stack are separate elements
  Given createPanelTabs with two pages
  Then it returns a bar and a body, and neither carries panel chrome
# pinned by: tests/ui/panel-tabs.test.ts

Scenario: Testids are prefix-namespaced and do not collide with TabContainer
  Given createPanelTabs with prefix "lfo" and pages "1" and "2"
  Then the buttons are ptab-lfo-1 and ptab-lfo-2
  And the shells are ppage-lfo-1 and ppage-lfo-2
  And no element mints a bare tab-1 or panel-1
# pinned by: tests/ui/panel-tabs.test.ts

Scenario: The first page is active on construction
  Given no initialId is passed
  Then pages[0] is active and its shell has the visible class
# pinned by: tests/ui/panel-tabs.test.ts

Scenario: Switching pages keeps both subtrees mounted (REQ-5)
  Given page 1 is active
  When the user clicks the page 2 tab
  Then page 2 gains the visible class and page 1 loses it
  And both page shells are still in the DOM, with their controls intact
# pinned by: tests/ui/panel-tabs.test.ts

Scenario: A hidden page still tracks the bus (REQ-5)
  Given page 2 holds a control bound to a param
  When that param changes while page 1 is showing
  Then the hidden control has already repainted when page 2 is revealed
# pinned by: tests/ui/lfo-panel.test.ts

Scenario: An off-screen active page lights its tab (REQ-6)
  Given page 2 is hidden and its feature is doing something
  When the caller calls setLit('2', true)
  Then the page 2 tab carries the lit class, and drops it on setLit('2', false)
# pinned by: tests/ui/panel-tabs.test.ts

Scenario: The help badge anchor survives a page switch (REQ-7)
  Given a tabbed panel with a help topic
  Then the tab row carries data-help, and no tab button does
# pinned by: tests/ui/panel-tabs.test.ts, tests/ui/lfo-panel.test.ts

Scenario: Existing untabbed panels are unaffected (REQ-8)
  Given createPanel is called with the old (title, build, helpId) signature
  Then it builds the same .panel/.panelTitle/.panelBody as before
# pinned by: tests/ui/panel-tabs.test.ts

Scenario: A tabbed header is exactly as tall as a plain one (REQ-9)
  Given the LFO panel and the untabbed panels beside it
  When the faceplate lays out
  Then the tab row measures the same height as every plain panel title
  So the two panels' controls sit on the same baseline
# pinned by: e2e/lfo2.spec.ts

Scenario: The header match does not depend on which sans the OS substitutes (REQ-9)
  Given a machine whose fallback sans gives 10px text an 11px line box
  When the faceplate lays out
  Then the plain panel title is still 21px tall, as the tab row is
  Because both rules declare a px line-height instead of inheriting the font's
# pinned by: tests/ui/panel-header-height.test.ts

Scenario: Each tab names its own page, with no separate heading (REQ-9)
  Given a two-page LFO panel
  Then the tabs read "LFO 1" and "LFO 2" and the panel carries no other title
# pinned by: tests/ui/panel-tabs.test.ts, tests/ui/lfo-panel.test.ts

Scenario: Tabs share the header evenly (REQ-10)
  Given two pages in a panel wide enough for both
  Then each tab occupies half the row
# pinned by: e2e/lfo2.spec.ts

Scenario: The component declares no new serif rule (REQ-4)
  Given the strip reuses segmented.module.css
  When the typography drift pin runs
  Then the serif selector set still equals its allowlist, with no new entry
# pinned by: tests/ui/typography.test.ts
```

## Gesture inventory (ADR-014)

Required of every new interactive control (`recipes/design-an-interaction.md`).

| Gesture | Target | Outcome |
| --- | --- | --- |
| tap / click | a tab button | Show that page, hide the others. Never writes a param. |
| tap / click | the already-active tab | Nothing. |
| `Tab` / `Shift+Tab` | the strip | Move focus across tab buttons — they are native `<button type="button">`. |
| `Enter` / `Space` | a focused tab | Same as tap (native button activation). |
| `←` / `→` | the strip | **Nothing.** This is deliberately not a WAI-ARIA `tablist`; `TabContainer` is not one either, and half-adopting the pattern (arrow keys without roving `tabindex`, `role`, and `aria-selected`) is worse for a screen reader than plain buttons. |
| double-tap | a tab | Nothing. Double-tap is reserved for knob reset-to-baseline (`param-reset-baseline.md`) and these tabs sit beside knobs. |
| long-press / right-click / wheel / drag | a tab | Nothing. A wheel gesture next to a column of knobs would be a law-2 collision. |
| — | a tab whose page is active off-screen | Lamp (REQ-6). Pure state display, no gesture. |

**Precedent followed (law 4).** Numbered modulator pages inside one panel are the
standard answer in both worlds: Xfer **Serum**'s LFO 1–4 strip, Elektron
**Digitone**'s LFO1/LFO2 pages, Novation **Peak**'s LFO select. None of them
persists which page you left open, which is the precedent behind REQ-2.

**Law 1 (self-evident).** A tab reads as the panel's heading and names its page
in full — `LFO 1`, `LFO 2` — so nothing has to explain what the row is. Each
button carries a `title` naming the outcome ("Show the LFO 2 page"), and the
panel's existing help topic gains a sentence. No tour step: this is not on the
first-run path.

**Law 6 (touch-first), honestly.** REQ-9 fixes the row at a panel header's
height — 21 px, well short of the 44 px target, and shorter than the 26 px every
faceplate `Segmented` row already ships. This is the sharpest trade-off in the
component and it is deliberate: the alternative is a header that costs more
vertical space than the panel it heads, on an 8-column grid whose whole point is
hardware density. What makes it usable is **width**: a tab fills its half of the
panel (~95 px at the 8-column size, wider below every reflow), so the target is
short but broad, and the whole cell is the hit area rather than just the text.
Recorded rather than glossed — if a touch complaint ever arrives, this is the
requirement to revisit first.

## Tests & verification

- Unit: `tests/ui/panel-tabs.test.ts`, `tests/ui/lfo-panel.test.ts` — `npm test`
- Drift pin: `tests/ui/typography.test.ts` (REQ-4),
  `tests/ui/panel-header-height.test.ts` (REQ-9, from CSS text)
- E2E: `e2e/lfo2.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`

## Open questions / future

- **The reusable non-param segmented control is still missing.** Ten call sites
  across nine modules (`sync-section.ts`, `perf-settings.ts`, `motion-panel.ts`,
  `record-window.ts`, `export-*-modal.ts`, `song-panel.ts`, `live-fx.ts`,
  `preset-manager-modal.ts` twice) each hand-roll ~15 lines against
  `segmentedStyles.root`. `PanelTabs` is the first component to formalise the
  pattern; extracting a `SegmentedGroup` primitive beneath it and migrating those
  call sites is the natural follow-up, and would give this component a `bar` it
  does not have to build itself.
- No other panel is tabbed yet. OSC 1 / OSC 2 and the two envelope panels are the
  obvious candidates, and each would free a faceplate column — but they change
  panels players already know, so they are their own change.
- `initialId` is the only entry point for choosing a page at boot. If a consumer
  ever wants "open on the page that has something in it", that is a caller
  decision (`activate` after construction), not a component feature — auto-moving
  the view without a gesture would fight law 5 rather than serve it.
