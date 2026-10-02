# Keyboard range and key size (octaves follow the width, height follows the key)

```yaml
id: keyboard-range
status: implemented
version: 2   # v2: REQ-key-height-follows-key-width + REQ-spare-height-goes-to-the-scope — the key
             #     height is bounded by the key width; spare height goes to the scope
owner: core
related:
  - input-control            # the on-screen keyboard this sizes; the lit-key rules it keeps
  - responsive-synth-panels  # the other width-driven layout rules
  - scale-quantization       # the key roles a rebuild must re-apply
  - scope                    # takes the height the keyboard does not (REQ-spare-height-goes-to-the-scope)
  - equalizer                # the third item of the same bottom column
source:
  - src/ui/keyboard-range.ts
  - src/ui/components/keyboard.ts
  - src/ui/app.ts            # buildBottom: the ResizeObserver that drives it
  - src/ui/styles/bottom.module.css  # .bottom / .bottomTop / .keyboardWrap: the height bounds
```

How many octaves the on-screen keyboard draws, which ones — and how tall its
keys may get.

## Background / Why

The keyboard used to draw a fixed 3 octaves (C3–B5; 2 on a phone) and stretch
them across the full width. That is right up to a 2560px screen — a white key
there is ~118px, about the proportion of a real one at the ~520px height a
1440p screen gives the keyboard. On a 5120×1440 ultrawide the same 21 white
keys came out ~240px wide with ~145px black keys: slabs, not keys.

Capping the width and centring the keys was tried in a mockup and rejected — it
leaves a dead band either side of the faceplate's widest panel. Adding octaves
keeps the keys looking like keys *and* gives a wide screen something for its
width: more range to play.

The same proportion broke vertically (v2). The keyboard was the bottom grid's
`minmax(160px, 1fr)` track, so it took **all** spare height: with FX and
Machines folded on a 2739×1330 screen a key stood 7.2× as tall as it was wide —
long piano keys — and with the Song tab open about 1.4× — little 303 keys. The
1440p default layouts that looked right sit at 4.3–4.6×. So the height is now
bounded by the width, and what the keyboard cannot use goes to the scope, which
has a use for it.

## Requirements

