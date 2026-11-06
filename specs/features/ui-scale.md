# UI scale

```yaml
id: ui-scale
status: implemented
version: 1
owner: ui
related:
  - ui-themes             # the device-preference + pre-paint pattern this copies, and the boot script it shares
  - performance-mode      # the Settings dialog both live in
  - runtime-performance   # 100% must cost nothing; the bench pair proves it
  - keyboard-range        # the octave count follows the effective width
  - css-cascade-layers    # breakpoints are container queries
  - responsive-synth-panels
  - floating-window
  - dropdown              # menu-anchor.ts
  - untrusted-input       # a stored value is bounded on read
  - architecture          # the persistence table
source:
  - src/state/ui-scale.ts                     # the stops, the stored value, the engine choice, the shipped viewport tag
  - src/ui/ui-scale.ts                        # applies a scale; the coordinate + canvas helpers
  - public/theme-boot.js                      # applies the stored scale before first paint (its second job)
  - src/ui/components/ui-scale-control.ts     # the UI size row of the Settings dialog
  - src/ui/components/perf-settings-modal.ts  # the Settings dialog that holds it
  - src/ui/components/perf-settings.ts        # the header button's label names the section
  - src/ui/viewport.ts                        # isCompact / isPhone read the effective width
  - src/main.ts                               # initUiScale() at boot
  - src/ui/onboarding/help-content.ts         # the Settings help topic names UI size
  - src/styles/layout.css                     # breakpoints + a divided dvh
  - src/ui/styles/                            # every module breakpoint is @container viewport
  - scripts/perf-bench.mjs                    # the "window resizing" scenario
  - src/styles/base.css                       # html is the `viewport` size container
  - src/ui/components/menu-anchor.ts
  - src/ui/components/value-bubble.ts
  - src/ui/components/floating-window.ts
  - src/ui/components/record-window.ts
  - src/ui/components/strip.ts
  - src/ui/components/resize-handle.ts
  - src/ui/components/sync-pair-modal.ts
  - src/ui/components/scope.ts
  - src/ui/components/eq-graph.ts
  - src/ui/components/scratch-graph.ts
  - src/ui/components/record-sound-modal.ts
  - src/ui/onboarding/info-badges.ts
  - src/ui/onboarding/tour.ts
  - src/ui/components/demo-library.ts         # scrolls the card by a rect delta
  - tests/state/ui-scale.test.ts
  - tests/ui/ui-scale.test.ts
  - tests/ui/ui-scale-boot.test.ts
  - tests/ui/ui-scale-css.test.ts
  - e2e/ui-scale.spec.ts
```

How big the whole interface is drawn on this device, like the browser's own zoom:
one value from 50% to 150%, chosen in Settings and remembered per device.

## Background / Why

On a desktop, Ctrl +/− zooms VAST and the layout reflows. A phone or tablet has no
equivalent. The page disables pinch zoom (`user-scalable=no`, so a drag is a knob
turn), and pinch zoom only magnifies without reflowing anyway. Some desktop
browsers also zoom every tab of a site at once, or forget the level between
visits. So the app carries its own zoom: a single number that scales every length
and reflows the layout into the space it leaves, exactly as browser zoom does,
with no second set of sizing rules.

A page cannot set the browser's zoom. It gets the same effect two ways, and one
stored value drives whichever this device uses (REQ-one-value-two-engines).

## Requirements

- **REQ-the-scale-is-a-device-preference** — The scale is stored under
  `websynth.ui.scale` as a percentage. It is never a `ParamBus` param, and never
  travels in a song, a preset or a share link. A stored value that is not one of
  the stops (REQ-the-scale-snaps-to-browser-steps) reads as 100
  ([untrusted-input](untrusted-input.md)). Storage being blocked reads as 100 and
  makes the choice last only for this page.
- **REQ-the-scale-snaps-to-browser-steps** — The choosable values are the
  browser's zoom steps in range: 50, 67, 75, 80, 90, 100, 110, 125, 150
  (`UI_SCALE_STOPS`). 100 is the default.
