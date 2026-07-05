# Floating window

```yaml
id: floating-window
status: draft
version: 1
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

## Technical design

### Contract / public interface

```yaml
FloatingWindow:   # src/ui/components/floating-window.ts (a class, like Modal)
  new (opts: FloatingWindowOptions)
  readonly body: HTMLElement          # caller appends content here
  open(): void                        # idempotent; mounts + reveals
  close(): void                       # idempotent; hides, fires onClose once, removes after fade
  get isOpen(): boolean
  # static class getters (parity with Modal, for consistent markup/testing):
  static rootClass / titleBarClass / titleClass / closeBtnClass / bodyClass: string

FloatingWindowOptions:
  title: string
  testId?: string                     # data-testid on the root (default none)
  initial?: { left: number; top: number }   # start position (px); defaults centred-ish near the top
  windowClass?: string                # extra class on the root (width/layout variant)
  onClose?: () => void                # caller cleanup, once per close
```

### Layer touchpoints & ordering

```yaml
DOM: root (.root, position:fixed, z-index 950) > [ .titleBar (.title + .closeBtn), .body ]
drag: pointerdown on .titleBar -> record start pointer + window pos; window-level
      pointermove updates clamped left/top; pointerup/leave ends. setPointerCapture
      on the title bar retargets moves to it (optional-chained for jsdom).
close button: click stops propagation so it never starts a drag; calls close().
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
```

## Tests & verification

- Unit: `tests/ui/floating-window.test.ts` — `npm test`
- E2E (via the XY Pad): `e2e/xy-pad.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
