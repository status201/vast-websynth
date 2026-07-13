# Dropdown (shared component)

```yaml
id: dropdown
status: implemented
version: 1
owner: ui
related:
  - architecture
  - xy-pad            # axis-assign pickers are Dropdowns over every bus param id
  - presets           # header preset selector
  - drum-kits         # KIT picker
  - floating-window   # z-index tiering (menu sits at the Dropdown/Modal tier, 1000)
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
  within the menu and receives keyboard focus** (falling back to the first
  option when nothing is active). Focus makes Enter select it natively and
  gives arrow-free keyboard users a starting point; the scroll must move only
  the menu, never the page.
- **REQ-6** — Closing the menu returns focus to the toggle when focus was
  inside the dropdown, so keyboard flow isn't dropped on the floor after
  Escape or a selection.

## Technical design

### Contract / public interface

`class Dropdown` (`src/ui/components/dropdown.ts`):

- `constructor(options: string[], initial?: string)`
- `el: HTMLElement` — root (`styles.root` + global `dropdown` class)
- `setOptions(options: string[]): void`
- `setValue(v: string): void` / `get value(): string`
- `onChange(cb: (v: string) => void): void`
- `destroy(): void`

`ParamDropdown` (`src/ui/components/param-dropdown.ts`) wraps a `Dropdown` and
keeps it in sync with a discrete numeric `ParamBus` param (index ↔ label).

### Layer touchpoints & ordering

- Options are native `<button>`s, so `focus()`/Enter work without extra ARIA
  plumbing. REQ-5 runs in `setOpen(true)` *after* `position()` (the menu must
  be display-block and anchored before it can be scrolled/focused).
- `scrollIntoView` is called as an optional (`item.scrollIntoView?.(…)`,
  `block: 'nearest'`) because jsdom — where the unit tests run — doesn't
  implement it; `focus({ preventScroll: true })` prevents the page itself from
  scrolling to the fixed-position menu.

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
```

## Tests & verification

- Unit: `tests/ui/dropdown.test.ts`, `tests/ui/param-dropdown.test.ts` — `npm test`
- E2E (indirect): `e2e/controls.spec.ts` (preset select), `e2e/drum-kit.spec.ts`
  (KIT picker) — `npm run e2e`
- Typecheck: `npm run typecheck`
- Manual: open an XY Pad axis dropdown with a value deep in the param list —
  the list opens scrolled to the highlighted value.

## Open questions / future

- Arrow-key navigation between options (Home/End, type-ahead) — focus-on-open
  is the foundation for it.
