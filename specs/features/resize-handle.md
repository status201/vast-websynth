# Resize handle (the shared resize grip)

```yaml
id: resize-handle
status: implemented
version: 1
owner: ui
related:
  - scope             # the first consumer: the scope row's top-edge grip
  - floating-window   # REQ-a-window-may-be-resizable builds one per resizable window
  - transport-window  # a right-edge grip (window width)
  - xy-pad            # a corner grip (the square pad)
  - runtime-performance
source:
  - src/ui/components/resize-handle.ts
  - src/ui/styles/resize-handle.module.css
```

## Background / Why

The scope's top-edge grip was built generic. It writes one CSS custom property on
a target element, reports commits, and knows nothing about what it resizes. Its
own comment said a second consumer would earn it a spec of its own. The resizable
floating windows ([floating-window](floating-window.md)
REQ-a-window-may-be-resizable) are that second consumer, and they need three
things the scope never did: other drag directions, limits that change while the
app runs (a song's length, the viewport), and an *automatic* size that is no
value at all. This spec owns the component; each consumer's spec owns its own
limits, placement and storage.

## Requirements

- **REQ-a-handle-writes-one-custom-property** — The handle sizes nothing itself.
  It writes one CSS custom property (`cssVar`) on `target` with
  `style.setProperty` (the shipped CSP allows that, but not a `style="…"`
  attribute), and the consumer's CSS reads it with its default as the fallback:
  `var(--x, <default>)`. With nothing stored or storage unavailable, the app
  therefore renders exactly as its CSS says. `aria-valuenow` mirrors the value.

- **REQ-a-handle-has-a-direction** — `direction` names the edge the grip sits on
  and so which way growth follows the pointer. Everything a direction decides —
  growth, keys, orientation, cursor, a drawn grip — is one row of `DIRECTIONS`,
  so a new direction is a new row, not a branch in four places:
  - `up` (the default, the scope): a top edge. Up is bigger; `↑` / `↓` step;
    `aria-orientation="horizontal"`; `ns-resize`.
  - `right` (a window's width): a right edge. Right is bigger; `→` / `←` step;
    `aria-orientation="vertical"`; `ew-resize`.
  - `down-right` (a square): a corner. The pointer delta of **larger magnitude**
    wins, so a drag along either edge resizes at full speed and a diagonal drag
    follows its dominant axis; `→`/`↓` grow and `←`/`↑` shrink;
    `aria-orientation="vertical"`; `nwse-resize`.

- **REQ-a-handle-may-start-automatic** — `initial: null` leaves the property
  **unset**, so the consumer's CSS default (an automatic, content-driven size)
  renders. A gesture then starts from `measure()`, the consumer's live size in
  the property's own terms, read **once at gesture start** (never per move). The
  first move writes the property, and from then on the size is the user's.

- **REQ-a-handle-may-reset-to-automatic** — With `onReset`, double-tap and
  `Home` **remove** the property (back to the CSS default), set `value` to
  `null` and call `onReset`; nothing is committed. Without `onReset`, they set
  `defaultValue` and commit, as the scope does.

- **REQ-a-handle-may-have-live-bounds** — `bounds()`, when given, takes
  precedence over the static `min`/`max`. It is read at gesture start, on each
  key press and on `refresh()`. `refresh()` clamps a set value back into the
  current bounds **without committing**, so a stored preference survives a
  smaller screen or a shorter song and returns when there is room again. When
  `max <= min` there is nothing to resize: the handle is `hidden`, and shown
  again by the next `refresh()` that finds room.

- **REQ-a-handle-commits-on-release** — `onCommit` fires on pointer release
  after a real move, and on each key that changed the value. It never fires per
  pointer move, so a consumer that stores the size writes storage once per
  gesture. Moves are coalesced to one style write per animation frame, and a
  release always flushes the final value.

- **REQ-the-handle-is-an-aria-splitter** — `role="separator"`, `tabindex="0"`,
  `aria-label`, `aria-valuemin`/`max`/`now`, kept in sync with the bounds and the
  value; the `title` names the gesture. This is also why the keyboard rows below
  exist rather than being a `—`.

## Technical design

### Contract / public interface

```ts
// src/ui/components/resize-handle.ts
interface ResizeHandleOptions {
  target: HTMLElement;              // element the custom property is written on
  cssVar: string;                   // e.g. '--scope-h'
  min: number;                      // px, inclusive — static bounds
  max: number;
  initial: number | null;           // null = unset, the CSS default renders (REQ-a-handle-may-start-automatic)
  defaultValue: number;             // what double-tap / Home reset to, when there is no onReset
  step: number;                     // px per arrow key
  onCommit(px: number): void;       // release / key commit — never per move
  testId: string;
  label: string;                    // aria-label
  title: string;                    // names the gesture
  className?: string;               // consumer-owned position + size
  direction?: 'up' | 'right' | 'down-right';  // default 'up'
  measure?(): number;               // live size when unset; read once per gesture
  bounds?(): { min: number; max: number };     // live bounds; read per gesture / key / refresh()
  onReset?(): void;                 // double-tap / Home clear to automatic instead
}

class ResizeHandle {
  readonly el: HTMLElement;
  constructor(opts: ResizeHandleOptions);
  get value(): number | null;       // null while automatic
  set(px: number): void;            // clamped; writes the property + aria-valuenow
  refresh(): void;                  // re-read bounds; clamp without commit; hide at max <= min
  destroy(): void;                  // detaches drag + key listeners, cancels a pending frame
}
```

Position and size are the consumer's, passed as `className`: only the consumer
knows what the grip must sit clear of. The component's stylesheet owns
appearance, the cursor per direction, and the focus ring.

### Gesture inventory

The [recipe](../recipes/design-an-interaction.md) step-1 artefact. A consumer's
spec adds only what differs (its limits, a deviation it takes).

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| tap / click | — a press that doesn't move leaves the size alone | — |
| drag along the direction | resize, clamped to the bounds, live | OS window edges and corners; DAW splitters |
| double-tap | reset: the default, or automatic with `onReset` | this app's knobs — double-tap resets to baseline |
| arrows (focused) | ±`step` along the direction, clamped | ARIA window-splitter pattern |
| `Home` (focused) | reset, as double-tap | same |
| long-press · right-click · `Delete` | — | — |
| Shift + drag | — 1 px per pixel is already fine | — |
| wheel | — the page or the content scrolls here | — |

`dblclick` is unreliable on touch, so double-tap is hand-rolled from
`pointerdown` timestamps on the shared `LONG_DOUBLE_TAP_MS` window
(`gesture-timing.ts`). `touch-action: none` on the grip keeps the page from
scrolling out from under a touch drag.

## Scenarios (BDD)

```gherkin
Scenario: Each direction follows the pointer the right way (REQ-a-handle-has-a-direction)
  Given a handle for each direction at 200 px
  When the up grip is dragged up 30 px, the right grip right 30 px, and the corner 30 px right and 10 px down
  Then each reads 230 px, and the corner ignored the smaller delta
  And its arrows step the same way (↑ up, → right, → and ↓ the corner)
# pinned by: tests/ui/resize-handle.test.ts

Scenario: An automatic handle starts from the measured size and resets to automatic (REQ-a-handle-may-start-automatic, REQ-a-handle-may-reset-to-automatic)
  Given a handle with initial null, measure() 300 and an onReset
  Then the custom property is unset and value is null
  When it is dragged by +20 px
  Then the property reads 320px and onCommit fired once, with 320
  When it is double-tapped
  Then the property is removed, value is null, onReset fired and nothing was committed
# pinned by: tests/ui/resize-handle.test.ts

Scenario: Live bounds clamp without committing, and hide a handle with no room (REQ-a-handle-may-have-live-bounds)
  Given a handle at 500 px whose bounds() now return { min: 200, max: 400 }
  When refresh() runs
  Then the value is 400 and onCommit did not fire
  When bounds() return { min: 300, max: 300 } and refresh() runs
  Then the handle is hidden, and a later refresh() with room shows it again
# pinned by: tests/ui/resize-handle.test.ts

Scenario: The scope's handle is unchanged (regression)
  Given a handle with no direction, bounds, measure or onReset
  Then it behaves as the scope's top-edge grip always has
# pinned by: tests/ui/resize-handle.test.ts (the existing cases, unedited)
```

## Tests & verification

- Unit: `tests/ui/resize-handle.test.ts` — `npm test`
- E2E through its consumers: `e2e/scope.spec.ts`, `e2e/transport-window.spec.ts`, `e2e/xy-pad.spec.ts`
