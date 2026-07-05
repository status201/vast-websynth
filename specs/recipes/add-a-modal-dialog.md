# Recipe — add a modal dialog

```yaml
id: add-a-modal-dialog
status: implemented
version: 1
owner: core
related:
  - architecture
  - add-a-ui-component
  - add-a-floating-window
source:
  - src/ui/components/modal.ts
  - src/ui/components/record-sound-modal.ts   # worked instance
```

A repeatable **playbook**, not a feature. `Modal`
(`src/ui/components/modal.ts`) is the shared dialog: backdrop, centred card,
title, Escape-to-close, backdrop-click-to-close, and a fade lifecycle. Use it
for any transient, focus-stealing dialog (about, settings, record-a-sound).
The concrete worked instance is the record-sound modal
(`src/ui/components/record-sound-modal.ts`); `perf-settings.ts` and `help.ts`
follow the same shape.

## Background / Why

Before `Modal`, the about/start dialogs hand-rolled the same backdrop + fade +
Escape logic. `Modal` centralises it so a new dialog only supplies its title and
body. It is **single-use** (an `opened`/`closed` latch): build a fresh instance
each time it appears. Its Escape handler deliberately **beats** the global
panic handler in `shortcuts.ts` — the opposite stance from
[`FloatingWindow`](add-a-floating-window.md), which leaves Escape alone.

## Steps

### 1. Construct + fill — `src/ui/components/<dialog>.ts`

```ts
import { Modal } from './modal';

const modal = new Modal({
  title: 'Record a sound',
  cardClass: styles.wide,          // optional width/layout variant
  onClose: cleanup,                // fires exactly once — do teardown here
});
modal.body.appendChild(buildContents());   // caller appends into modal.body
```

Use the `Modal.*Class` static getters (`Modal.titleClass`, `Modal.closeBtnClass`,
…) when you need matching markup inside the body.

### 2. Open + close

```ts
modal.open();                      // mounts to document.body + reveals
// close paths: the × / a Close button (modal.close()), backdrop click, or Escape
```

### 3. Verify

```bash
npm run typecheck
npm test            # tests/ui/modal.test.ts
```

## Gotchas

- **Single-use.** Build a new `Modal` per appearance; don't cache and re-`open()`
  a closed one. (Contrast `FloatingWindow`, which is a re-openable toggle.)
- **Do teardown in `onClose`.** It fires exactly once per close (Escape,
  backdrop click, or `close()`). The record-sound modal disconnects its media
  stream / observers there — leaking those is the classic bug.
- **Escape beats panic.** `Modal` captures Escape (`stopImmediatePropagation`)
  so it closes the dialog instead of triggering the global panic handler. A
  non-modal tool must *not* do this — use `FloatingWindow` for that.
- Backdrop-click closes only when the click target *is* the backdrop (not a
  child) — handled by the component.

## Scenarios (BDD)

```gherkin
Scenario: A dialog opens, then closes and cleans up exactly once
  Given a Modal with an onClose cleanup callback
  When it is opened and then closed (× / backdrop / Escape)
  Then the card mounts and reveals, then hides, and onClose fires exactly once
# pinned by: tests/ui/modal.test.ts, e2e/mic.spec.ts
```

## Tests & verification

- `tests/ui/modal.test.ts` — the lifecycle contract (open/close/Escape/backdrop,
  `onClose` fires once).
- `e2e/mic.spec.ts` — the record-sound modal driven in a real browser.
- `npm run typecheck` / `npm test`.
