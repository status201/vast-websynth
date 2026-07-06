# Recipe — add a floating window

```yaml
id: add-a-floating-window
status: implemented
version: 1
owner: core
related:
  - architecture
  - ../features/floating-window.md
  - add-a-ui-component
  - add-a-modal-dialog
source:
  - src/ui/components/floating-window.ts
  - src/ui/panels/song-panel.ts        # the launcher (worked instance)
```

A repeatable **playbook**, not a feature. `FloatingWindow`
(`src/ui/components/floating-window.ts`) is a reusable **non-modal** draggable
window: use it whenever a tool must hover over the synth while the instrument
underneath stays fully interactive. The launcher ceremony (a toggle button that
lazily builds the window and holds it alive across closes) is the same every
time. The concrete worked instance is the XY Pad launcher
(`buildXyPadLauncher` in `src/ui/panels/song-panel.ts`); see
[`floating-window`](../features/floating-window.md).

## Background / Why

`FloatingWindow` is the sibling of [`Modal`](add-a-modal-dialog.md): same
fade/lifecycle idiom, but no backdrop and no Escape binding, so it never
intercepts pointer events on the synth and never steals the panic key. Unlike
single-use `Modal`, one `FloatingWindow` instance is a **re-openable toggle** —
so the launcher builds it once and reuses it, keeping the tool's live state
(and any `ParamBus` bindings) alive while hidden.

## Steps

### 1. Build the tool as a component — `src/ui/components/<tool>.ts`

Follow [add-a-ui-component](add-a-ui-component.md): a factory/class exposing an
`el` (and a `destroy()` if it subscribes to the bus). This is the content that
goes *inside* the window; it knows nothing about the window.

### 2. Add a launcher toggle — `src/ui/panels/<panel>.ts`

Model it on `buildXyPadLauncher`. Build the window lazily on first open and keep
the instance so its live state survives close→open:

```ts
function buildToolLauncher(bus: ParamBus, store: ToolStore): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = 'Tool';
  b.dataset.testid = 'perf-tool';            // stable testid
  let win: FloatingWindow | null = null;
  b.addEventListener('click', () => {
    if (win?.isOpen) { win.close(); return; }
    if (!win) {
      win = new FloatingWindow({
        title: 'Tool',
        testId: 'tool-window',
        onClose: () => b.classList.remove('on'),   // reflect closed state
      });
      win.body.appendChild(createTool(bus, store).el);
    }
    win.open();
    b.classList.add('on');
  });
  return b;
}
```

**Optional — a title-bar control (`leading`).** To put a caller-owned button in
the **top-left of the title bar** (e.g. a settings/gear toggle), have the tool
component expose that element and pass it as `leading`. Build the content
**before** the window so the element exists:

```ts
const tool = createTool(bus, store);          // exposes { el, gear, destroy }
win = new FloatingWindow({
  title: 'Tool', testId: 'tool-window',
  leading: tool.gear,                         // inserted before the title
  onClose: () => b.classList.remove('on'),
});
win.body.appendChild(tool.el);
```

`FloatingWindow` stops the leading control's `pointerdown` so clicking it never
starts a window drag (same guard as the ✕ button). The worked instance is the XY
Pad's gear, which collapses its axis dropdowns — see
[`xy-pad`](../features/xy-pad.md).

### 3. Verify

```bash
npm run typecheck   # primary gate
npm test            # tests/ui/floating-window.test.ts
npm run e2e         # e2e/xy-pad.spec.ts drives the toggle end-to-end
```

## Gotchas

- **Non-modal on purpose.** No backdrop is created and Escape is *not* bound —
  Escape belongs to the global panic handler (floating-window REQ-4). If you
  need a dimmed, click-blocking dialog, use [`Modal`](add-a-modal-dialog.md)
  instead.
- **Reuse the instance.** Build the window once and toggle `open()`/`close()`;
  don't `new` it per click — that discards live state and defeats REQ-2.
- **z-index tier is 950** — above panels (~100), below `Dropdown`/`Modal`
  (1000), so a `Dropdown` opened inside the window still renders on top.
- The title-bar drag is **viewport-clamped**; the ✕ button stops propagation so
  clicking it never starts a drag. Both are handled by the component — you don't
  wire them.
- A **`leading`** control (optional) renders as the title bar's first child, left
  of the title; its `pointerdown` is stopped for you. Build your content before
  the window so the element exists to pass in.

## Scenarios (BDD)

```gherkin
Scenario: The launcher toggles a re-openable non-modal window
  Given a launcher button bound to a FloatingWindow
  When the button is clicked, then clicked again
  Then the window opens (content mounts) and then closes, with no backdrop ever added
# pinned by: tests/ui/floating-window.test.ts, e2e/xy-pad.spec.ts
```

## Tests & verification

- `tests/ui/floating-window.test.ts` — the component contract (toggle, no
  backdrop, drag, Escape ignored, idempotent close).
- `e2e/xy-pad.spec.ts` — the launcher pattern driven in a real browser.
- `npm run typecheck` / `npm test` / `npm run e2e`.
