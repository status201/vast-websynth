# Dropdown (shared component)

```yaml
id: dropdown
status: implemented
version: 7  # v7: setOptions takes a dividerAfter group separator, and REQ-11 writes
            #     down that a rebuild can strand the displayed value
            # v6: setDisabledOptions — individual options can be unselectable (REQ-10)
            # v5: setDimmed + the "never dim the root" invariant (REQ-9)
            # v4: the filter row is content type, not faceplate legend (REQ-7)
            # v3: Up/Down/Home/End walk the options in every dropdown (REQ-8)
            # v2: a live filter row on long lists (REQ-7); REQ-5's focus target
            #     moves to that input where it exists
owner: ui
related:
  - architecture
  - typography        # the filter row is sans; the toggle and options are serif
  - xy-pad            # axis-assign pickers are Dropdowns over every bus param id
  - presets           # header preset selector
  - drum-kits         # KIT picker
  - floating-window   # z-index tiering (menu sits at the Dropdown/Modal tier, 1000)
  - motion-sequencer  # the inherited-axis pickers; the bug REQ-9 was written for
source:
  - src/ui/components/dropdown.ts
  - src/ui/components/param-dropdown.ts   # ParamBus-bound wrapper
  - src/ui/styles/dropdown.module.css
```

## Background / Why

A native `<select>` can't have its open menu styled cross-browser, so the app
uses one hand-built dropdown everywhere: a toggle `<button>` plus a popover of
option `<button>`s. It is consumed directly (header preset select, XY Pad axis
assign, song/seq slot pickers, drum KIT picker, record-modal device picker) and
via `ParamDropdown`, which binds a discrete numeric bus param to a label list.
Some option lists are long (the XY Pad axis pickers list every bus param id),
so the menu scrolls — and the current selection must be brought into view on
open, not left for the user to hunt down.

Scroll-to-selection (REQ-5) only helps a user who wants to keep or nudge the
current value. Choosing a *different* one out of ~198 param ids meant dragging
through a 280 px window ~20 screens deep, with no way to jump: the option
buttons carry no type-ahead and the list has no structure to skim. The e2e suite
had already conceded the point — `e2e/motion.spec.ts` sets axis assignments
through the dev bridge rather than the UI, noting "the dropdown UI is a 200-item
list". So a long list grows a **live filter** (REQ-7), and it does so by option
count rather than by a flag at each call site, so the next long list gets it
without anyone remembering to ask.

## Requirements

- **REQ-1** — The control renders a toggle button showing the current value and
  a caret; clicking it opens/closes a popover menu with one button per option
  string. The option equal to the current value carries the global `active`
  class.
- **REQ-2** — Selecting an option sets the value, closes the menu, and fires
  the `onChange` listener. `setValue` updates the toggle label and the `active`
  marking; `setOptions` rebuilds the list (falling back to the first option if
  the current value disappears).
- **REQ-3** — The open menu closes on outside click and on Escape. `destroy()`
  removes every document/window listener.
- **REQ-4** — The menu is `position: fixed`, anchored to the toggle's viewport
  rect, flips above when it would overflow the bottom edge, and re-anchors on
  scroll/resize while open. It is capped at `max-height: 280px` with
  `overflow-y: auto`.
- **REQ-5** — **On open, the currently selected option is scrolled into view
  within the menu**, and keyboard focus lands on the **filter input** where one
  exists (REQ-7) and on the selected option otherwise (falling back to the first
  option when nothing is active). Focusing an option makes Enter select it
  natively and gives arrow-free keyboard users a starting point; the scroll must
  move only the menu, never the page. Scroll-to-selection happens either way —
  a filtered list still opens showing where the current value is.
- **REQ-6** — Closing the menu returns focus to the toggle when focus was
  inside the dropdown, so keyboard flow isn't dropped on the floor after
  Escape or a selection.