- **REQ-one-value-two-engines** — The engine is chosen by the device, once per
  page load (`pickEngine()`):
  - **`viewport`** — on a touch-first device (`(hover: none) and (pointer: coarse)`)
    the `<meta name="viewport">` tag is rewritten to
    `initial-scale=s, minimum-scale=s, maximum-scale=s, viewport-fit=cover, user-scalable=no`
    with no `width`. The browser then sizes the layout viewport to device width ÷
    s, which is what its own zoom does. Breakpoints, `innerWidth`, pointer
    coordinates and rotation follow without any code.
  - **`zoom`** — everywhere else, CSS `zoom: s` on `<html>`, plus the custom
    property `--ui-zoom: s` for the few rules that need it
    (REQ-viewport-units-are-divided-by-the-zoom).
- **REQ-a-hundred-percent-is-a-no-op** — At 100%, whether by default or after
  Reset, nothing is applied. The viewport tag is the shipped one
  (`SHIPPED_VIEWPORT`, which must equal `index.html`'s), and `<html>` carries no
  `zoom`, no `--ui-zoom` and no `data-ui-base-dpr`. No listener fires. Every
  helper (REQ-coordinates-are-converted-at-the-read,
  REQ-canvases-stay-sharp-at-any-scale) returns its input, or the same object,
  without a DOM read. Going back to 100 from another value restores exactly this
  state.
- **REQ-the-scale-applies-before-first-paint** — `public/theme-boot.js` applies
  the stored scale before the first frame, so a reload never shows 100% first.
  This is its second job; the theme is the first. It returns after one storage
  read at 100%. No second boot script exists: a separate file would be another
  render-blocking request at every boot.
- **REQ-the-boot-script-agrees-with-the-state** — The boot script cannot import
  `src/state/ui-scale.ts`, so it repeats the stops, the key, the engine query and
  the scaled viewport string. A test runs it against `UI_SCALE_STOPS`,
  `pickEngine()` and `scaledViewport()` and fails if they disagree.
- **REQ-breakpoints-follow-the-effective-width** — A width breakpoint is an
  `@container viewport (…)` query, never `@media (…width…)`. `<html>` is the
  `viewport` inline-size container. Under CSS zoom, a container query matches
  against the zoomed width (viewport ÷ s) and a media query does not (verified in
  Chromium, Firefox and WebKit), so this is what lets the `zoom` engine reflow
  like browser zoom. The same query matches identically under the `viewport`
  engine and at 100%. Non-width media features (`max-resolution`,
  `prefers-*`, `hover`) stay `@media`. A rule inside a breakpoint never targets
  `html` or `:root`, because a container query cannot style its own container.
  Firefox evaluates the queries against the new zoom at load, but not after a
  live change: the container's box in screen px is unchanged, so it keeps the
  old answer until the next resize. So every live change on the `zoom` engine
  switches `<html>`'s `container-type` to `normal` for one forced layout and
  back. It does this through a `data-ui-requery` attribute that `base.css`
  matches, not an inline style. That runs once per committed change, never at
  100% at rest.
- **REQ-js-breakpoints-follow-the-effective-width** — `isCompact()` and
  `isPhone()` compare `innerWidth ÷ cssZoom()` with their thresholds, so the
  script-side layout choices agree with the CSS ones.
- **REQ-viewport-units-are-divided-by-the-zoom** — Under CSS zoom a `vw`/`vh`
  length is zoomed too (verified in Chromium, Firefox and WebKit: `100vh` is 1.5
  screens at 150%). Every viewport-unit length that sizes something to the
  screen is written `calc(<n>vw / var(--ui-zoom, 1))` (likewise `vh` / `dvh`). A
  `vh` that is only a "no limit" fallback inside a `var()` is exempt.
- **REQ-coordinates-are-converted-at-the-read** — Pointer and rect coordinates
  (`clientX/Y`, `offsetX/Y`, `getBoundingClientRect()`, `innerWidth/Height`) are
  in un-zoomed viewport px. Element sizes (`offsetWidth`, `clientWidth`,
  `ResizeObserver` boxes), style lengths and scroll offsets (`scrollTop`) are in
  the element's own zoomed px (verified in Chromium, Firefox and WebKit).
  Where code mixes the two, it converts the viewport value at the read with
  `toLocal()` / `localRect()` / `viewportWidth()` / `viewportHeight()` from
  `src/ui/ui-scale.ts`. Code
  that only takes a ratio of two viewport values (`(clientX − rect.left) / rect.width`)
  or hit-tests (`elementFromPoint`) needs no conversion. The converted sites are
  the `source` entries from `menu-anchor.ts` through `demo-library.ts`.
- **REQ-canvases-stay-sharp-at-any-scale** — A canvas sizes its bitmap with
  `backingScale()`, not `devicePixelRatio`. On the `zoom` engine that is
  `devicePixelRatio × s`, because `devicePixelRatio` does not include CSS zoom.
  On the `viewport` engine it is the pixel ratio from before the first rewrite ×
  s. Chromium keeps `devicePixelRatio` at the device's value and WebKit folds the
  page scale into it, so the base is captured once, before the first rewrite
  (`data-ui-base-dpr` on `<html>`, set only by the `viewport` engine and only
  when s ≠ 100).
- **REQ-a-scale-change-is-a-resize** — Applying a new scale live calls the
  `onUiScaleChange()` listeners (the scope, the EQ graph and the scratch graph
  re-measure; the Edit Sample waveform lives in a modal, so it can't be on screen
  while Settings is open, and it picks up the scale on its next draw) and dispatches one
  `resize` event on `window`, so every existing re-layout (open menus, floating
  windows, info badges, the tour) runs exactly as it does for a window resize.
  Both engines dispatch it. On the `viewport` engine the rewrite can also bring
  the browser's own resize, so a handler may run twice; every resize handler
  already re-measures from scratch, so the second run changes nothing.
- **REQ-the-slider-commits-on-release** — The Settings dialog's **UI size** row
  is a native range input over the stop indices, with a live readout ("125%")
  while dragging. The scale is applied and stored on `change` (release, or each
  arrow-key step), never on `input`, so the page does not rescale under the
  finger mid-drag. **Reset** returns to 100% and is disabled at 100%.

## Technical design

### Contract / public interface

```yaml
src/state/ui-scale.ts:
  UI_SCALE_STOPS: readonly number[]          # [50, 67, 75, 80, 90, 100, 110, 125, 150]
  UI_SCALE_DEFAULT: 100
  UI_SCALE_KEY: "websynth.ui.scale"
  ENGINE_QUERY: "(hover: none) and (pointer: coarse)"
  SHIPPED_VIEWPORT: string                    # == index.html's viewport content
  isScaleStop(v): v is number
  readUiScale(): number                       # a stop; 100 on anything else
  writeUiScale(pct: number): void             # 100 removes the key
  pickEngine(matches?): "viewport" | "zoom"   # matches: the media test, injectable for tests
  scaledViewport(pct: number): string         # the viewport content for a non-100 scale

src/ui/ui-scale.ts:
  applyUiScale(pct: number): void             # live apply (+ the zoom engine's re-query, listeners, one resize); a no-op if unchanged
  currentUiScale(): number                    # the applied percentage
  cssZoom(): number                           # s on the zoom engine, else 1
  toLocal(px: number): number                 # px / cssZoom()
  localRect(r: DOMRectReadOnly): LocalRect    # r itself at zoom 1; LocalRect = left/top/right/bottom/width/height
  viewportWidth(): number                     # innerWidth / cssZoom()
  viewportHeight(): number                    # innerHeight / cssZoom()
  backingScale(): number                      # bitmap px per CSS px
  onUiScaleChange(fn): () => void             # unsubscribe
  initUiScale(): void                         # boot: adopt what theme-boot.js applied

src/ui/components/ui-scale-control.ts:
  createUiScaleControl(): { el, destroy() }   # the Settings row: slider, readout, Reset
```

### Layer touchpoints & ordering

- `public/theme-boot.js` runs in `<head>` before the stylesheets. It reads the
  key; at 100 it stops. Otherwise, on a touch-first device it records
  `data-ui-base-dpr` and rewrites the viewport tag; elsewhere it sets `zoom` and
  `--ui-zoom` through CSSOM (the CSP allows a style *property*, not a style
  attribute).
- `main.ts` calls `initUiScale()` once, so the module's state agrees with what
  boot applied. It reads no layout. The Firefox re-query
  (REQ-breakpoints-follow-the-effective-width) belongs to `applyUiScale()` only.
- The Settings row lives in `ui-scale-control.ts`, inside the lazily loaded
  Settings chunk (`perf-settings-modal.ts`), so the entry chunk carries only
  `src/ui/ui-scale.ts` and `src/state/ui-scale.ts`.

### Persistence

`localStorage['websynth.ui.scale']`: one of the stops other than 100, as a
decimal string. 100 is stored as the key's absence. Factory reset clears it with
the rest of localStorage ([factory-reset](factory-reset.md)).

## Gesture inventory (ADR-014)

| Control | Gesture | Result |
| --- | --- | --- |
| UI size slider | drag | the readout follows; nothing is applied |
| UI size slider | release | applies + stores the stop under the thumb |
| UI size slider | ←/→ (focused) | one stop; applies + stores (native `change`) |
| UI size slider | Home/End | 50% / 150%; applies + stores (native `change`) |
| Reset | click / Enter / Space | 100%; disabled at 100% |

The global shortcuts stand down while the Settings modal is open
([input-control](input-control.md)), so no key on the slider reaches one.

## Scenarios (BDD)

```gherkin
Scenario: a stored stop is restored on reload (REQ-the-scale-is-a-device-preference)
  Given "websynth.ui.scale" holds "125"
  When the app boots
  Then readUiScale() is 125 and the page is drawn at 125%
# pinned by: tests/state/ui-scale.test.ts, e2e/ui-scale.spec.ts

Scenario: a forged value reads as 100 (edge, REQ-the-scale-is-a-device-preference)
  Given "websynth.ui.scale" holds "9999" or "abc" or "120"
  Then readUiScale() is 100
# pinned by: tests/state/ui-scale.test.ts

Scenario: 100% applies nothing (REQ-a-hundred-percent-is-a-no-op)
  Given no stored scale, or the user pressed Reset
  Then the viewport tag equals index.html's, html has no zoom, --ui-zoom or data-ui-base-dpr
  And toLocal(x) is x and localRect(r) is r
# pinned by: tests/ui/ui-scale.test.ts, tests/ui/ui-scale-boot.test.ts

Scenario: the shipped tag is index.html's (REQ-a-hundred-percent-is-a-no-op)
  Then SHIPPED_VIEWPORT equals the content of index.html's viewport meta
# pinned by: tests/state/ui-scale.test.ts

Scenario: boot applies before first paint (REQ-the-scale-applies-before-first-paint, REQ-the-boot-script-agrees-with-the-state)
  Given each stop is stored, on each engine
  When public/theme-boot.js runs
  Then it leaves exactly the state applyUiScale(stop) leaves
# pinned by: tests/ui/ui-scale-boot.test.ts

Scenario: a touch device rewrites the viewport (REQ-one-value-two-engines)
  Given a 390 px touch phone and 80% stored
  When the app boots
  Then innerWidth is about 487 and html has no zoom
# pinned by: e2e/ui-scale.spec.ts (mobile emulation)

Scenario: a desktop zooms and reflows (REQ-one-value-two-engines, REQ-breakpoints-follow-the-effective-width)
  Given a 1366 px desktop window
  When the user picks 150%
  Then html zoom is 1.5 and nothing overflows sideways (the ≤1280 px layout is in effect)
# pinned by: e2e/ui-scale.spec.ts

Scenario: a live change re-evaluates the breakpoints in Firefox (regression, REQ-breakpoints-follow-the-effective-width)
  Given Firefox, a 1600 px window at 100%
  When the user picks 150% with the slider, without reloading
  Then the layout is the one a reload at 150% gives (the ≤1280 px layout), not the wide one squeezed
  And html carries no data-ui-requery and no style attribute afterwards (back at 100%)
# pinned by: tests/ui/ui-scale.test.ts (the toggle), e2e/ui-scale.spec.ts (Chromium; Firefox is by hand — CI has no Firefox project)

Scenario: no width breakpoint is a media query (REQ-breakpoints-follow-the-effective-width)
  Then no stylesheet holds "@media" with a width or height feature
  And no rule inside "@container viewport" targets html or :root
# pinned by: tests/ui/ui-scale-css.test.ts

Scenario: viewport units are divided (REQ-viewport-units-are-divided-by-the-zoom)
  Then every vw/vh/dvh length in a stylesheet sits inside calc(… / var(--ui-zoom, 1)), or a var() fallback
# pinned by: tests/ui/ui-scale-css.test.ts

Scenario: script breakpoints agree (REQ-js-breakpoints-follow-the-effective-width)
  Given a 1366 px window at 150% on the zoom engine
  Then isCompact() is true
# pinned by: tests/ui/ui-scale.test.ts

Scenario: a menu lands under its toggle when zoomed (REQ-coordinates-are-converted-at-the-read)
  Given 150% on the zoom engine
  When a dropdown opens
  Then the menu's rendered top-left is within 2 px of the toggle's bottom-left (+6 px gap × 1.5)
# pinned by: tests/ui/ui-scale.test.ts (anchorMenu), e2e/ui-scale.spec.ts

Scenario: a floating window drags 1:1 when zoomed (REQ-coordinates-are-converted-at-the-read)
  Given 150% on the zoom engine and an open floating window
  When its title is dragged 100 px right
  Then its rendered left moved 100 px
# pinned by: e2e/ui-scale.spec.ts

Scenario: canvases are sharp (REQ-canvases-stay-sharp-at-any-scale)
  Given devicePixelRatio 2 and 150% on the zoom engine
  Then backingScale() is 3
  Given the viewport engine, a base ratio of 3 and 80%
  Then backingScale() is 2.4 whatever devicePixelRatio reports now
# pinned by: tests/ui/ui-scale.test.ts

Scenario: a change re-lays out like a resize (REQ-a-scale-change-is-a-resize)
  When applyUiScale(125) runs
  Then each onUiScaleChange listener runs once and window sees one resize
  And applyUiScale(125) again does nothing
# pinned by: tests/ui/ui-scale.test.ts

Scenario: dragging previews, release commits (REQ-the-slider-commits-on-release)
  Given the Settings dialog at 100%
  When the slider is moved to 125% without releasing
  Then the readout says 125% and nothing is stored or applied
  When it is released
  Then 125 is stored and applied; Reset is enabled
  When Reset is pressed
  Then the key is removed, 100% is applied and Reset is disabled
# pinned by: tests/ui/ui-scale.test.ts
```

## Tests & verification

- Unit: `tests/state/ui-scale.test.ts`, `tests/ui/ui-scale.test.ts`,
  `tests/ui/ui-scale-boot.test.ts`, `tests/ui/ui-scale-css.test.ts` — `npm test`
- E2E: `e2e/ui-scale.spec.ts` — `npm run e2e`
- Cost at 100% (REQ-a-hundred-percent-is-a-no-op): a `npm run bench:perf`
  before/after pair on the same machine, run interleaved, with no scenario
  outside noise ([runtime-performance](runtime-performance.md)).
  The `<html>` container moves part of Chrome's style work into layout. The
  recalc *count* rises (about +8/s during playback), while combined style +
  layout time does not. This was measured interleaved, 5 runs a side, at 1× and
  at 6× CPU throttle on the weak tier, with no difference beyond noise in main
  thread, frames or audio load. Window resizing got cheaper.
- The CSS swap (REQ-breakpoints-follow-the-effective-width) is proven at 100%
  with `npm run cascade:fingerprint` on `vite dev` and on the build.
- The e2e "picked size" scenario measures a fixed-size control (Panic), not a
  knob: a knob's size is responsive, and 125% of a 1440 px window is the
  compact layout, exactly as under the browser's own zoom.
- By hand: Firefox and Chrome desktop at 67% and 150% (menus, knobs, the XY
  pad, floating windows, the scope). A real phone and tablet: rotate, reload, and
  check the canvases are sharp. Playwright's WebKit is not Safari, so real
  iOS/macOS Safari is a by-hand check.

## Open questions / future

- A desktop browser's own Ctrl +/− multiplies with this setting. That is
  intended: either can be used.
- A container query measures `<html>`'s width, and a media query measured the
  window's, scrollbar included. The two agree because `<body>` is the scroller,
  not the viewport (`base.css`). If the viewport ever gets a classic scrollbar,
  the breakpoints move by its width.
- Crossing the 1630 px breakpoint logs "ResizeObserver loop completed with
  undelivered notifications". A plain window resize does it too, on the code
  from before this feature, so it is not the scale's; it is unexplored.
