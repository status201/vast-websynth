# FX group (shared inline effect-group UI)

```yaml
id: fx-group
status: implemented
version: 2   # v2: REQ-fx-group-testids — a rate/time knob in a group also mints the tempo-lock
             #     ids; the builder itself is unchanged (tempo-lock.md REQ-one-table-declares-lockable-params)
owner: core
related:
  - effects
  - tempo-lock  # v2: the PHASER/DELAY knobs carry a lock the group never sees
  - compressor
  - drum-machine
  - sampler
  - song-mode
source:
  - src/ui/components/fx-group.ts
  - src/ui/styles/fx-group.module.css
  - src/ui/panels/drum-panel.ts      # PHASER / DELAY / COMP (+ GR meter)
  - src/ui/panels/sampler-panel.ts   # DIST / PHASER / DELAY / REVERB
  - src/ui/panels/song-panel.ts      # master COMP
```

The compact inline effect group used in panel headers: divider, title, on/off
switch and a row of small knobs (plus an optional trailing element such as a
gain-reduction meter). One component; the Drum Machine, Sampler and Song
panels all build their header FX from it. The synth tab's boxed FX rack
(`fxPanel` in `src/ui/app.ts`) is a different, separately-specified layout and
is **not** governed here.

## Background / Why

The header FX rows were eating panel space: every group always showed all its
knobs even though every `fx.*.on` defaults to 0 (bypassed — [effects](effects.md)
REQ-fx-on-below-half-is-bypassed). Since a bypassed effect's knobs are inert, the group hides them and
shows only `[divider · TITLE · switch]` until the effect is engaged. This is
**param-driven visibility** (the group reacts to the `.on` param like `Switch`
does), deliberately distinct from the user-driven, localStorage-persisted
`collapse-toggle` component.

The Sampler panel used to carry a private near-duplicate of this builder
(inline `style.cssText`); it was removed in favour of the shared component so
behaviour like this lives in one place.

## Requirements

- **REQ-fx-group-renders-switch-and-knobs** — `fxGroup(bus, title, onPrefix,
  knobs, opts?)` renders divider, title label, a `Switch` bound to ``
  `${onPrefix}.on` ``, one `Knob` per entry, then `opts.trailing` (if given) —
  knobs + trailing inside a single `.knobs` sub-container.
- **REQ-bypassed-group-collapses-its-knobs** — While `` `${onPrefix}.on` `` <
  0.5 the group is **collapsed**: the `.knobs` container (knobs *and* trailing)
  is hidden; divider, title and switch stay visible. At or above 0.5 the knobs
  show in place.
- **REQ-collapse-follows-any-param-change** — Visibility is reactive: it follows
  every param change, whatever the source (switch click, preset/song load,
  `bus.set`). Initial state comes from the param's current value at build time.
- **REQ-fx-group-testids** — Testids: the group root carries
  `fxgroup-<onPrefix>`; the switch `switch-<onPrefix>.on`; each knob
  `knob-<paramId>` (minted by the factories).
  - (v2) A group's rate/time knob mints `tempolock-<paramId>` and
    `tempodiv-<paramId>` as well ([tempo-lock](tempo-lock.md) REQ-one-table-declares-lockable-params/REQ-the-lock-is-a-note-glyph). The
    builder here is **unchanged** and knows nothing about it: the `Knob` looks its
    own param up in `TEMPO_LOCKS`, which is exactly why the drum and sampler
    PHASER/DELAY groups got the lock without this signature growing a field.
    The lock sits inside `.knobs`, so REQ-bypassed-group-collapses-its-knobs hides it with everything else while
    the effect is bypassed — correct, since a bypassed effect's division is as
    inert as its rate.
- **REQ-help-badge-anchors-to-group-root** — Help badges that relate to an
  effect group anchor to the group **root** (`fxgroup-<prefix>`), never to a
  knob or trailing meter — those hide while bypassed and InfoBadges hides badges
  on zero-size anchors, but help must stay reachable for a bypassed effect
  (that's when "what is this?" is asked).

## Technical design

### Contract / public interface

```yaml
fxGroup(bus, title, onPrefix, knobs, opts?): HTMLElement   # src/ui/components/fx-group.ts
  knobs: Array<{ id, label }>
  opts: { knobSize? = 22, trailing?: HTMLElement }
collapse mechanism:
  bus.subscribe(`${onPrefix}.on`, v => root.classList.toggle('collapsed', v < 0.5))
  css: .root:global(.collapsed) .knobs { display: none; }   # fx-group.module.css
        (same pattern as the synth rack's .fxSection collapse in layout.module.css)
```

`.collapsed` is one of the repo's global state classes (like `.on`/`.active`),
so the module selector matches it via `:global()`.

## Scenarios (BDD)

```gherkin
Scenario: A bypassed effect boots collapsed
  Given fx.drum.phaser.on is 0 (the default)
  When the Drum Machine panel is built
  Then the PHASER group shows only its title and switch — no knobs
# pinned by: tests/ui/fx-group.test.ts, e2e/compressor.spec.ts

Scenario: Engaging an effect reveals its knobs
  Given a collapsed group
  When the user clicks its on switch (or a loaded preset/song sets <prefix>.on = 1)
  Then the knobs (and any trailing meter) appear in place
# pinned by: tests/ui/fx-group.test.ts, e2e/compressor.spec.ts

Scenario: Bypassing re-collapses (edge)
  Given an engaged group with visible knobs
  When <prefix>.on returns to 0
  Then the knobs hide again; the switch stays visible for re-engaging
# pinned by: tests/ui/fx-group.test.ts
```

## Tests & verification

- `tests/ui/fx-group.test.ts` — structure, boot-collapsed, reactive
  expand/collapse, trailing element containment.
- `e2e/compressor.spec.ts` — drum + master COMP groups hidden-while-off, then
  engaged before knob/meter assertions.
- `npm test` / `npm run e2e`.

## Open questions / future

- A width/opacity transition on collapse could soften the layout shift; kept
  as plain `display: none` for now.