- **REQ-7** (v2) — **A list of `FILTER_MIN_OPTIONS` (30) or more options carries a
  live filter row** at the top of the menu: a magnifier glyph plus a text input
  (`data-testid="dropdown-filter"`). Typing hides every option whose label does
  not contain the query (case-insensitive substring); when nothing matches, a
  single "No match" line shows instead of an empty box. Details that are load-
  bearing:
  - The threshold is deliberately well above the ~9–10 rows the 280 px menu
    fits, so a *slightly* scrolling list keeps its zero-chrome look. `new
    Dropdown(opts, initial, { filter })` overrides the count either way.
  - `setOptions` may cross the threshold in both directions (`Presets.list()`
    grows as the user saves), so the row is created/removed per call — and
    options must therefore render into their **own container**, never as direct
    children of the scrolling menu.
  - The query **resets on every open**, so the menu always opens complete. A
    filter that persisted would be invisible state hiding options
    ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 5).
  - `Enter` selects the first still-visible option; the arrow keys move into the
    list (REQ-8); `Escape` closes the menu (REQ-3) rather than clearing the query
    first — one gesture, one outcome.
  - **The row is content type, not a legend** (v4): the input and the "No match"
    line are `--sans`, while the toggle and the options stay on the faceplate
    `--serif` ([typography](typography.md) REQ-1/REQ-2). The input shipped in v2
    as 10 px Georgia with legend tracking, copied from the sibling `.option`
    rule — barely readable on the one control in the menu you *type into*. A
    field holds the user's text; a legend labels a control.
  - The row contains **no `<button>`**. Consumers select the toggle as the
    dropdown's first button (`e2e/onboarding.spec.ts` does), so a clear "✕"
    would break them; open-reset and Escape make one unnecessary anyway.
  - `dropdown-filter` is a **per-instance** testid, not a unique one — six live
    on the page at once. E2E must scope it to the dropdown root
    (`picker.getByTestId('dropdown-filter')`), or Playwright's strict mode fails
    the locator.
- **REQ-8** (v3) — **The arrow keys move the selection through the list, in every
  dropdown** — filtered or not. While the menu is open:
  - `ArrowDown` / `ArrowUp` move focus to the next / previous **visible** option
    (a filtered-out option is skipped, never landed on and never counted).
  - `Home` / `End` jump to the first / last visible option.
  - From the filter field, an arrow **enters the list** at the end it points at:
    Down → first option, Up → last.
  - Past either end: where a filter row exists, focus returns **to the field** —
    that is where the user narrows the list, so it belongs in the cycle. Without
    one, the list **wraps** (last → first, first → last).
  - Focus *is* the selection cursor here: the options are native `<button>`s, so
    `Enter`/`Space` activate the focused one for free (REQ-2's path), and the
    focused option scrolls into view as it moves.
  - Handled keys are `preventDefault`ed — otherwise the browser scrolls the menu
    out from under the focus move, which is what made a second `ArrowDown` look
    like it did nothing — **and `stopPropagation`ed**, so they never reach
    `installShortcuts` on `window`. `Home` there seeks the transport
    ([transport-position](transport-position.md) REQ-11); an open dropdown must
    not move the playhead. (`Escape` deliberately keeps its old bubbling
    behaviour — panic-on-Escape is harmless and pre-dates this.)
- **REQ-9** (v5) — **A dropdown can be dimmed to mark its value as inherited /
  not explicitly set here**, via `setDimmed(on)`. The dim lands on the
  **toggle**, never on the root — and that scoping is the requirement, not an
  implementation detail:
  - **Nothing may apply `opacity`, `transform`, `filter` (or any other
    stacking-context-forming property) to a Dropdown root.** The menu is
    `position: fixed` but it is still a **DOM child** of the root, so such a
    property does two things at once: it composites the whole subtree as one
    group — painting the filter row and every option at the ancestor's alpha —
    and it establishes a stacking context that **traps** the menu's
    `z-index: 1000`, so later siblings paint over it. REQ-4's "fixed, so it
    escapes its ancestors" holds only while no ancestor creates a stacking or
    containing block.
  - This is written down because it shipped: the Motion tab's inherited axis
    pickers carried `opacity: 0.62` on `sel.el`, which made their option lists
    transparent *and* buried them under the XY pad lane
    ([motion-sequencer](motion-sequencer.md) REQ-8). Both symptoms, one
    declaration. Consumers get `setDimmed` so the safe target is the easy one —
    the same reason [motion-sequencer](motion-sequencer.md) REQ-16 dims a lane's
    label rather than its row.
  - The dim is **presentation only**: a dimmed dropdown stays fully interactive
    ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2 — the control
    that says "nothing is set here" must be the one that lets you set it). Use
    `disabled` on the toggle if a control genuinely should not be operated;
    that is a different state and this is not it.
