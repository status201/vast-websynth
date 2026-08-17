# Tempo lock (a rate knob locked to the grid, in the knob's own footprint)

```yaml
id: tempo-lock
status: implemented
version: 3   # v2: REQ-10 — the glyph hangs in a left gutter, out of flow. Inline
             #     it wrapped the label at the machine tabs' 22px knobs and
             #     dropped that knob's dial below its neighbours'.
             # v3: REQ-10 — that gutter is now opt-in (machine tabs only). Being
             #     out of flow, the glyph never needed one on the surfaces where
             #     the lockable knob leads its row; reserving it there pushed the
             #     knob off the centre its neighbours share.
owner: core
related:
  - architecture
  - tempo-sync-help     # the same division table, advisory; this is the real lock
  - lfo                 # REQ-9 shipped the first lock; this supersedes its UI
  - effects             # the wah / phaser / delay rates this extends it to
  - dropdown            # the division menu, incl. REQ-10 disabled options
  - knob-soft-ceiling   # the other per-knob disclosure device; not interchangeable
  - fx-group            # a consuming surface (drum/sampler header FX)
  - testids
source:
  - src/utils/tempo.ts                  # syncedRateHz / syncedTimeSec / nearestDivision
  - src/state/tempo-lock.ts             # TEMPO_LOCKS — which params are lockable
  - src/audio/tempo-bind.ts             # bindTempoLocked — the one audio-side wiring
  - src/ui/components/tempo-lock.ts     # the glyph, the chip, the menu
  - src/ui/components/knob.ts           # self-wires the lock, like modDepthDeps
  - src/ui/styles/tempo-lock.module.css
  - src/ui/styles/knob.module.css       # .hasLock — the gutter, off by default
  - src/ui/styles/fx-group.module.css   # the one surface that opts in (REQ-10)
```

A **tempo lock** is a per-knob toggle that takes a rate or a time off the knob
and onto the song's grid. While locked, the knob's dial is replaced — in place,
at the same size — by the note division it is running at, and the knob's own
readout keeps showing the resulting Hz or ms.

This is a **cross-cutting facility**, not a feature of any one effect: nine
params use it today and the next one is a table entry. The specs that own those
params ([lfo](lfo.md), [effects](effects.md)) describe *what* is lockable; this
spec owns *how* locking behaves.

## Background / Why

[lfo](lfo.md) REQ-9 gave `lfo.rate` a tempo lock via `lfo.sync`, a discrete param
whose index 0 is `free`. Nothing else got one. `fx.wah.rate`, `fx.phaser.rate`
(three bus variants) and `fx.delay.time` (three bus variants) stayed linear,
free-valued and blind to `transport.bpm` — so a patch dialled in at 120 BPM falls
off the grid the moment the song's tempo changes, and there is no way to save an
effect *in time* with a preset. [tempo-sync-help](tempo-sync-help.md) has carried
the promotion in its "Open questions" since it shipped: the math was already
there and already audio-importable, deliberately.

