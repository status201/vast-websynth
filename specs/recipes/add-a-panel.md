# Recipe — add a panel

```yaml
id: add-a-panel
status: implemented
version: 1
owner: core
related:
  - architecture
  - ../decisions/adr-009-ui-depends-on-studio-api-facade.md
  - add-a-ui-component
source:
  - src/ui/panels/seq-panel.ts        # reference panel
  - src/ui/app.ts                     # buildPatternRow registers the tab
  - src/ui/components/tabs.ts
  - src/ui/studio-api.ts
```

A repeatable **playbook**, not a feature. A *panel* is a larger UI section
(`src/ui/panels/*.ts`) that composes many components into one tab of the
pattern row. The seven existing panels (`arp`, `key`, `seq`, `drums`, `sampler`,
`motion`, `song` — that is also their tab order) all follow one shape: a
`build<Name>Panel(...)` factory returning a root element, registered as a
`TabContainer` tab in `app.ts`. The concrete worked instance is
[`seq-panel`](../features/sequencer.md) (`src/ui/panels/seq-panel.ts`).

Two files in that directory are **not** pattern-row panels and are not what this
recipe builds: `lfo-panel.ts` is a synth *faceplate* panel (it pages internally
via `createPanelTabs` — [panel-tabs](../features/panel-tabs.md)) appended straight
to `main`, and `step-panel-scaffold.ts` is the shared skeleton the four step-grid
panels (`seq`, `drums`, `sampler`, `motion`) are built from, not a tab of its own.

## Background / Why

Panels are the composition layer above `ui/components/`. They read transport and
pattern state through the narrow [`StudioApi`](../../src/ui/studio-api.ts) facade — **never
the concrete `Engine`** ([ADR-009](../decisions/adr-009-ui-depends-on-studio-api-facade.md)) —
and bind controls to the [`ParamBus`](../architecture.md) like any component. A
panel becomes visible by being handed to the `TabContainer` in `app.ts`; nothing
else wires it.

## Steps

### 1. The panel factory — `src/ui/panels/<name>-panel.ts`

Model it on `buildSeqPanel`. Take `bus` plus, if it needs transport/pattern
state, `engine: StudioApi` (arp-panel takes only `bus`; song-panel also takes a
`PresetSession` + `XyPadStore`):

```ts
import layout from '../styles/layout.module.css';
import type { ParamBus } from '../../state/params';
import type { StudioApi } from '../studio-api';
import { Switch } from '../components/switch';

export function buildMyPanel(bus: ParamBus, engine: StudioApi): HTMLElement {
  const root = document.createElement('div');
  root.className = `${layout.patternPanel!} my-panel`;   // stable class for tests
  const header = document.createElement('div');
  header.className = layout.patternPanelHeader!;
  header.appendChild(new Switch(bus, 'my.on', 'my').el);
  root.appendChild(header);                              // append EVERY sub-container
  // …compose components bound to the bus; read state via `engine` (StudioApi)…
  return root;
}
```

### 2. Register it as a tab — `src/ui/app.ts`

Add an entry to the `TabContainer` in `buildPatternRow`. `id` mints the
`tab-<id>` / `panel-<id>` testids:

```ts
const tabs = new TabContainer([
  // …existing tabs…
  { id: 'my', label: 'My Panel', content: buildMyPanel(bus, engine) },
], 'arp', { collapsibleStoreKey: 'websynth.ui.collapsed.pattern', collapsedByDefault: isCompact });
```

### 3. Verify

```bash
npm run typecheck
npm run e2e         # e2e/controls.spec.ts sees the new tab/panel
```

## Gotchas

- **Depend on `StudioApi`, not `Engine`** ([ADR-009](../decisions/adr-009-ui-depends-on-studio-api-facade.md)).
  If the panel needs something the facade doesn't expose, widen `studio-api.ts`
  rather than reaching for the concrete engine.
- **`appendChild` every sub-container to the root.** A built-but-unappended
  subtree renders blank — the known `drum-panel` bug (see `src/ui/CLAUDE.md`).
- Style with a `*.module.css` and the shared `layout.patternPanel` /
  `patternPanelHeader` classes; reference global state classes (`.on`,
  `.active`) via `:global(...)`.
- **Group effect groups into `layout.fxCluster`.** If the panel has inline
  `fxGroup(...)`s, append them to one `.fxCluster` div rather than straight to
  the header — the header wraps, and the cluster is what keeps the break
  between machine controls and FX instead of mid-cluster
  ([responsive-machine-header](../features/responsive-machine-header.md)).
  Machine controls stay direct children of the header.
- The `TabContainer` wraps content in a `panel-<id>` shell and toggles a
  `visible` class — don't set `display` on your root in a way that fights it.
- **Has a mode that must not act off-screen?** (a record arm, a capture of global
  input, an animation loop.) Return a handle from your builder — `{ el, … }`
  instead of the bare root — and in `buildPatternRow` gate it on
  `tabs.onViewChange(() => { if (!tabs.isVisible('my')) … })`. `isVisible` accounts
  for both the active tab and the row's fold state. The sequencer's Step Input is
  the worked example ([sequencer](../features/sequencer.md) REQ-5); a panel built
  *before* the `TabContainer` exists cannot hold a reference to it, so this wiring
  belongs in `app.ts` next to `bridge.showTab`.

## Scenarios (BDD)

```gherkin
Scenario: A registered panel appears as a selectable tab
  Given buildMyPanel is added to the TabContainer with id 'my'
  When the app renders the pattern row
  Then a tab-my button shows it and clicking it reveals panel-my
# pinned by: tests/ui/tabs.test.ts, e2e/controls.spec.ts
```

## Tests & verification

- `tests/ui/tabs.test.ts` — the tab activate/visibility contract the panel
  relies on.
- `e2e/controls.spec.ts` — the pattern row + panels driven in a real browser.
- `npm run typecheck` / `npm run e2e`.