- **REQ-the-range-follows-the-width** — The octave count is the fewest that
  keeps a white key no wider than `MAX_WHITE_PX` (120px — the 2560 look):
  `max(base, ceil(width / (7 × MAX_WHITE_PX)))`, where `width` is the width the
  keys are laid out in (the keyboard's content box) and `base` is 2 on a phone
  (`(max-width: 767px)`) and 3 otherwise. So every screen up to ~2560px keeps
  exactly the range it had; 3440×1440 gets 4 octaves and 5120×1440 gets 6.
- **REQ-the-range-grows-down-first** — Added octaves go **down first, then
  alternate**, so the bass arrives first and middle C stays near the centre:

  | octaves | range |
  | --- | --- |
  | 2 | C4–B5 |
  | 3 | C3–B5 |
  | 4 | C2–B5 |
  | 5 | C2–B6 |
  | 6 | C1–B6 |

- **REQ-the-range-never-exceeds-midi** — At most `MAX_OCTAVES` (6). The OCT
  strip (`keyboard.transpose`, ±2) shifts every key by up to 24 semitones; a
  seventh octave (to B7 = 107) would sound 131 at OCT +2, past MIDI's 127. C1–B6
  at ±2 spans 0–119. Past the cap the keys simply widen again.
- **REQ-a-resize-rebuilds-only-on-a-change** — The range is re-derived when the
  keyboard is resized (a `ResizeObserver` on its element — no layout read on a
  hot path, runtime-performance.md), and the keys are rebuilt **only** when the
  derived range differs from the drawn one. A resize that keeps the octave count
  touches no key element.
- **REQ-a-rebuild-strands-nothing** — A rebuild may not strand a note or a
  light:
  - a key held by a **pointer** is released first (its `noteOff`, naming the
    note it sounded — input-control.md REQ-a-note-off-names-the-pressed-note),
    since the element under the finger is about to be replaced;
  - a key lit by the computer keyboard, MIDI or the sequencer keeps its light
    and refcount, re-resolved onto the new element that sounds that note (or
    kept off-board if the new range doesn't draw it) — the light-off still
    lands (input-control.md REQ-a-lit-key-is-remembered-as-an-element);
  - the current key roles (scale-quantization.md REQ-the-key-is-shown-where-you-play)
    and the octave labels are re-applied.
- **REQ-key-height-follows-key-width** — (v2) A white key is **at least 1.6×
  and at most 4.5× as tall as it is wide**, over the keyboard row's standing
  160px floor, which wins wherever the key is narrow (laptops, tablets, phones):

  ```text
  row min = max(160px, 1.6 × keyW + 30px)
  row max = max(160px, 4.5 × keyW + 30px)
  ```

  keyW is the white-key column (the keys' content width ÷ drawn white keys —
  the key plus its 1px margin either side) and
  30px is the keyboard's own chrome (wrap padding 2×8 + border 2×1 + keys
  padding 2×6). 1.6× is exactly what a 1920×1080 screen's default layout already
  gives (85×132px), so nothing that fits today starts to scroll; 4.5× is the
  1440p default layout the user judged right. Within the two bounds the keyboard
  still fills — it is a band, not a fixed height.
- **REQ-spare-height-goes-to-the-scope** — (v2) **The keyboard takes spare
  height first, up to its cap; the scope takes the rest.** `.bottom` is a flex
  column — scope row, EQ section, keyboard — where the keyboard has a far larger
  `flex-grow` (1000 to the scope row's 1), so it wins the spare outright until
  `max-height` freezes it, and the flex algorithm hands the remainder to the
  scope. The scope row's `min-height` is `--scope-h`, so the resize handle's
  height (scope.md REQ-a-scope-resize-handle) is the scope's **minimum**: while
  the keyboard is capped the scope may stand taller than the handle says, and a
  drag smaller shows nothing until the spare is gone.
  - **Why flex, not the grid it was.** A `minmax(min, max)` track grows to its
    max whenever the grid's height comes from its content — and `.app`'s does
    (a `min-height`, not a `height`) — so the page grew to fit a maxed keyboard
    and scrolled instead of the keyboard giving way. Flex items size from their
    `flex-basis` (0) and floors, so `.bottom` asks only for its minimums and
    fills what the viewport has on top of that.
  - **When there is no spare** — anything expanded on a short screen — every
    item sits at its floor and the page scrolls, as before: the keyboard is
    never squeezed below its floor or out of reach.

## Technical design

### Contract / public interface

```ts
// src/ui/keyboard-range.ts — pure, no DOM
export const MAX_WHITE_PX = 120;
export const MAX_OCTAVES = 6;
export const WHITES_PER_OCTAVE = 7;                 // the one place the geometry counts them
export interface KeyboardRange { startOctave: number; octaves: number }
export function keyboardRange(widthPx: number, phone: boolean): KeyboardRange;
export function whiteKeyPx(widthPx: number, octaves: number): number;  // v2: whole px, ≥ 0

// src/ui/components/keyboard.ts
class Keyboard {
  setRange(range: KeyboardRange): void;   // no-op when unchanged
}
```

### Layer touchpoints & ordering

```yaml
ui/app.ts buildBottom: constructs the Keyboard at keyboardRange(0, isPhone()) — the
  base range, since nothing is laid out yet — then a ResizeObserver on keyboard.el
  calls setRange(keyboardRange(contentRect.width, isPhone())). The observer fires
  after layout and before paint, so a wide screen never paints the base range.
ui/components/keyboard.ts: owns the rebuild (REQ-a-rebuild-strands-nothing); the
  range rule itself stays out of the component.
ui/app.ts buildBottom (v2): the same observer writes --kb-key-w (whole px, and only
  when it changes) on .bottom. Width never depends on height, so it cannot loop.
ui/styles/bottom.module.css (v2): .bottom is a flex column; .bottomTop
  flex 1 1 0 + min-height var(--scope-h, 130px); .keyboardWrap flex 1000 1 0 with
  the REQ-key-height-follows-key-width min/max-height read from --kb-key-w. Until
  the first observation the var is unset: the min falls back to the 160px floor
  and the max to no cap — the observer runs before first paint.
```

## Scenarios (BDD)

```gherkin
Scenario: An ordinary screen keeps its range
  Given the keys are laid out in 1852px (1920 wide) or 2462px (2560 wide)
  Then the keyboard draws 3 octaves, C3–B5
# pinned by: tests/ui/keyboard-range.test.ts

Scenario: An ultrawide gets more keys, not wider ones
  Given the keys are laid out in 5022px (5120×1440)
  Then the keyboard draws 6 octaves, C1–B6, and no white key is wider than 120px
# pinned by: tests/ui/keyboard-range.test.ts

Scenario: A phone keeps its two octaves
  Given a phone viewport
  Then the keyboard draws C4–B5
# pinned by: tests/ui/keyboard-range.test.ts

Scenario: The range is capped below MIDI's ceiling (edge)
  Given the keys are laid out in 7600px
  Then the keyboard draws 6 octaves
# pinned by: tests/ui/keyboard-range.test.ts

Scenario: A resize that keeps the count rebuilds nothing
  Given the keyboard draws 3 octaves
  When setRange is called with the same range
  Then every key element is the same element as before
# pinned by: tests/ui/keyboard.test.ts

Scenario: Growing the range mid-hold strands nothing (edge)
  Given a pointer holds C4 and the computer keyboard lights E4
  When the range grows from 3 to 4 octaves
  Then C4 receives exactly one noteOff
  And the new E4 element is lit, and releasing E4 clears it
# pinned by: tests/ui/keyboard.test.ts

Scenario: Folded panels cap the keys and grow the scope (REQ-key-height-follows-key-width)
  Given a 2739x1330 viewport with FX and Machines folded
  Then a white key stands no more than 4.5x as tall as it is wide
  And the scope is taller than its 130px handle height
# pinned by: e2e/keyboard-height.spec.ts

Scenario: A 1440p default layout is unchanged
  Given a 2560x1440 viewport with the default panels open
  Then a white key stands ~4.3x as tall as it is wide and the scope is 130px
# pinned by: e2e/keyboard-height.spec.ts

Scenario: Full HD keeps its keyboard on screen
  Given a 1920x1080 viewport with the default panels open
  Then a white key stands at least 1.6x as tall as it is wide
  And the keyboard ends inside the viewport
# pinned by: e2e/keyboard-height.spec.ts

Scenario: A narrow key keeps the 160px floor (edge)
  Given a 1440x900 viewport with the default panels open
  Then the keyboard row is 160px — its keys 130px — the floor, not 1.6x
# pinned by: e2e/keyboard-height.spec.ts

Scenario: No spare height means the page scrolls, not the keys shrinking (edge)
  Given everything is expanded on a 1920x1080 viewport
  Then the keys are at their minimum and the page scrolls
# pinned by: e2e/keyboard-height.spec.ts
```

## Tests & verification

- `tests/ui/keyboard-range.test.ts` — the width → range table and the cap;
  `whiteKeyPx`; and (v2) the 30px chrome in REQ-key-height-follows-key-width,
  pinned to the paddings and border it is the sum of, read from both stylesheets.
- `tests/ui/keyboard.test.ts` — `setRange`: key count, no-op identity, the
  mid-hold release, lit keys and roles carried across.
- `e2e/keyboard-height.spec.ts` — the key-height band and where the spare goes
  (v2), measured in a real browser: flex sizing is invisible to jsdom.
- By eye, on a real ultrawide (and a window dragged across the 3440 threshold
  while a key is held): the keys should read as keys.

## Open questions / future

- The octave labels (8px) are small at every size; scaling them with the key
  width is a separate polish.