- **REQ-10** (v6) — **Individual options can be made unselectable**, via
  `setDisabledOptions(labels)`. A disabled option is **greyed, not removed**:
  - *Why not just leave it out of `setOptions`?* Because a shrinking list is the
    more dangerous operation. `setOptions` contains
    `if (!options.includes(this._value)) this._value = options[0]` — dropping the
    option that happens to be current **silently rewrites the value**. Disabling
    never reaches that branch. And a row that vanishes gives the user nothing to
    reason about, while a greyed one shows the choice exists and is spoken for
    ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 5).
  - The option button gets the native `disabled` attribute, so it fires no click
    and selection is blocked without a guard. It **also** drops out of the
    arrow-key walk (REQ-8): a disabled button is not focusable, so leaving it in
    the cycle would stall navigation on it.
  - `disabled` and `hidden` are **independent channels**: `hidden` belongs to the
    filter (REQ-7), `disabled` to this requirement. A disabled option still
    matches the filter and still shows.
  - The component only paints the state; *which* options are unselectable is the
    caller's rule. The first consumer is the LFO panel's mutually exclusive
    destinations ([lfo](lfo.md) REQ-12), reached through `ParamDropdown`'s
    `setDisabledLabels`, which keeps the full label array as the index authority
    so the index↔label mapping cannot drift with the offered set.
- **REQ-11** (v7) — **A list can be split into groups by a divider**, via
  `setOptions(options, { dividerAfter })`: the option at index `dividerAfter - 1`
  gets a rule beneath it. Omitted (or `0`) renders exactly as before, so every
  existing call site is untouched.
  - It is **presentation only** — no group model, no headers, no per-group
    behaviour. The one caller needs to say "this first row is a different kind of
    thing", not to grow the component a taxonomy; the first consumer is the header
    preset selector separating the loaded song's pinned sound from the preset list
    ([presets](presets.md) REQ-13). An option count is enough for that, and it
    cannot desynchronize from the array the way a parallel group list would.
  - The divider is a `border-bottom` on the option, not a separate element, so it
    stays out of the arrow-key walk (REQ-8) and out of the filter's visible count
    (REQ-7) for free — a rule the user cannot focus or land on.
- **REQ-12** (v7, regression) — **`setOptions` can strand the displayed value, so
  a caller whose label may not be an option must re-assert it.** REQ-2's fallback
  (`if (!options.includes(this._value)) this._value = options[0]`) exists for the
  common case where the value is one of the options. It is *wrong* for a consumer
  whose toggle shows something else — the preset selector shows a song name or a
  dirty `"Ember *"` ([presets](presets.md) REQ-5) — where any rebuild silently
  repainted the toggle with the first option while the underlying state said
  otherwise. The component keeps the fallback (dropping it would leave `_value`
  pointing at a row that no longer exists), and the contract is documented here:
  **call `setValue` after `setOptions`, not before**, whenever the displayed value
  is not guaranteed to be in the list. `setValue` early-returns when unchanged, so
  the re-assert costs nothing in the common case.

## Technical design

### Contract / public interface

`class Dropdown` (`src/ui/components/dropdown.ts`):

- `constructor(options: string[], initial?: string, opts?: DropdownOptions)`
  — `DropdownOptions = { filter?: boolean }` (omitted ⇒ auto by option count)
