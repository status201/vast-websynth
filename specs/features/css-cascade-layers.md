# CSS cascade layers (import order is not layout)

```yaml
id: css-cascade-layers
status: implemented
version: 1
owner: ui
related:
  - architecture        # the app.ts split this unblocks
  - typography          # sibling drift pin over the same stylesheets
  - iconography
  - runtime-performance # the lazy chunks whose CSS loads late
source:
  - src/styles/layers.css          # the one statement that orders the layers
  - src/styles/                    # the global sheets, each in its layer
  - src/ui/styles/                 # every CSS Module, each in its layer
  - scripts/lib/css-layer-order.mjs  # puts the order into every built CSS chunk
  - scripts/check-bundle.mjs       # asserts it on the files that shipped
  - scripts/css-cascade/           # the fingerprint and the conflict audit
  - tests/ui/css-layers.test.ts
```

Which stylesheet wins when two of them style the same element — decided by a
declared layer order, never by which module happened to be imported first.

## Background / Why

CSS Modules inject in import order, and one element routinely wears classes
from two modules: `switch.module.css`'s `.root` plus the shell's `.menuToggle`,
`tabs.module.css`'s `.root` plus the shell's `.patternRow`. Both are a single
class, so the cascade falls through to **source order**, and source order is
whatever the import graph produced. Where an import sat in a file was part of
the app's layout.

Splitting `ui/app.ts` was tried and reverted for exactly this (see
[architecture](../architecture.md)): moving the panel builders moved their
imports, and the hamburger reappeared on wide screens while the pattern row grew
71px. `tsc` and the unit suite were blind to it.

It was also already wrong in production. The build hoists a stylesheet that the
lazy dialogs share — `switch`, `segmented` — into a shared CSS chunk, so its
position comes from chunking, not from imports, and dev (where e2e runs) and the
shipped build disagreed: the Song panel's own `gap: 14px` and its stutter
buttons' `min-width: 26px` lost in the build to the panel chrome and the
segmented control they were written to override.

## Requirements

- **REQ-every-stylesheet-declares-its-layer** — every global sheet and every
  CSS Module puts all of its rules inside exactly one `@layer <name> { … }`
  block, naming a layer declared in `src/styles/layers.css`. Nothing outside it
  but comments. An unlayered rule would beat every layered one regardless of
  specificity, so one forgotten file silently outranks the whole app.

- **REQ-the-layer-order-is-declared-once-and-first** — `src/styles/layers.css`
  holds the single `@layer a, b, …;` statement and is the first stylesheet the
  page loads, so a sheet arriving later — a lazy dialog's chunk — still takes
  its declared place rather than appending a new layer on top.

- **REQ-a-composer-outranks-what-it-composes** — a module that adds its classes
  to another module's element sits in a later layer than that module. That is
  the intent every such override was written with; the layer makes it true in
  every load order.

- **REQ-no-cross-module-tie-is-left-to-load-order** — no property on any element
  is decided between two stylesheets by source order alone: equal importance,
  equal layer, equal specificity, different values. `scripts/css-cascade/conflicts.mjs`
  audits this in a real browser over every captured UI state; a tie it reports
  is resolved by moving a module to the right layer or by deleting the
  declaration that never applied.

- **REQ-a-composers-base-rule-yields-to-a-controls-state** — a layer beats
  specificity, so a control's *state* rule (`switch`'s `.root:active` press
  shadow, its `.on` colour) now loses to a composer's plain base rule on the
  same property — where, settled by specificity, the state used to win. A
  composer that sets a property one of its control's state rules also sets
  scopes its own rule out of that state (`button.tierStrong:not(:active)` for
  the glow), rather than duplicating the control's value. And a component that
  owns a state other modules style around (a floating window's collapsed body)
  enforces it where no stylesheet can outrank it — inline
  ([floating-window](floating-window.md) REQ-a-collapsed-body-stays-hidden).

- **REQ-hidden-means-hidden** — `[hidden]` is `display: none !important` in
  `base.css`'s `reset` layer. Important declarations run the layer order
  backwards, so this one outranks every component's `display` in every layer —
  the property means what it says without six components each restoring it
  (switch, dropdown, the scope's Zones toggle, the export progress, the file
  drop overlay and the progress bar did, one by one).

- **REQ-a-cascade-refactor-is-proven-by-fingerprint** — a change meant to be
  invisible (moving imports, splitting a stylesheet, re-layering) is proven by
  `scripts/css-cascade/fingerprint.mjs`: the computed style and box of every
  element in every captured state × viewport, compared against a baseline taken
  before the change, on **both** `vite dev` and the built app. Zero differences,
  or each one explained.

## Technical design

### Contract / public interface

The order, lowest to highest, as declared in `src/styles/layers.css`:

```yaml
reset:       src/styles/base.css             # element defaults
theme:       src/styles/theme.css            # the custom properties
app-layout:  src/styles/layout.css           # the .app grid
controls:    leaf controls other modules decorate — switch, segmented, tabs,
             knob, dropdown, step-button, strip, section-title, value-bubble,
             progress-bar, resize-handle, brand, gr-meter
components:  widgets and dialogs built from controls — modal, dialog, toast,
             bank-bar, step-settings, scope, keyboard, xy-pad, tour, the export /
             preset / record dialogs, …
chrome:      the shared panel chrome every machine panel wears
panels:      the synth and machine panels — arp, key, seq, drum, sampler,
             motion, song-panel, eq, mod
shell:       the app shell — header, FX rack, pattern row, bottom section
```

**Picking a layer for a new module** (REQ-a-composer-outranks-what-it-composes):
the lowest layer that is still above every module whose classes share an
element with it. A module that composes nothing is a control; a panel that
puts its class on a `switch.module.css` root sits above `controls`, and so on.
Two modules in one layer must not set the same property on one element at the
same specificity — `conflicts.mjs` reports it if they do.

**How the order reaches the browser.** A browser fixes the layer order from the
first stylesheet that names a layer, so `layers.css` must be met first:

- `vite dev` — `index.html` links `layers.css` ahead of `base.css`, and every
  module's `<style>` is injected after it.
- the build — CSS is split into chunks whose link order nobody chose: a sheet
  the lazy dialogs share (switch, segmented) becomes a shared chunk linked
  *before* the entry CSS. `scripts/lib/css-layer-order.mjs` therefore prefixes
  every stylesheet the build compiles with the order statement (at transform
  time, so a reordered list changes the content hash and no cached chunk keeps
  the old order). The minifier trims each copy to the prefix of the order a
  chunk needs, which is still safe: the browser can only ever learn layers in
  declared order. `npm run check:bundle` asserts that prefix property on the
  files that actually shipped.

### Layer touchpoints & ordering

- Inline styles (`el.style.*`, custom properties set from TS) are outside the
  cascade layers and unaffected.
- `!important` runs the layer order **backwards** — an important declaration in
  `reset` beats one in `shell`. The audit judges important contests with that
  rule, so none flips unseen.
- What layering changed, found by the tools and decided one by one: the two dead
  `.patternRow` rules (deleted); the hidden label's margin (the module's own
  `margin: -1px` now applies); the perf tier and `toggleActive` glows (scoped
  out of `:active`, so a press still shows); the LIVE FX window's minimise
  (now inline); and a sequencer track-mute no longer grows to full size while
  pressed, because the switch's press `transform` no longer replaces its
  `scale(0.85)` — a glitch that specificity had been causing, left fixed.
