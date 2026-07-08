# Floating window

```yaml
id: floating-window
status: draft
version: 3
owner: core
related:
  - architecture
  - ../recipes/add-a-floating-window.md
source:
  - src/ui/components/floating-window.ts
  - src/ui/styles/floating-window.module.css
```

## Background / Why

A reusable **non-modal** floating panel: a draggable, titled window that hovers
over the synth **without** a backdrop, so the instrument underneath stays fully
interactive while it is open. It is the sibling of [`Modal`](../recipes/add-a-modal-dialog.md)
(`src/ui/components/modal.ts`) — same fade/lifecycle idiom — but deliberately drops
the two things that make `Modal` *modal*: the backdrop that captures clicks, and
the Escape-to-close binding. The first use is the [XY Pad](xy-pad.md); the
component is factored out so future free-floating tools (a piano-roll, a mod
matrix) reuse it.

## Requirements

- **REQ-1** — Non-modal: no backdrop element is ever added to the DOM, so pointer
  events on the synth behind the window are never intercepted. The window itself is
  `position: fixed`.
- **REQ-2** — Re-openable toggle: one instance may `open()` → `close()` → `open()`
  repeatedly (unlike single-use `Modal`). `open()`/`close()` are each idempotent;
  `onClose` fires **once per close transition** (a double `close()` fires it once).
  `isOpen` reflects the current logical state.
- **REQ-3** — Draggable by its title bar: a pointerdown on the title bar (but not on
  the close button) drags the whole window, updating `style.left`/`style.top`,
  clamped so it stays within the viewport. Uses `setPointerCapture?.()`
  (optional-chained — jsdom has no capture).
- **REQ-4** — No Escape binding: pressing Escape does **not** close it (that key is
  owned by the global panic handler; a non-modal tool must not steal it). Closing is
  via the window's own × button or the caller toggling it.
- **REQ-5** — Fades like `Modal`: `close()` adds the global `.hidden` class and
  removes the node after the 200 ms transition; a re-`open()` before removal cancels
  the pending removal and reveals it again.
- **REQ-6** — Optional **leading title-bar slot**: `opts.leading` (an
  `HTMLElement`) is inserted **after** the built-in minimise button (REQ-7),
  still left of the title, for a caller-owned control (e.g. the XY Pad's gear
  toggle). Its `pointerdown` is stopped so dragging never starts from it (same
  guard as the close button). Layout keeps the minimise button + leading control
  + title on the left and the close button on the right regardless of child count.
- **REQ-7** — Built-in **minimise / restore button**: every floating window has a
  `[−]` button as the **far-left** child of the title bar (before `opts.leading`,
  `minBtn`). Clicking it **collapses** the window to just its title bar — the
  `.body` is hidden (global `collapsed` class on the root) — and flips the glyph
  to `[+]`; clicking again **restores** the body. The button updates
  `aria-expanded` (`true` when expanded) and `aria-label` (Minimise / Restore),
  and stops its `pointerdown` so a drag never starts from it. Collapse state is
  **ephemeral**: it is not persisted, and `open()` always reveals the window
  **expanded** (predictable re-open), even for an instance kept alive across
  closes. `isCollapsed` reflects the current state.