- `el: HTMLElement` — root (`styles.root` + global `dropdown` class)
- `setOptions(options: string[], opts?: SetOptionsOptions): void`
  — `SetOptionsOptions = { dividerAfter?: number }` (REQ-11; omitted ⇒ no divider).
  Call `setValue` **after** this when the displayed value may not be an option
  (REQ-12)
- `setValue(v: string): void` / `get value(): string`
- `setDimmed(on: boolean): void` — inherited/unset styling on the toggle (REQ-9)
- `setDisabledOptions(labels: Iterable<string>): void` — greyed, unselectable
  options (REQ-10); survives a later `setOptions`
- `onChange(cb: (v: string) => void): void`
- `destroy(): void`

`ParamDropdown` (`src/ui/components/param-dropdown.ts`) wraps a `Dropdown` and
keeps it in sync with a discrete numeric `ParamBus` param (index ↔ label). It
adds `setDisabledLabels(labels)`, a pass-through to `setDisabledOptions` — the
wrapper stays a thin index↔label binder and the consumer owns the rule.

### Data shapes — the menu's DOM

```yaml
div.root.dropdown:           # + global `open` class while open
                             # MUST NOT carry opacity/transform/filter (REQ-9)
  button.toggle[.dimmed]:    # MUST stay the first <button> child (REQ-7)
    span.label               # current value
    span.caret               # ▾
  div.menu:                  # position:fixed, flex column, max-height 280px
                             # fixed, but still a DOM child of the root (REQ-9)
    div.filterRow:           # present only above the threshold (REQ-7)
      span.searchIcon        # inline SVG, currentColor
      input.filterInput      # data-testid="dropdown-filter"
    div.list:                # the only scrolling box (overflow-y:auto)
      button.option[.active] # one per option; [hidden] while filtered out (REQ-7)
                             # [disabled] while unselectable (REQ-10) — separate
                             # channels: a disabled option still shows
                             # [.divider] on index dividerAfter-1 (REQ-11):
                             # a border-bottom, not an element — nothing to focus
      div.empty              # "No match", hidden unless zero matches
```

### Layer touchpoints & ordering

- Options are native `<button>`s, so `focus()`/Enter work without extra ARIA
  plumbing. REQ-5 runs in `setOpen(true)` *after* `position()` (the menu must
  be displayed and anchored before it can be scrolled/focused).
- `scrollIntoView` is called as an optional (`item.scrollIntoView?.(…)`,
  `block: 'nearest'`) because jsdom — where the unit tests run — doesn't
  implement it; `focus({ preventScroll: true })` prevents the page itself from
  scrolling to the fixed-position menu.
- `.list` owns the scroll (not `.menu`) so the filter row stays pinned while the
  options scroll under it, and so `setOptions` can clear the options without
  touching the row.
- Arrow navigation (REQ-8) lives in the **one document-level `keydown`** the
  component already had for Escape, not on the input and the options separately:
  the keydown bubbles there from either focus target, so "the next option" has a
  single definition. The handler is gated on `open`, so a closed dropdown's
  listener is inert.
- Filtering hides options with the native `hidden` property, which needs an
  explicit `.option[hidden] { display: none }` — `.option`'s own
  `display: block` outranks the UA `[hidden]` rule.
- The filter input is an `<input>`, so `installShortcuts`' editable-target guard
  ([input-control](input-control.md) REQ-5) already stops a typed `z` from
  playing a note. `Escape` must be left to bubble to the component's existing
  document `keydown` handler.
- The magnifier glyph is **local to this component**, not in `header-icons.ts`
  (that module is the header's utility buttons, and its `svg.hdr-icon` CSS is
  sized for 15 px header slots).
- The menu is **not portalled to `<body>`** — it is `position: fixed` and
  manually anchored, but it stays a DOM child of the root. That keeps
  `el.contains()` working for the outside-click and focus-return checks (REQ-3,
  REQ-6) and keeps `destroy()` a single `remove()`, at the cost of REQ-9's
  invariant: an ancestor that forms a stacking context still captures it. If a
  consumer ever genuinely needs a transformed/faded dropdown, portalling the
  menu is the fix — not weakening REQ-9.
