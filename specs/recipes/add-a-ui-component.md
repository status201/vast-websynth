# Recipe — add a UI component

```yaml
id: add-a-ui-component
status: implemented
version: 1
owner: core
related:
  - architecture
  - input-control
source:
  - src/ui/components/switch.ts          # reference component
  - src/ui/styles/switch.module.css
  - tests/ui/switch.test.ts
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

## Acceptance (BDD)

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
