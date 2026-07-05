# XY Pad

```yaml
id: xy-pad
status: draft
version: 1
owner: core
related:
  - architecture
  - floating-window
  - song-mode
  - performance
source:
  - src/state/xy-pad.ts                 # XyPadStore (axis assignment, pure)
  - src/ui/components/xy-pad.ts          # the pad surface + assign dropdowns
  - src/ui/styles/xy-pad.module.css
  - src/ui/components/floating-window.ts # the host window
  - src/ui/panels/song-panel.ts          # the "XY Pad" launch button
  - src/state/song.ts                    # SongFile v3 persistence of the assignment
```

## Background / Why

A Kaoss-pad-style **XY controller**: a draggable square whose two axes are each
assignable to **any** `ParamBus` parameter. Dragging inside drives both params
from the pointer coordinates; it is a *momentary* performance control (like the
Song-tab DJ FX) — on gesture end both params **spring back** to where they were,
so it colours a moment without permanently editing the patch. It opens in a
non-modal [FloatingWindow](floating-window.md) so you can still play the keyboard
and turn knobs while sweeping it. No engine/audio change is needed: assignable
params drive the live graph through the **existing** `bus.subscribe` wiring the
same way `fx.djfilter` already does.

## Requirements

- **REQ-1** — A button in the Song tab's **Live FX** row (`perf-xypad`) toggles a
  non-modal floating window containing the pad. The app stays interactive while it
  is open.
- **REQ-2** — **Assignable axes**: two dropdowns (X and Y), each seeded from
  `bus.ids()`, choose the param each axis drives. The assignment lives in a small
  pure store, `XyPadStore`; defaults are X = `filter.cutoff`, Y = `filter.resonance`.