- `.root` therefore stays `position: relative; z-index: auto` (relative purely so
  nothing else needs to know about it) — deliberately **not** a stacking context.

### Persistence

None. The selected value belongs to the consumer (bus param, preset session…).

## Scenarios (BDD)

```gherkin
Scenario: Opening scrolls to and focuses the selected option
  Given a Dropdown with many options whose current value is deep in the list
  When I click the toggle
  Then the menu opens with the active option scrolled into view
  And the active option button has keyboard focus
# pinned by: tests/ui/dropdown.test.ts

Scenario: Closing returns focus to the toggle
  Given an open Dropdown whose active option is focused
  When I press Escape (or click an option)
  Then the menu closes and the toggle has focus
# pinned by: tests/ui/dropdown.test.ts

Scenario: Selecting an option
  Given an open Dropdown
  When I click an option
  Then the value updates, the menu closes, and onChange fires once
# pinned by: tests/ui/dropdown.test.ts

Scenario: A long list carries a filter; a short one does not (v2, REQ-7)
  Given a Dropdown with 20 options and another with 19
  Then only the 20-option menu contains a `dropdown-filter` input
  And the `{ filter }` option forces either answer regardless of count
# pinned by: tests/ui/dropdown.test.ts

Scenario: Typing narrows the list live (v2, REQ-7)
  Given an open Dropdown whose filter input is focused
  When I type "cut"
  Then only options whose label contains "cut" (any case) stay visible
  And pressing Enter selects the first of them, closing the menu
# pinned by: tests/ui/dropdown.test.ts, e2e/xy-pad.spec.ts

Scenario: A query that matches nothing says so (edge, v2)
  Given an open filtered Dropdown
  When I type a string no option contains
  Then every option is hidden and a single "No match" line shows
# pinned by: tests/ui/dropdown.test.ts

Scenario: Reopening starts from the whole list (v2, REQ-7)
  Given a Dropdown that was closed while a query was filtering it
  When I open it again
  Then the input is empty and every option is visible again
# pinned by: tests/ui/dropdown.test.ts

Scenario: setOptions across the threshold keeps the menu coherent (edge, v2)
  Given a filtered Dropdown
  When setOptions is called with fewer than 20 options
  Then the filter row is removed and every new option renders
  And calling it again with 20+ restores the row (the input is not a stale node)
# pinned by: tests/ui/dropdown.test.ts

Scenario: Arrow keys walk the list, not just its first row (v3, REQ-8)
  Given an open Dropdown with the second option focused
  When I press ArrowDown twice
  Then focus lands on the fourth option — each press moves one step
  And Home jumps to the first option, End to the last
# pinned by: tests/ui/dropdown.test.ts, e2e/xy-pad.spec.ts

Scenario: Arrows skip filtered-out options (v3, REQ-8)
  Given an open filtered Dropdown narrowed to two matches
  When I press ArrowDown from the filter field twice
  Then focus lands on the second match, never on a hidden option
# pinned by: tests/ui/dropdown.test.ts

Scenario: Past the end, a filtered list returns to its field and a plain one wraps (edge, v3)
  Given the last visible option is focused
  When I press ArrowDown
  Then focus returns to the filter field if there is one, else to the first option
# pinned by: tests/ui/dropdown.test.ts

Scenario: The filter field reads as a field, not a legend (regression, v4)
  Given the filter row, which the user types into
  Then its input and its "No match" line render in --sans
  And the toggle and the options stay on the faceplate --serif
# pinned by: tests/ui/typography.test.ts

Scenario: An open dropdown swallows Home instead of seeking (regression, v3)
  Given an open Dropdown with an option focused
  When I press Home
  Then focus moves to the first option
  And the key does not reach installShortcuts, so the playhead does not move
# pinned by: tests/ui/dropdown.test.ts

Scenario: The dimmed state marks the toggle, not the root (regression, v5, REQ-9)
  Given a Dropdown
  When setDimmed(true) is called
  Then the toggle carries the dimmed class and the root's classes are unchanged
  And setDimmed(false) removes it again
# pinned by: tests/ui/dropdown.test.ts

Scenario: A dimmed dropdown is still operable (v5, REQ-9)
  Given a dimmed Dropdown
  When I click its toggle and pick an option
  Then the menu opens as usual and onChange fires — dimming is presentation only
# pinned by: tests/ui/dropdown.test.ts

Scenario: Nothing dims the root, or the menu goes with it (regression, v5, REQ-9)
  Given dropdown.module.css
  Then no rule reaching `.root` declares opacity, transform or filter
  And the dimmed rule is compounded with `.toggle`, so it cannot land on the root
# pinned by: tests/ui/dropdown-stacking.test.ts

Scenario: A disabled option is greyed, shown, and unselectable (v6, REQ-10)
  Given setDisabledOptions(['cutoff'])
  Then that option carries the disabled attribute and is still visible
  And clicking it fires no onChange
# pinned by: tests/ui/dropdown.test.ts

Scenario: Arrows skip disabled options (v6, REQ-10, REQ-8)
  Given the second of three options is disabled
  When I press ArrowDown from the first
  Then focus lands on the third, never stalling on the disabled one
# pinned by: tests/ui/dropdown.test.ts

Scenario: Disabling never rewrites the value (edge, v6, REQ-10)
  Given the current value is "cutoff"
  When setDisabledOptions(['cutoff']) runs
  Then the value is still "cutoff" and the toggle still reads it
# pinned by: tests/ui/dropdown.test.ts

Scenario: Disabled survives a later setOptions (edge, v6, REQ-10)
  Given setDisabledOptions(['pan']) then setOptions with the same labels
  Then "pan" is still disabled in the rebuilt list
# pinned by: tests/ui/dropdown.test.ts

Scenario: A divider marks the end of the first group (v7, REQ-11)
  Given setOptions(['Night Rider', 'acid', 'bass'], { dividerAfter: 1 })
  Then the first option carries the divider class and no other option does
  And omitting dividerAfter leaves every option without it
# pinned by: tests/ui/dropdown.test.ts

Scenario: A rebuild does not repaint a value the list never held (regression, v7, REQ-12)
  Given a Dropdown showing "Night Rider" while its options are preset names
  When setOptions runs and the caller re-asserts setValue("Night Rider")
  Then the toggle still reads "Night Rider", not the first option
# pinned by: tests/ui/dropdown.test.ts
```