- A global sheet's rule that used to win on specificity alone now loses to any
  module: the globals are the lowest layers. The one such case when this landed
  (`base.css`'s `svg.ui-icon + .icon-label` margin over `section-title`'s
  visually-hidden label) went the module's way, which is what it was written for.

## Scenarios (BDD)

```gherkin
Scenario: the hamburger stays hidden on a wide screen whatever the import order (regression)
  Given a 1920px viewport
  When the shell's stylesheet is imported before the switch's
  Then the header menu toggle is not displayed
# pinned by: scripts/css-cascade/fingerprint.mjs — browser-only (boot@w1920); verified by moving the
#   import and comparing: 63 differences before the layers, none after

Scenario: the pattern row's height does not depend on import order (regression)
  Given the two .patternRow min-height rules tabs.module.css had always beaten by load order
  Then they are deleted, not layered into winning, so the row keeps the height it has always had
# pinned by: scripts/css-cascade/conflicts.mjs — the tier dry run (--tiers) reports every winner a
#   layer map would change; these two were its findings

Scenario: the shipped build and vite dev agree (regression)
  Given the Song panel, whose own gap and Stutter button width override the panel chrome and the
    segmented control
  Then they apply in the built app as they do in vite dev, though the build loads the segmented
    control's stylesheet from a shared chunk ahead of the entry CSS
# pinned by: scripts/css-cascade/fingerprint.mjs — browser-only, the build against the dev baseline

Scenario: every built CSS chunk learns the layers in declared order (REQ-the-layer-order-is-declared-once-and-first)
  Given the build splits CSS into chunks that load in an order nobody chose
  Then each chunk names its layers as a prefix of the declared order
# pinned by: scripts/check-bundle.mjs

Scenario: a minimised floating window hides its body (regression)
  Given the LIVE FX window, whose body carries the Song panel's flex layout class
  When it is minimised
  Then its controls are hidden
# pinned by: e2e/live-fx.spec.ts, tests/ui/floating-window.test.ts, and the fingerprint's window-*-minimised states

Scenario: a pressed header button still shows it is pressed (regression, REQ-a-composers-base-rule-yields-to-a-controls-state)
  Given the Performance button wearing its tier glow, or an active ⓘ button
  When it is pressed
  Then the switch's pressed shadow replaces the glow, as it did before layering
# pinned by: no automated check — :active is a pointer state the fingerprint does not force; verified by reading the rules

Scenario: an unlayered stylesheet fails the suite (REQ-every-stylesheet-declares-its-layer)
  Given a CSS Module with a rule outside any @layer block
  Then the drift pin fails naming that file
# pinned by: tests/ui/css-layers.test.ts
```

## Tests & verification

- Unit: `tests/ui/css-layers.test.ts` — `npm test`
- Build: `npm run build && npm run check:bundle` — the layer prefix check (CI runs it)
- Browser, for any change meant to be invisible — run before and after, on BOTH
  servers (`--server dev`, and the default built app after `npm run build`):
  - `npm run cascade:fingerprint -- --out base.json.gz --runs 2` on the old tree,
    then `-- --compare base.json.gz` on the new one. Minutes per server.
  - `npm run cascade:conflicts -- --dump d.json` — about 1.5 h for every state;
    `-- --from d.json --tiers t.json` then re-judges a layer map offline in seconds.