What blocked it was **space**, not audio. The LFO's answer was a full-width
`ParamDropdown` stacked two rows below the knob it governs, plus a dim on the
knob to say "not you". Replicated per effect that costs a row each, and the synth
FX rack has none to give: it is a six-column grid whose panels bottom out at
~220 px of content per effect, and the Phaser's four knobs already spend all of
it ([responsive-synth-panels](responsive-synth-panels.md) REQ-8, which exists
because that margin went to zero). A control that only
appears when it is in use, inside a footprint that already exists, is the only
shape that fits — and it happens to be the shape 40 years of hardware and
plug-ins already use (see REQ-2's precedent).

The LFO's own dim-in-place treatment is therefore **superseded** here, not
extended. That was the right call for a picker two rows away — the knob had to
keep its place so you could see what it would return to. It is the wrong call
once the picker *is* the knob: dimming would leave two controls saying the same
thing, one of them inert.

## Requirements

- **REQ-1** — **A lockable param is declared in one table, and the `Knob`
  self-wires from it.** `TEMPO_LOCKS` (`src/state/tempo-lock.ts`) maps a param id
  to its `TempoQuantity` (`'freq'` | `'time'`); `tempoLockFor(id)` returns that or
  `undefined`. A `Knob` looks its own param up and builds the lock only on a hit —
  the same self-wiring shape it already uses for `modDepthDeps`
  ([ADR-008](../decisions/adr-008-components-self-wire-params.md)). Consequences
  that are the *point* of doing it this way:
  - No call site changes. `fxPanel` (`app.ts`), `fxGroup`, the LFO panel and the
    Live FX window all gain the lock without a signature growing anywhere, and
    none of them can forget.
  - A param cannot be lockable on one surface and free on another. The drum
    Phaser in the header group and the same param on the Live FX window are the
    same control or the table is wrong.
  - A knob on a param that is not in the table builds **no extra node** and takes
    **no extra subscription** — the lazy discipline `.dead` and `.modArc` already
    follow ([knob-soft-ceiling](knob-soft-ceiling.md) REQ-5).
- **REQ-2** — **The lock is a note glyph on the knob's label line**, left of the
  label text (see REQ-10 for how it is placed), carrying the global `on` class
  while locked. It is a
  `<button type="button">` with `aria-pressed`, a `title` naming the gesture, and
  an `aria-hidden` inline SVG glyph (local to the component, as `dropdown.ts`
  keeps its magnifier local).
  - **Not a padlock.** "Lock" already means *parameter lock* in synth vocabulary
    (Elektron p-locks); a padlock here would read as "freeze this value", which is
    close enough to the truth to be misleading and far enough to be wrong.
  - **Not a corner chip on the dial.** At the 22 px knobs the drum and sampler
    header groups use, a dial-corner target is ~11 px —
    [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 6 (touch-first,
    ≥44 px) rules it out. The label row is a full-width strip, so the button can
    be padded out to the cell without stealing from the dial's drag area.
  - Precedent (law 4): the **SYNC** switch on hardware and plug-in delays —
    Ableton's Delay, Soundtoys EchoBoy, FabFilter Timeless — swaps a time knob's
    continuous readout for a note division. This borrows the behaviour and keeps
    the glyph, because the word does not fit the space this one has.
- **REQ-3** — **Locked, the division replaces the dial; the readout keeps telling
  the truth.** The `.dial` is hidden (`display: none`) and a chip takes its place
  as a **sibling**, never a child — the knob's drag listener lives on `.dial`, so
  a chip inside it would start a drag. The chip is the `Dropdown` toggle: tapping
  it opens the division menu.
  - The knob's `.num` readout shows the **derived** value — `2.67Hz`, `375ms` —
    formatted through the param's own `format`, so the musical division and the
    real number are visible at once and the user never has to do the arithmetic
    the [tempo-sync-help](tempo-sync-help.md) badges exist to do.
  - The chip's label is the division with its space stripped (`1/16 D` → `1/16D`)
    in 8 px `--mono` ([typography](typography.md): changing digits are mono). This
    is a size decision, not a style one: `1/16D` is ~24 px, which fits inside the
    30 px box a 22 px knob occupies, so **nothing reflows on lock at any knob
    size**. That is the whole reason this shape was chosen over a visible
    dropdown, and REQ-9 pins it.
- **REQ-4** — **The lock is a view of `sync > 0`, not a second param.** There is
  no new state, nothing extra to persist, and no tri-state:
  - Pressing the glyph while free sets `<prefix>.sync` to the division **nearest
    the knob's current value at the current BPM**, compared in **log space**
    (a rate is heard in octaves — [lfo](lfo.md) REQ-8). Locking therefore does not
    jump the sound, which is what makes it safe to try mid-performance.
  - Pressing it while locked sets `<prefix>.sync` back to `0`.
  - The rate/time param itself is **never rewritten** — the rule [lfo](lfo.md)
    REQ-9 already establishes. Unlocking restores the exact previous sound.
- **REQ-5** — **The menu lists the 18 divisions and no `free` row.** The glyph is
  the only way in and out ([ADR-014](../decisions/adr-014-dont-make-me-think.md)
  law 2: one gesture, one outcome — two controls that both unsync is two answers
  to one question). The **stored encoding is unchanged**: index 0 still means
  `free`, `SYNC_LABELS` is still append-only, and every preset, song and share
  link written before this reads back identically.
- **REQ-6** — **A division that cannot be reached at the current tempo is greyed,
  not removed.** `1/1` at 60 BPM is 4 s, past `fx.delay.time`'s 1.5 s maximum. The
  menu recomputes `Dropdown.setDisabledOptions` from `sweetSpotsInRange(bpm,
  def.min, def.max, quantity)` on every `transport.bpm` change.
  - Greyed rather than dropped because [dropdown](dropdown.md) REQ-10 says so, and
    for the reason it says so: `setOptions` silently rewrites a value that leaves
    the list, and a row that vanishes tells the user nothing.
  - **Nothing is clamped in audio.** The greying is UI-only, so no patch that
    already holds an out-of-range division can change how it sounds — including
    the LFO's, which has always allowed a synced rate past `lfo.rate`'s 20 Hz.
- **REQ-7** — **Audio resolves the lock in one place.** `bindTempoLocked(bus,
  valueId, syncId, quantity, apply)` (`src/audio/tempo-bind.ts`) computes
  `synced(sync, bpm) ?? bus.get(valueId)` and subscribes `valueId`, `syncId` **and
  `transport.bpm`** — so a locked effect tracks a tempo ramp or an incoming MIDI
  clock ([midi-clock-sync](midi-clock-sync.md)) without the user touching
  anything. `Lfo.bind` and the Wah/Phaser/Delay `bind`s all route through it, so
  "what does synced mean" has exactly one definition. The `apply` callback keeps
  each effect's existing setter and therefore its existing `RAMP_SMOOTH` smoothing
  ([effects](effects.md) REQ-2b) — this feature changes *what* value is applied,
  never *how*.
- **REQ-8** — **Every `<prefix>.sync` defaults to `0` (`free`), an exact no-op**
  ([ADR-006](../decisions/adr-006-no-op-param-defaults.md)). They are additive
  scalar params, so no `SONG_VERSION` bump
  ([ADR-007](../decisions/adr-007-songfile-additive-versioning.md)). But a
  no-op default is not enough on its own: `Presets.apply` is a bare
  `bus.restore(snap)` with no reset, so **any factory bank that turns one of these
  effects on must pin its `.sync`** or the value leaks in from the previously
  loaded patch — [presets](presets.md) REQ-2b, the hole `lfo.sync` fell through
  once already.
- **REQ-9** — **Locking must not move anything on the faceplate.** The chip
  occupies the dial's box and no more; the cell's width is unchanged, locked or
  free. This is load-bearing rather than cosmetic: the Phaser group's four knobs
  spend 220 px, and [responsive-synth-panels](responsive-synth-panels.md) REQ-8
  sizes its rack panel to exactly that and no more — so a chip a few pixels wider
  than its knob box would overflow the panel, or drop a knob onto a second line
  on the narrow fallback where `.fxKnobs` still wraps. A space-saving feature
  would cost space at the exact moment it is used.

- **REQ-10** — (v3) **The glyph is out of flow, hanging to the left of the
  cell** — `position: absolute; right: 100%` against the label, which owns the
  positioning context. It costs no layout, so the knob keeps the exact box it
  would have without a lock, and **no gutter is reserved by default**. A surface
  that needs one opts in with `--lock-gutter` on the row.
  - **Why not inline.** It shipped inline, and it wrapped. A knob cell is
    `--knob-size + 8px`, so the machine tabs' 22 px knobs give a **30 px** cell —
    less than the ~39 px the glyph and `RATE` need side by side. The label took a
    second line, that knob grew taller than its neighbours, and its dial sat
    visibly lower than theirs. The synth rack's 52 px cell had room, so the defect
    only appeared on the compact groups.
  - Out of flow, the glyph contributes **nothing** to the label's line box, so the
    no-wrap guarantee holds at every knob size from one rule rather than from a
    size threshold that would need re-tuning per breakpoint. `white-space: nowrap`
    on the label states the guarantee rather than leaving it incidental.
  - **Who opts in.** Only the machine tabs' header groups
    (`fx-group.module.css .knobs`, `--lock-gutter: 20px`). They pack
    switch-then-knobs at 4 px, so there the glyph would hang over the on/off
    switch. Everywhere else — the LFO panel, the synth FX rack — the lockable
    knob **leads its row**, so the glyph hangs into padding the container
    already has and overlaps nothing.
  - **Why not reserve it everywhere.** A margin is layout even when the glyph
    is not: 20 px on the knob root shifts the dial off the centre its
    neighbours are centred on. On the LFO's RATE/AMT pair that read as a
    misalignment of the panel, not as room for a glyph. A gutter is a fact
    about a *row's* packing, so the row declares it.
  - Where it is reserved, it is **permanent, not lock-dependent** — held whether
    or not the lock is engaged. REQ-9 holds either way, since the glyph is out
    of flow: engaging a lock moves nothing on any surface.

## Technical design

### Contract / public interface

```yaml
# src/utils/tempo.ts (pure, DOM-free — already imported by the audio layer)
syncedRateHz(syncIndex, bpm): number | null      # existing, unchanged
syncedTimeSec(syncIndex, bpm): number | null     # NEW — the seconds half, same guards
syncedValue(syncIndex, bpm, q: TempoQuantity): number | null   # NEW — dispatches on q
nearestDivision(value, bpm, q: TempoQuantity): number          # NEW — 1..18, log-space

# src/state/tempo-lock.ts
TEMPO_LOCKS: Record<string, TempoQuantity>       # param id -> 'freq' | 'time'
tempoLockFor(paramId): TempoQuantity | undefined
syncIdFor(paramId): string                       # 'fx.delay.time' -> 'fx.delay.sync'

# src/audio/tempo-bind.ts
bindTempoLocked(bus, valueId, syncId, q, apply: (v: number) => void): void

# src/ui/components/tempo-lock.ts
createTempoLock(bus, paramId, q, host: TempoLockHost): { lock, chip, destroy }
TempoLockHost = { setSynced(on: boolean): void; repaint(): void }
```

`Knob` gains **no new option**. It looks up `tempoLockFor(opts.paramId)` in its
constructor and, on a hit, mounts `lock` into the label row and `chip` after the
dial. `host.setSynced` toggles the `synced` class (which hides `.dial` and shows
`.chip`); `host.repaint` re-runs `render` so `.num` picks up the derived value.

### Data shapes

```yaml
# The nine lockable params. Quantity is the knob's own unit, not the division's.
TEMPO_LOCKS:
  lfo.rate:                 freq
  lfo2.rate:                freq
  fx.wah.rate:              freq
  fx.phaser.rate:           freq
  fx.drum.phaser.rate:      freq
  fx.sampler.phaser.rate:   freq
  fx.delay.time:            time
  fx.drum.delay.time:       time
  fx.sampler.delay.time:    time

# The sync param each one pairs with — registered in params.ts, one per family.
<prefix>.sync: { discrete, labels: SYNC_LABELS, range: 0..18, default: 0 }
#   lfo.sync / lfo2.sync          existing (lfo.md REQ-9), unchanged
#   fx.wah.sync                   NEW, longhand beside fx.wah.rate
#   fx.{,drum.,sampler.}phaser.sync  NEW, one line in phaserParams(prefix)
#   fx.{,drum.,sampler.}delay.sync   NEW, one line in delayParams(prefix)
```

Six of the seven new params come from the two existing factories, so range,
default, taper and labels cannot drift between the synth, drum and sampler copies
— the same structural guarantee `lfoParams(prefix)` gives the two LFOs
([lfo](lfo.md) REQ-10).

### Gesture inventory

Required by [`design-an-interaction`](../recipes/design-an-interaction.md) step 1.
A `—` is a decision; a blank would be an oversight.

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| Tap the note glyph (free) | Lock to the division nearest the current value | SYNC switch on hardware/plug-in delays |
| Tap the note glyph (locked) | Unlock; the knob returns to its stored value | Same switch, released |
| Tap the chip | Open the division menu | It **is** a `Dropdown` toggle ([dropdown](dropdown.md) REQ-1) |
| Pick a division | Sets `<prefix>.sync`, closes the menu | [dropdown](dropdown.md) REQ-2 |
| Arrows / Home / End in the menu | Walk the divisions | [dropdown](dropdown.md) REQ-8, unchanged |
| Escape in the menu | Close, focus returns to the chip | [dropdown](dropdown.md) REQ-3/REQ-6 |
| Drag the dial (free) | Sets the value, full range | This knob, unchanged |
| Drag the dial (locked) | — the dial is not on screen; there is nothing to drag | See below |
| Double-tap the dial (free) | Reset to baseline ([param-reset-baseline](param-reset-baseline.md) REQ-6) | This knob, unchanged |
| Double-tap the chip | — no reset, no unlock | Double-tap is the dial's gesture; the chip is a menu toggle |
| Long-press either | — | Nothing is hidden behind a hold here |
| Hover | — | Law 6: no hover-only affordance |
| Tap the gutter beside the glyph | Hits the glyph's padded target, so it toggles | ADR-014 law 6: the ink is 9x11, the target is not |

Law 2 holds because the two states are **different targets**, not one target with
a mode: the dial is absent while locked and the chip is absent while free, so no
gesture's outcome depends on state the user cannot see. That is also why the dial
is hidden rather than dimmed — a dimmed dial still accepts a double-tap, and a
reset that silently changes a value you cannot hear is precisely the invisible-
state defect [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2 names.

The glyph itself is the law 5 affordance: the mode is lit, at the control, and it
ends when the user ends it.

### Layer touchpoints & ordering

```yaml
state:  src/state/tempo-lock.ts     # the table. No imports from ui/ or audio/.
utils:  src/utils/tempo.ts          # pure math, shared by audio, ui and the badges
audio:  src/audio/tempo-bind.ts     # bindTempoLocked
        src/audio/lfo.ts            # applyRate re-expressed through it (same behaviour;
                                    #   the apply callback still drives pwm.setRate)
        src/audio/effects/{wah,phaser,delay}.ts   # bind() routes through it
ui:     src/ui/components/knob.ts   # self-wires, after the modDepthDeps block
        src/ui/components/tempo-lock.ts
        src/ui/panels/lfo-panel.ts  # the standalone sync ParamDropdown is REMOVED,
                                    #   as is rate.setDisabled(sync > 0)
        src/ui/onboarding/help-widgets.ts   # a locked badge sets .sync, not the rate
```

Ordering constraints:

- The lock is built **before** the knob's value subscription, so the first paint
  already shows the derived readout and no second repaint is needed — the same
  reason `applyUiMax` runs before `bus.subscribe` today.
- `bindTempoLocked` subscribes `transport.bpm` **last**, after the value and sync
  subscriptions, so the immediate-fire on each of the first two cannot read a
  half-built closure.
- The LFO's `pulseRateDisclosure` soft ceiling ([knob-soft-ceiling](knob-soft-ceiling.md))
  is untouched and cannot collide: it paints the dial, which is off screen
  whenever the lock is engaged.

### Persistence

None beyond the `<prefix>.sync` params, which persist exactly like any other
patch param — snapshotted into presets, songs and share links by the generic
`ParamBus` path, validated against their registered `0..18` range, no
special-casing anywhere. The **lock's own state is not stored**: it is `sync > 0`,
recomputed on every load. Nothing about it reaches `localStorage`.

### Note — the divisions are meter-neutral, except `1/1`

`utils/tempo.ts` expresses every division in **quarter-note beats**, which is
meter-neutral: `1/8` is an eighth in 7/8 exactly as in 4/4. The one exception is
`'1/1', beats: 4` — that is a *whole note*, which is correct nomenclature but is
no longer *a bar* once [meter](meter.md) lets a bar be 12 or 14 sixteenths.

Deliberately left alone. `SYNC_LABELS` is **append-only** — its index is a stored
value in every preset, song and share link — so a meter-aware "1 BAR" division
would have to be *appended*, never substituted for `1/1`. Tempo-locked LFOs and
delays are free-running (`audio/tempo-bind.ts` resolves a period in seconds and
never bar-phase-resets), so they behave in 7/8 exactly as they do today: in time,
but not aligned to the bar line.

## Scenarios (BDD)

```gherkin
Scenario: Locking does not jump the sound
  Given transport.bpm 120 and fx.delay.time 0.26 s
  When the user taps the note glyph on the Delay TIME knob
  Then fx.delay.sync becomes 1/4 T (0.333 s — the nearest division)
  And fx.delay.time is still exactly 0.26
# pinned by: tests/ui/tempo-lock.test.ts

Scenario: A locked rate follows the tempo
  Given fx.phaser.sync is 1/8 and transport.bpm is 120
  Then the phaser LFO runs at 4 Hz, and at 2 Hz once the tempo halves
# pinned by: tests/audio/fx-tempo-lock.test.ts, e2e/fx-tempo-lock.spec.ts

Scenario: The chip replaces the dial and the readout stays true
  Given a locked Delay TIME knob at 1/8 D, 120 BPM
  Then the dial is hidden and the chip reads "1/8D"
  And the knob's readout reads "375ms"
# pinned by: tests/ui/tempo-lock.test.ts

Scenario: Unlocking restores the stored value (REQ-4)
  Given a knob locked at 1/8 whose stored fx.wah.rate is 6.8
  When the user taps the glyph again
  Then fx.wah.sync is 0 and the wah runs at 6.8 Hz — the value was never rewritten
# pinned by: tests/ui/tempo-lock.test.ts, tests/audio/fx-tempo-lock.test.ts

Scenario: Free is the default and changes nothing (REQ-8, ADR-006)
  Given a preset saved before this feature, with no fx.*.sync keys
  When it is loaded and the tempo changes
  Then every effect keeps the rate its knob sets
# pinned by: tests/state/preset.test.ts

Scenario: An unreachable division is greyed, not removed (edge, REQ-6)
  Given transport.bpm 60, where 1/1 is 4 s and fx.delay.time maxes at 1.5
  When the division menu opens
  Then the "1/1" option is present and disabled
  And the currently selected division is unchanged
# pinned by: tests/ui/tempo-lock.test.ts

Scenario: A knob on a free-valued param grows nothing (REQ-1)
  Given a Knob on filter.cutoff, which is not in TEMPO_LOCKS
  Then its DOM holds no lock button and no chip
  And it takes no transport.bpm subscription
# pinned by: tests/ui/tempo-lock.test.ts

Scenario: A lockable knob lines up with its neighbours (v2, REQ-10, regression)
  Given the drum machine's PHASER group, whose knobs are 22px
  When it is engaged
  Then all four knobs share one top edge, one height, and one dial baseline
  And the label of the one carrying a lock is still on a single line
# pinned by: e2e/fx-tempo-lock.spec.ts

Scenario: Locking never reflows the row (REQ-9)
  Given the synth Phaser group, four knobs in a wrapping flex row
  When RATE is locked to the widest division label
  Then the group still lays out on one line
# pinned by: e2e/fx-tempo-lock.spec.ts

Scenario: The help badge sets the division while locked (REQ-5)
  Given the fx.delay.time sweet-spots badge and a locked Delay
  When the user clicks the "1/8" row
  Then fx.delay.sync becomes 1/8 — not fx.delay.time, which would do nothing
# pinned by: tests/ui/tempo-sync.test.ts
```

## Tests & verification

- Unit: `tests/ui/tempo-lock.test.ts` (one case per gesture-inventory row),
  `tests/audio/fx-tempo-lock.test.ts`, plus the existing `tests/ui/tempo-sync.test.ts`
  and `tests/state/preset.test.ts` extensions — `npm test`
- E2E: `e2e/fx-tempo-lock.spec.ts`, and `e2e/lfo-sync.spec.ts` updated (its
  `aria-disabled` assertion is replaced by the chip) — `npm run e2e`
- Typecheck: `npm run typecheck`
- **By ear** ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md),
  [`verify-audio-by-ear`](../recipes/verify-audio-by-ear.md)): `npm run bench:audio`,
  A/B'd against a bypassed baseline with the other lanes muted. Two claims only
  listening settles — a locked delay/phaser/wah lands *on* the grid, and engaging
  the lock does not audibly jump the effect (REQ-4's nearest-division pick is a
  perceptual claim, not an arithmetic one).
- **By eye**: `npm run dev` — lock every one of the nine at 1440 px, at the
  ≤992 px breakpoint (36 px knobs, rack drops to 2 columns) and in the drum and
  sampler header groups (22 px knobs, the tightest case). REQ-9 fails visibly:
  watch the Phaser group for a wrapped knob.

## Open questions / future

- The **XY pad** and the **motion sequencer** can both drive a lockable param.
  Automating `fx.delay.time` while it is locked writes a value nothing reads —
  harmless, but silent. Neither surface shows the lock state today.
- A **global** "lock everything to the grid" gesture is the obvious next ask and
  is deliberately not built: it would need a rule for what each effect's nearest
  division is, and REQ-4 answers that only per control.
- `syncedValue` dispatches on `TempoQuantity` at every call. If a third quantity
  ever appears, the table in `tempo.ts` is the place to grow, not this dispatch.