- **REQ-8** — Stays inside the viewport across viewport changes: because a
  window is positioned with fixed `left`/`top` (px) and an instance is kept alive
  across closes, a position computed for one viewport must not leave the window
  (and its drag-handle title bar) unreachable in a smaller/rotated one.
  `open()` re-clamps the current position to the live viewport (using the same
  max-`left`/`top` math as the drag, REQ-3). While open, a `resize` **and**
  `orientationchange` listener re-clamps on every viewport change (added on
  `open()`, removed on `close()`, mirroring `Dropdown`'s reposition listeners).
  Restoring from minimised also re-clamps (the body re-grows `offsetHeight`, which
  could otherwise overflow the bottom edge). All clamping shares one helper with
  the drag so the bounds are identical.

## Technical design

### Contract / public interface

```yaml
FloatingWindow:   # src/ui/components/floating-window.ts (a class, like Modal)
  new (opts: FloatingWindowOptions)
  readonly body: HTMLElement          # caller appends content here
  open(): void                        # idempotent; mounts + reveals; always EXPANDED
  close(): void                       # idempotent; hides, fires onClose once, removes after fade
  get isOpen(): boolean
  get isCollapsed(): boolean          # true while minimised (body hidden)
  # static class getters (parity with Modal, for consistent markup/testing):
  static rootClass / titleBarClass / titleClass / closeBtnClass / bodyClass / minBtnClass: string

FloatingWindowOptions:
  title: string
  testId?: string                     # data-testid on the root (default none)
  initial?: { left: number; top: number }   # start position (px); defaults centred-ish near the top
  windowClass?: string                # extra class on the root (width/layout variant)
  leading?: HTMLElement               # caller control inserted as the title bar's first child (pointerdown stopped)
  onClose?: () => void                # caller cleanup, once per close
```

### Layer touchpoints & ordering

```yaml
DOM: root (.root, position:fixed, z-index 950) > [ .titleBar (.minBtn + [leading?] + .title + .closeBtn), .body ]
drag: pointerdown on .titleBar -> record start pointer + window pos; window-level
      pointermove updates clamped left/top; pointerup/leave ends. setPointerCapture
      on the title bar retargets moves to it (optional-chained for jsdom).
      The clamp (against window.innerWidth/innerHeight minus the window size) is a
      single shared helper, also invoked on open(), on resize/orientationchange
      while open, and on restore-from-minimised (REQ-8).
minimise button: far-left child; click stops propagation (no drag) and toggles the
      global `collapsed` class on the root + the glyph/aria; open() clears it.
close button: click stops propagation so it never starts a drag; calls close().
leading slot: opts.leading is inserted after .minBtn, before .title; its pointerdown
      is stopped so a drag never starts from it. .titleBar is justify-content:flex-start
      with .closeBtn margin-left:auto so the minimise/leading/title cluster stays left,
      close stays right.
collapsed: root.collapsed hides .body (display:none) and rounds the title bar fully
      (it becomes a standalone pill). CSS only; state driven by the minimise button.
no backdrop: the root is appended straight to document.body — there is no overlay.
```

### Why this is not just `Modal`

| Concern            | `Modal`                              | `FloatingWindow`                       |
| ------------------ | ------------------------------------ | -------------------------------------- |
| Backdrop           | dims + captures clicks (modal)       | none — synth stays live (non-modal)    |
| Escape             | closes (beats panic handler)         | **ignored** (panic keeps Escape)       |
| Lifecycle          | single-use (`opened`/`closed` latch) | re-openable toggle (`isOpen`)          |
| Position           | centred by CSS                       | draggable, free `left`/`top`           |

### Z-index layering

```yaml
panels:            ~100
tour help badges:  900
FloatingWindow:    950     # above panels, below menus/modals so a Dropdown inside it still shows
Dropdown menu / Modal backdrop: 1000
tour overlay:      1100
```

## Scenarios (BDD)

```gherkin
Scenario: Open then close is a clean toggle
  Given a FloatingWindow with an onClose callback
  When it is opened, then closed
  Then the node mounts, reveals, hides, and onClose fires exactly once
# pinned by: tests/ui/floating-window.test.ts

Scenario: No backdrop is ever created (non-modal)
  Given an open FloatingWindow
  Then no element with a backdrop class exists in the document
# pinned by: tests/ui/floating-window.test.ts

Scenario: Dragging the title bar moves the window
  Given an open FloatingWindow at a known position
  When the user pointer-drags the title bar by (dx, dy)
  Then style.left/top shift by (dx, dy) (clamped to the viewport)
# pinned by: tests/ui/floating-window.test.ts, e2e/xy-pad.spec.ts

Scenario: Escape does not close it (non-modal)
  Given an open FloatingWindow
  When Escape is pressed
  Then it stays open
# pinned by: tests/ui/floating-window.test.ts

Scenario: close() is idempotent
  Given an open FloatingWindow with onClose
  When close() is called twice
  Then onClose fires exactly once
# pinned by: tests/ui/floating-window.test.ts

Scenario: A leading control renders in the title bar and never starts a drag
  Given a FloatingWindow created with a leading button
  Then the button is the second child of the title bar (after the minimise button)
  When the user pointer-drags starting on the leading button
  Then the window does not move (the drag never starts)
# pinned by: tests/ui/floating-window.test.ts

Scenario: The minimise button collapses and restores the window
  Given an open FloatingWindow with content in its body
  Then the minimise button is the first child of the title bar and reads "−"
  When the user clicks the minimise button
  Then the body is hidden (root gets the collapsed class), the glyph reads "+", and isCollapsed is true
  When the user clicks it again
  Then the body is shown, the glyph reads "−", and isCollapsed is false
# pinned by: tests/ui/floating-window.test.ts

Scenario: Re-opening a minimised window reveals it expanded
  Given a FloatingWindow that was minimised then closed
  When it is opened again
  Then it is expanded (isCollapsed is false, body visible)
# pinned by: tests/ui/floating-window.test.ts

Scenario: Dragging never starts from the minimise button
  Given an open FloatingWindow at a known position
  When the user pointer-drags starting on the minimise button
  Then the window does not move
# pinned by: tests/ui/floating-window.test.ts

Scenario: Opening re-clamps a stale off-screen position into the viewport
  Given a FloatingWindow whose stored position is outside the current viewport
  When it is opened
  Then its left/top are clamped back inside the viewport (title bar reachable)
# pinned by: tests/ui/floating-window.test.ts

Scenario: A resize / orientation change pulls an off-screen window back into view
  Given an open FloatingWindow near the bottom/right of the viewport
  When the viewport shrinks (a resize or orientationchange fires)
  Then its left/top are re-clamped inside the new viewport
# pinned by: tests/ui/floating-window.test.ts
```

## Tests & verification

- Unit: `tests/ui/floating-window.test.ts` — `npm test`
- E2E (via the XY Pad): `e2e/xy-pad.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