- **REQ-3** — **Drag drives both params through the taper**: pointer position
  normalises to `nx = x/width`, `ny = 1 - y/height` (up = more), then
  `bus.set(id, fromNorm(def, n))` per axis. The dot renders from the live value via
  `toNorm`, so the correct taper (e.g. `filter.resonance`'s `power` curve) is
  honoured in both directions — never a linear approximation.
- **REQ-4** — **Spring-back (momentary)**: on gesture end both params ramp back to
  their pre-gesture values over ~180 ms (rAF, eased `1-(1-k)²`, exact snap at the
  end). Restarting a gesture mid-ramp cancels the ramp and **keeps the original
  `pre`** (so a flurry of gestures still returns to the true starting point, not a
  half-sprung one).
- **REQ-5** — **Trackpad two-finger scroll**: a `wheel` gesture over the pad nudges
  the dot without clicking (`nx += deltaX·K`, `ny -= deltaY·K`, `K ≈ 1/400`); a
  visible hint (`xypad-hint`) advertises it. A wheel gesture ends — and springs
  back — when the pointer **leaves** the pad (`pointerleave`).
- **REQ-6** — **Persistence**: the axis assignment is saved in songs via SongFile
  **v3** (an additive, optional `xy` field). Loading a file without it restores the
  defaults. Only the *assignment* persists — live dragging is momentary and never
  written.

## Technical design

### Contract / public interface

```yaml
XyPadStore:   # src/state/xy-pad.ts (pure — no DOM, no bus, no localStorage)
  get(): XyAssign                      # returns a copy
  set(partial: Partial<XyAssign>): void  # fires onChange ONLY when x or y actually changes
  onChange(cb: (a: XyAssign) => void): () => void   # returns an unsubscribe
XyAssign: { x: string; y: string }     # ParamBus ids
XY_DEFAULT_ASSIGN: { x: 'filter.cutoff', y: 'filter.resonance' }

createXyPad(bus: ParamBus, xy: XyPadStore): { el: HTMLElement; destroy(): void }
  # builds the window content; destroy() aborts any gesture (snap to pre),
  # unsubscribes the bus + store, and destroys the dropdowns.
```

### Gesture state machine

```yaml
state: 'idle' | 'drag' | 'wheel'
pre:   { x, y } | null                 # raw param values captured at gesture start
rampRaf: number                        # active spring-back rAF handle (0 = none)

startGesture(next):
  if rampRaf != 0: cancelRamp()        # mid-ramp restart -> KEEP existing pre
  else:            pre = { x: bus.get(ax), y: bus.get(ay) }
  state = next

drag:  pointerdown -> startGesture('drag') + apply; pointermove (while 'drag') -> apply;
       pointerup / pointercancel -> springBack()
wheel: wheel -> if 'drag' ignore; else startGesture('wheel') + seed nx/ny from toNorm;
       nudge + apply. { passive:false } so preventDefault() stops the page scrolling.
leave: pointerleave -> springBack() ONLY when state === 'wheel' (a captured drag also
       fires leave, but a drag ends on pointerup, not on leaving the surface)

apply(nx, ny): bus.set(ax, fromNorm(def_x, clamp01(nx)));
               bus.set(ay, fromNorm(def_y, clamp01(ny)))
springBack(): rAF ramp raw pre over ~180 ms, eased 1-(1-k)^2, then exact snap;
              state -> 'idle' immediately (rampRaf tracks the in-flight ramp)
```

### Axis reassignment

```yaml
dropdown.onChange(v) -> xy.set({ x|y: v })          # the store is the single writer
xy.onChange(a) -> dd.setValue(a.x/.y); if changed:
    abortGesture()      # snap the OLD axis to pre, cancel ramp
    ax/ay = a.x/a.y
    re-subscribe the dot to the new params (bus.subscribe fires immediately -> repaint)
# a song load calls xyStore.set(...) too, so it flows through the SAME path
# (dropdowns + dot follow the loaded assignment while the window is open).
```

### Dot rendering

The dot subscribes to the two assigned params via `bus.subscribe` (fires
immediately, so it self-positions on open and re-subscribe). Position:
`left = toNorm(def, value)·100%`, `top = (1 - toNorm(def, value))·100%`. Because
spring-back and drag both go through `bus.set`, the dot tracks for free.

### Persistence (SongFile v3)

```yaml
SongFile.version: 1 | 2 | 3
SongFile.xy?: { x: string; y: string }        # v3, optional -> v1/v2 files still load
Song.capture(bus, patterns, arr, name, xy?): writes version 3; includes `xy` only when passed
Song.apply(file, bus, patterns, arr, xyStore?): ends with xyStore?.set(file.xy ?? XY_DEFAULT_ASSIGN)
compactSongForExport: copies `xy` through verbatim when present (else omitted)
song-validate: version ∈ {1,2,3}; if `xy` present require { x: non-empty string, y: non-empty string }
               (param-id *existence* is NOT validated — a stale id just falls back to a default def at use)
JSON schema (public/schema/websynth-song.schema.json): version.enum [1,2,3]; xy object (required x/y strings)
NOT persisted: the live dragged values (momentary); the window open/closed state.
```

The assignment is UI/persistence state the Engine does not own, so `XyPadStore` is
threaded `main.ts → mountApp → buildSongPanel` alongside `PresetSession`, **not**
through `StudioApi` ([ADR-009](../decisions/adr-009-ui-depends-on-studio-api-facade.md)) —
the window may be closed during a save/load, so the store stands alone.

## Visual aids

```
FloatingWindow "XY Pad"
 ┌───────────────────────────┐
 │ X: [filter.cutoff  ▾]     │   two assign dropdowns (bus.ids())
 │ Y: [filter.resonance ▾]   │
 │ ┌───────────────────────┐ │
 │ │            •          │ │   surface (~220px square); dot = toNorm(value)
 │ │                       │ │   drag / two-finger scroll -> bus.set(fromNorm)
 │ └───────────────────────┘ │
 │ two-finger scroll to nudge│   hint (xypad-hint)
 └───────────────────────────┘
```

Testids: `xypad-window` (the FloatingWindow root), `xypad-assign-x`,
`xypad-assign-y`, `xypad-surface`, `xypad-dot`, `xypad-hint`, launch `perf-xypad`.

## Scenarios (BDD)

```gherkin
Scenario: Dragging drives both assigned params through their tapers
  Given the pad is open with X=filter.cutoff, Y=filter.resonance
  When the user drags to 75% across and 75% up a 200x200 surface
  Then bus.get('filter.cutoff') === fromNorm(cutoffDef, 0.75)
  And bus.get('filter.resonance') === fromNorm(resDef, 0.75)   # power taper honoured
# pinned by: tests/ui/xy-pad.test.ts, e2e/xy-pad.spec.ts

Scenario: Releasing springs both params back to their pre-gesture values
  Given a drag moved cutoff + resonance away from their start
  When the pointer is released
  Then both params ramp back and settle exactly at the pre-gesture values
# pinned by: tests/ui/xy-pad.test.ts, e2e/xy-pad.spec.ts

Scenario: A gesture restarted mid-ramp still springs back to the true start
  Given a drag moved cutoff, was released, and its spring-back ramp is half-done
  When a new gesture starts (cancelling the ramp) and is then released
  Then the ramp completes to the ORIGINAL pre-gesture value, not the half-sprung one
# regression: springBack cleared `pre` before the ramp, so a mid-ramp restart lost it
# pinned by: tests/ui/xy-pad.test.ts

Scenario: Two-finger scroll nudges without a click and prevents page scroll
  Given the pad is open
  When a cancelable wheel event fires over the surface
  Then both params move and the event is defaultPrevented
# pinned by: tests/ui/xy-pad.test.ts

Scenario: Leaving the pad ends a wheel gesture but a drag ends on release
  Given a wheel gesture is active
  When the pointer leaves the surface
  Then the params spring back
  But a pointerleave during an active drag does NOT spring back
# pinned by: tests/ui/xy-pad.test.ts

Scenario: The launch button toggles a non-modal window and the app stays live
  Given the Song tab is open
  When the user clicks the XY Pad button
  Then a floating window appears and the transport Play button is still clickable
# pinned by: e2e/xy-pad.spec.ts

Scenario: Axis assignment round-trips through a song (v3)
  Given the user reassigns X to lfo.rate and saves the song
  When a new song is started and the saved slot is loaded
  Then the XY Pad's X axis is lfo.rate again
# pinned by: tests/state/song.test.ts, e2e/xy-pad.spec.ts

Scenario: A v2 file loads with the default XY axes (backward compat)
  Given a SongFile without an xy field
  When apply() runs with the XyPadStore
  Then the store holds { x: filter.cutoff, y: filter.resonance }
# pinned by: tests/state/song.test.ts
```

## Tests & verification

- Unit: `tests/state/xy-pad.test.ts` (store), `tests/ui/xy-pad.test.ts` (surface),
  `tests/ui/floating-window.test.ts` (host), plus `tests/state/song.test.ts` /
  `tests/state/serialize.test.ts` / `tests/state/song-validate.test.ts` (v3
  persistence) — `npm test`.
- E2E: `e2e/xy-pad.spec.ts` — `npm run e2e`.
- Typecheck: `npm run typecheck`.
- Dev-bridge: `window.__synth.xy.get()` (DEV only).

## Open questions / future

- A future need for **latching** (leave the pad parked, no spring-back) could add a
  hold toggle; today it is always momentary.
- More than two axes / a Z on pressure is out of scope.