## Tests & verification

- Unit: `tests/ui/dropdown.test.ts`, `tests/ui/param-dropdown.test.ts` — `npm test`
  (the jsdom suite cannot see real CSS; the v4 typeface split is pinned by
  `tests/ui/typography.test.ts` and REQ-9's CSS half by
  `tests/ui/dropdown-stacking.test.ts` — both read the stylesheets as text)
- E2E: `e2e/xy-pad.spec.ts` (filter an axis picker down to one match and pick it);
  `e2e/motion.spec.ts` (REQ-9 in a real browser: a dimmed picker's menu is opaque
  and on top); indirect — `e2e/controls.spec.ts` (preset select),
  `e2e/drum-kit.spec.ts` (KIT picker) — `npm run e2e`
- Typecheck: `npm run typecheck`
- Manual: open an XY Pad axis dropdown with a value deep in the param list —
  the list opens scrolled to the highlighted value, with the filter focused;
  typing narrows it and Enter picks the top hit. Open the LFO DEST (5 options)
  and drum MODEL (13) pickers — neither shows a filter row.

## Open questions / future

- ~~Arrow-key navigation between options (Home/End, wrap-around)~~ — done in v3
  (REQ-8). Still absent: **type-ahead** on an unfiltered dropdown (jump to the
  next option starting with a typed letter), which the long lists no longer need
  now that they have a filter.
- Fuzzy/subsequence matching instead of substring (`fdc` → `fx.drum.comp`).
  Substring is enough for dotted param ids, where the user knows a fragment.
