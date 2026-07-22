# Recipe — design an interaction

```yaml
id: design-an-interaction
status: implemented
version: 1
owner: core
related:
  - architecture
  - ../decisions/adr-014-dont-make-me-think
  - ../features/step-grid-editing
  - add-a-ui-component
source:
  - src/ui/components/
  - src/ui/panels/
```

A repeatable **playbook**, not a feature. Every interactive control in this app
is hand-wired DOM, so nothing stops two gestures from colliding on one target —
[ADR-014](../decisions/adr-014-dont-make-me-think.md) makes that a defect, and
this recipe is how you catch it *before* writing the listener. The concrete
worked instance is [`step-grid-editing`](../features/step-grid-editing.md).

## Background / Why

There is no framework and no design system, so a control's behaviour is whatever
its `addEventListener` calls happen to say. That is fine until one target grows a
second job — which is exactly how the step grids ended up toggling a step off
when the user only meant to select it. The fix is cheap if you enumerate the
gestures *first* and expensive once four panels have shipped the collision. Run
these six steps for anything the user points at: a new component, a new panel
control, or a new gesture on an existing one.

## Steps

### 1. Write the gesture inventory — in the spec, before the code

One row per gesture the target can receive. Fill every row, including the ones
you are not implementing: `—` is a decision, a blank is an oversight.

```markdown
| Gesture      | Outcome                          | Precedent          |
| ------------ | -------------------------------- | ------------------ |
| tap / click  | toggle on/off                    | TR-808, every DAW  |
| drag         | paint !first.on across cells     | FL Studio, Ableton |
| long-press   | select only (no toggle)          | Elektron, Push     |
| right-click  | select only (desktop alias)      | —                  |
| double-tap   | — (no-op: tap already toggles)   | —                  |
| wheel        | ±1 semitone (seq only)           | —                  |
| Delete / ⌫   | clear the selected step          | DAW piano roll     |
```

Then check the inventory against **law 2**: no two rows may produce different
outcomes for the same gesture depending on state. If they do, split the jobs
across gestures — not across a mode.

### 2. Look up precedent before inventing — hardware first

Order matters ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 4):
groovebox/synth hardware, then DAWs and VST plug-ins, then invent. Record what
you found in the `Precedent` column, and if the cell is `—`, say in the spec why
nothing applied. The house references:

```yaml
step toggle:      Roland TR-808/909 · every drum machine ever built
hold-to-edit:     Elektron (parameter locks) · Ableton Push (step detail view)
paint-drag:       FL Studio · Ableton · Logic (piano roll draw)
motion recording: Korg Electribe · MPC 16 Levels
patch vs bank:    Roland JX/Juno (PATCH = 1 sound, BANK = many) · Yamaha DX7 (VOICE)
momentary FX:     Pioneer DJM (filter, tape stop) · Kaoss Pad (XY)
```

### 3. Wire it once, in the shared layer — not per panel

If two or more panels need the gesture, it belongs in a component or in
`ui/panels/step-panel-scaffold.ts`, never copy-pasted. Use **Pointer Events**
(not mouse + touch pairs) so one code path serves both, and mint the `data-testid`
at the factory level so E2E can select it (CSS Module class names are hashed).

```ts
el.addEventListener('pointerdown', (e) => { /* one path for mouse + touch */ });
el.setPointerCapture?.(e.pointerId);   // optional-call: jsdom has no capture
```

### 4. Give it the discoverability triple

Self-evident first (law 1), then in descending order of reach — a gesture that
has none of these does not exist for the user:

```yaml
title:      every interactive element (the tooltip states the gesture, not the noun)
help badge: ui/onboarding/help-content.ts, for anything non-obvious   # onboarding.md REQ-3
tour step:  ui/onboarding/, only for gestures on the primary path     # add-a-tour-step.md
```

### 5. Make it reversible, then make it touch-safe

```yaml
destructive?  route it through a PatternStore mutation entry point so PatternUndo
              records it; a BULK change must emit ONE bulk mutation (the *-copy
              kinds carry a whole-bank `before`), never N per-cell ones
feedback:     showToast({ message, actionLabel: 'Undo', onAction })  # toast.md
touch:        hit target >= 44px · no hover-only affordance · e.preventDefault()
              on pointerdown to stop scroll-vs-drag fights
```

### 6. Verify

```bash
npm run typecheck   # primary gate
npm test            # a jsdom test per inventory row
npm run e2e         # the gesture on the real panel
```

## Gotchas

- **`dblclick` is unreliable on touch.** Detect double-tap by hand off
  `pointerdown` timestamps (`MotionStepPad` does, with a 350 ms window). Also
  check double-tap is not already taken: knobs use it for reset-to-baseline
  ([param-reset-baseline](../features/param-reset-baseline.md)) and motion pads
  use it to clear an anchor.
- **A long-press must cancel on movement**, or every drag fires it at the start.
  Cancel the timer once the pointer travels past a small slop threshold.
- **`contextmenu` needs `preventDefault()`** or the browser menu eats a
  right-click gesture — and never make right-click the *only* route to a
  behaviour (law 6: there is no right-click on a phone; pair it with long-press).
- **Pointer capture routes all later events to the captured element**, so a drag
  that must cross siblings (grid painting) needs `document.elementFromPoint` to
  find the cell under the pointer rather than reading `e.target`.
- **jsdom has no `setPointerCapture`, no layout, and no `PointerEvent` in older
  versions.** Call it optionally (`?.`), and in tests stub
  `getBoundingClientRect` when geometry matters.
- **A mode must die with its context** (law 5) — scope it to panel visibility
  and to `PatternStore.onBulkRestore`, the way `Step Input` does
  ([sequencer](../features/sequencer.md) REQ-5). A mode that outlives its screen
  is the bug that rule exists to prevent.

## Scenarios (BDD)

```gherkin
Scenario: A new gesture does not collide with an existing one
  Given a control that already toggles on tap
  When a second job (select-for-edit) is added to it
  Then the new job takes a DIFFERENT gesture (long-press / right-click)
  And tap keeps exactly one outcome, whatever the state
# pinned by: tests/ui/grid-gestures.test.ts

Scenario: A bulk destructive action costs one undo
  Given a grid with many active steps
  When the user clears the whole bank
  Then a single undo entry restores every cleared step
  And a toast offers Undo directly
# pinned by: tests/state/pattern-undo.test.ts, tests/state/patterns.test.ts
```

## Tests & verification

- `tests/ui/grid-gestures.test.ts` — the inventory rows, in jsdom.
- `tests/state/pattern-undo.test.ts` — bulk actions collapse to one entry.
- `e2e/patterns.spec.ts` — the gestures against the real panels.
- `npm run typecheck` / `npm test` / `npm run e2e`.
