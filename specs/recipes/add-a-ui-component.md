# Recipe — add a UI component

```yaml
id: add-a-ui-component
status: implemented
version: 2
owner: core
related:
  - architecture
  - input-control
source:
  - src/ui/components/switch.ts          # reference component
  - src/ui/styles/switch.module.css
  - tests/ui/switch.test.ts
  - src/ui/components/knob.ts             # drag-scoped window listeners
  - src/ui/components/strip.ts
```

How to add a hand-built DOM component (no framework, no virtual DOM), following the
existing `ui/components/` widgets.

## Background / Why

The UI is plain `document.createElement` DOM. A component is a small class/factory
that owns an element, binds to the [`ParamBus`](../architecture.md) (never
the engine directly), and carries a **stable `data-testid`** so E2E specs can select
it despite hashed CSS-Module class names.

## Steps

### 1. The component — `src/ui/components/<name>.ts`

Model it on `switch.ts`:

```ts
import styles from '../styles/<name>.module.css';
import type { ParamBus } from '../../state/params';

export class MyControl {
  readonly el: HTMLElement;
  private unsub: () => void = () => {};
  constructor(bus: ParamBus, paramId: string, label: string) {
    this.el = document.createElement('button');
    this.el.className = styles.root!;
    this.el.dataset.testid = `mycontrol-${paramId}`;   // stable testid
    this.el.addEventListener('click', () => bus.set(paramId, /* next value */ 1));
    this.unsub = bus.subscribe(paramId, (v) => {
      this.el.classList.toggle('on', v >= 0.5);         // global state class
    });
  }
  destroy(): void { this.unsub(); }
}
```

### 2. The styles — `src/ui/styles/<name>.module.css`

CSS Modules. Reference global **state classes** (`.on`, `.active`, `.playing`) with
`:global(...)`; bridge global classes alongside module classes where global
descendant selectors target children (`className: 'switch-label ' + styles.label!`).

### 3. Mount + test

`appendChild` it where it belongs (`app.ts` or a panel). Add a jsdom unit test
(`tests/ui/<name>.test.ts`).

## Gotchas

- **Append every sub-container to the root.** Orphaned subtrees (built but never
  appended) render blank — a known past bug.
- Mint the `data-testid` at the factory level; prefer testids over button text in
  specs (capitalised text collides case-insensitively under Playwright).
- `bus.subscribe` fires immediately with the current value (so the control paints
  correctly on mount) and returns an unsubscribe — store it for `destroy()`.
- **`destroy()` must undo everything wired outside the component's own subtree** —
  bus subscriptions, `ResizeObserver`s, and window/document listeners. A listener
  added to `window`/`document` in the constructor leaks for any component that is
  ever rebuilt (e.g. the drum tuning strip rebuilds its `Knob`s on track change),
  and it keeps the (now-detached) instance alive.
- **Drag handlers on `window` must be drag-scoped.** Attach `pointermove`/
  `pointerup`/`pointercancel` on `pointerdown`; remove them on `pointerup`/
  `pointercancel` **and** in `destroy()` (removing a never-added listener is a
  no-op, so this is safe even when `destroy()` runs mid-drag). This both prevents
  the leak above and stops *every* live instance from running its move handler on
  every page pointer move — only the one being dragged listens. `knob.ts` and
  `strip.ts` are the reference implementations (`record-sound-modal.ts` and
  `floating-window.ts` follow the same shape). The rule is easy to lose in a
  helper: `step-settings.ts`'s slider once attached at construction, and because
  that row is mounted three times with three sliders each, it put **nine**
  handlers on every pointer move in the app. If a component builds several
  sub-controls, check each one.
- **Measure layout once per gesture, not once per move.** Read
  `getBoundingClientRect()` on `pointerdown` and reuse it for the stroke — the
  control cannot move mid-drag, and reading it per move forces a layout on every
  frame of the drag.
- **Guard repaints on what you write, not on the value.** A control bound to a
  param can be repainted at *frame rate* — the motion sequencer automates params
  60×/s — so cache the rounded angle / formatted string / class you last wrote and
  skip the unchanged ones, each independently. Guarding each write (rather than
  returning early from `render`) keeps the DOM exactly in step with the newest
  value. `Knob.render`, `Scope.mirrorPeak` and `StepButton.setViz` all do this;
  see [runtime-performance](../features/runtime-performance.md) REQ-7. Prefer
  `transform` over layout-triggering properties (`width`, `top`) for anything
  repainted continuously — `GrMeter` and the step-settings slider fill use
  `scaleX`.

## Scenarios (BDD)

```gherkin
Scenario: The control writes and reflects the bus
  Given a MyControl bound to paramId 'x'
  When the user interacts with it
  Then bus.set('x', …) is called
  And a later bus change repaints the control (subscribe)
# pinned by: tests/ui/<name>.test.ts (jsdom)
```

## Tests & verification

- `tests/ui/<name>.test.ts` (jsdom; no AudioContext needed), e.g. mirror
  `tests/ui/switch.test.ts`. `npm test` / `npm run typecheck`.
