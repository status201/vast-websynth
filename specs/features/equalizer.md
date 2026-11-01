# Equalizer (per-lane drawable EQ — sequencer · drums · sampler)

```yaml
id: equalizer
status: implemented
version: 5
owner: core
related:
  - architecture
  - effects              # the chain this heads, on all three buses
  - scope                # the log frequency axis + zone names it reuses
  - machine-status       # the tab LED (setIndicator / MachineState)
  - testids
  - runtime-performance  # the repaint contract
  - presets              # REQ-a-factory-preset-sets-the-full-sound
  - param-catalogue      # registration order is a published artefact
  - drum-kits            # the "named table of bus writes" precedent
  - dropdown
  - section-title
  - onboarding           # the badges live there (REQ-the-equalizer-carries-seven-badges)
  - ../decisions/adr-006-no-op-param-defaults
  - ../decisions/adr-008-components-self-wire-params
  - ../decisions/adr-010-musical-stable-cheap-dsp
  - ../decisions/adr-012-true-bypass-disconnects
  - ../decisions/adr-014-dont-make-me-think
source:
  - src/state/eq.ts                    # band table + the response math, shared
  - src/state/eq-presets.ts            # named curves, applied through the bus
  - src/audio/effects/eq.ts            # the Equalizer insert effect
  - src/audio/effects/fx-chain.ts      # chain membership, head of all three
  - src/state/params.ts                # eqParams(prefix), three call sites
  - src/state/preset.ts                # every factory bank pins fx.eq.on: 0
  - src/ui/panels/eq-panel.ts          # the EQUALIZER section
  - src/ui/components/eq-graph.ts      # the drawable curve
  - src/ui/components/canvas-text.ts   # haloText, shared with Scope
  - src/ui/components/scope.ts
  - src/ui/components/tabs.ts          # TabOptions.title (a section-title) + .pageClass
  - src/ui/shell/bottom.ts             # buildBottom mounts it
  - src/ui/styles/eq.module.css
  - src/ui/styles/bottom.module.css    # .bottom column + --wheel-col
```

A bypass-able **equalizer on each of the three lane buses**, drawn as a curve
rather than dialled as knobs, in its own collapsible section. The insert machinery
(`Effect`, `BypassWrapper`, true bypass, `bindBypassMix`) is [effects](effects.md).
This spec covers only what an EQ adds.

## Background / Why

The only bus-wide filter was the master DJ sweep ([performance](performance.md)).
There was no way to take the mud out of a drum bus or tame hiss on a sample. The
Spectrum ([scope](scope.md)) names four problem zones on a log axis (MUD, BOXY,
NASAL, HARSH). The EQ's band centres sit inside those zones, on the same axis, so
"see it, fix it" is one gesture. In ADR-010's order: *musical* means shelves at
the ends, real LP/HP and the head of the chain. *Stable* means native biquads, no
worklet and no `cancelScheduledValues`. *Cheap* means ten biquads per lane, free
while bypassed, and a curve computed from bus values with no analyser and no loop.

## Requirements

- **REQ-one-equalizer-per-lane** — **One `Equalizer` per lane, first in its
  insert chain** ([effects](effects.md) REQ-the-synth-chain-order owns the order).
  It is an ordinary chain member: `fx-chain.ts` owns membership, order and
  prefix, `bind` self-wires (ADR-008), and `src/audio/engine.ts` is untouched.
  Head, not tail: it shapes what Dirt bites on, and on the drum bus a highpass
  ahead of the compressor stops the kick pumping the kit. It is also the cheap
  position, since the synth chain is 1-channel at its head.
- **REQ-eight-fixed-eq-bands** — **Eight fixed bands: a low shelf, six peaks, a
  high shelf**, with every named Spectrum zone containing one. That is what makes
  the De-Mud / De-Box / De-Nasal / De-Harsh presets meaningful.

  | Band | Hz | Type | Zone / role |
  | --- | --- | --- | --- |
  | `b0` | 60 | `lowshelf` | sub, rumble |
  | `b1` | 150 | `peaking` | **MUD** (100–200) |
  | `b2` | 400 | `peaking` | **BOXY** (300–500) |
  | `b3` | 900 | `peaking` | **NASAL** (800–1000) |
  | `b4` | 2000 | `peaking` | presence, attack |
  | `b5` | 5000 | `peaking` | **HARSH** (4000–6000) |
  | `b6` | 8000 | `peaking` | sibilance, hiss |
  | `b7` | 12000 | `highshelf` | air |

  Centres are fixed, not movable, because drawing a line maps onto a fixed grid
  unambiguously. Surgical work is Q's job (REQ-one-q-knob-over-the-bands). The
  table lives once, in `state/eq.ts`, and is read by **both** the filters and the
  drawn curve, so they cannot disagree.
- **REQ-a-real-highpass-and-lowpass** — Two extra biquads at `Q.value = 0.7`
  (the DJ filter's shape) bracket the bands. That `0.7` is **in decibels**: Web
  Audio reads `Q` in dB for `lowpass`/`highpass`, linearly for `peaking`, and not
  at all for the shelves (fixed `S = 1`). Get it wrong and the graph lies
  convincingly. That is why `eqStageCoeffs` spells the three cases out
  separately. `frequency.value` is written **once** (`EQ_HP_REF` 20 Hz, `EQ_LP_REF`
  20 kHz). The knob drives `detune = 1200 * log2(target / ref)` (ADR-027). Every
  other write is a `setTargetAtTime` at `RAMP_SMOOTH`, and nothing here calls
  `cancelScheduledValues`.
- **REQ-one-q-knob-over-the-bands** — **One knob, labelled `Q`, over the six
  peaking bands' `Q`**: 0.4 overlaps into a tilt, 8 is a notch. The shelves
  ignore `Q` by specification, so the knob does not move them. The param id stays
  `<prefix>.width`, because it is written into every file and the catalogue
  (ADR-006). Only the label says `Q`. Up means narrower, as on the Wah.
- **REQ-the-eq-is-a-no-op-by-default** — `<prefix>.on` defaults to `0`, every band
  to `0 dB`, HP to its floor and LP to its ceiling. So no existing file changes
  (ADR-006), and true bypass disconnects all ten filters (ADR-012). `< 0.5` is
  bypassed ([effects](effects.md) REQ-fx-on-below-half-is-bypassed).
- **REQ-eq-params-come-from-one-factory** — One `eqParams(prefix)` factory, called
  for `fx.eq`, `fx.drum.eq` and `fx.sampler.eq`. That is twelve ids per lane, each
  call **first** in its chain's block of `registerDefaults()`, so the published
  order mirrors signal order ([param-catalogue](param-catalogue.md)
  REQ-registration-order-is-published). `NON_PATCH_PREFIXES` already contains
  `fx.drum.` and `fx.sampler.`, so `fx.eq.*` is part of the sound (presets) and the
  other two are song-level. The prefix was chosen for that.
- **REQ-the-eq-declares-a-longer-drain** — `drainSeconds()` returns `0.12`. A
  biquad rings for about `Q / (pi * f0)`, which is ~17 ms for the 150 Hz band at
  Q 8, compounded down ten filters. That exceeds `DRAIN_DEFAULT_S`
  ([effects](effects.md) REQ-a-bypassed-effect-drains-before-disconnect).
- **REQ-no-auto-makeup-gain** — Engaging a boosted EQ is a level step **by
  design**: the deliberate exception to [effects](effects.md)
  REQ-toggling-an-effect-must-not-step-the-level, since the level change *is* the
  effect. Each lane's own volume (`seq.master`, `drum.master`, `sampler.master`)
  is the makeup control. The ear check confirms a clean step, not a click.
- **REQ-the-eq-section-is-a-folded-tab-container** — One `TabContainer`, folded by
  default (`collapsedByDefault: () => true`). Header: `EQUALIZER ●SEQUENCER ●DRUM
  MACHINE ●SAMPLER`. `TabOptions.title` is a [section-title](section-title.md)
  `{ text: 'Equalizer', icon: 'sliders' }`, rendered **first** in `.bar`, with
  the caret last. The heading is white, never a tab colour, so it never reads as
  a fourth tab ([section-title](section-title.md) REQ-heading-is-white-and-inert).
- **REQ-the-eq-tab-led-only-indicates** — The tab LED indicates and never toggles
  (`pointer-events: none`, as on the machine tabs). The switch is a `Switch` in
  the tab body (ADR-014 laws 2 and 6).

  | LED | Meaning |
  | --- | --- |
  | `off` | `<prefix>.on < 0.5` — bypassed |
  | `muted` | engaged, but the curve is flat and both filters are open (`eqIsFlat`) |
  | `on` | engaged and shaping |
- **REQ-eq-tab-ids-are-namespaced** — Tab ids are `eq-seq`, `eq-drums`,
  `eq-sampler`, because `tab-seq` / `panel-seq` etc. belong to the pattern row
  ([panel-tabs](panel-tabs.md) REQ-panel-tab-testids-are-prefixed solves the same
  collision with a prefix).
- **REQ-the-curve-is-drawn-by-dragging** — A drag writes band gains. Pointer Y
  maps to dB, and every band crossed since the last move is written,
  interpolated, so a fast sweep skips none. See the gesture inventory.
- **REQ-the-graph-computes-from-bus-values** — The graph subscribes its twelve
  params. A change marks it dirty and schedules **one** coalesced rAF, so a
  preset repaints once. There is no `AnalyserNode`, no loop and no `StudioApi`
  addition (ADR-009, [architecture](../architecture.md)
  REQ-ui-and-audio-never-call-each-other). Repaints are gated on visibility, with
  a folded section counting as off screen
  ([runtime-performance](runtime-performance.md) REQ-no-work-for-offscreen-dom),
  and re-sync once on reveal.
- **REQ-the-drawn-curve-is-exact** — `BiquadFilterNode` is specified to use the
  RBJ cookbook, so `eqResponseDb` is the filter, not a model of it. Two pins:
  `tests/state/eq.test.ts` runs the difference equation from `eqStageCoeffs`
  through a DFT against `eqResponseDb`, and `e2e/equalizer.spec.ts` compares a
  real `getFrequencyResponse()` in an `OfflineAudioContext` with `data-eq-curve`
  within 0.5 dB. Neither alone is enough.
- **REQ-eq-presets-are-a-table-of-bus-writes** — Presets are a named table of bus
  writes ([drum-kits](drum-kits.md) shape), with no new audio code or persistence.
  `applyEqPreset` also writes `${prefix}.on = 1`, because picking one is intent to
  hear it. The dropdown shows `Custom` as soon as the curve leaves the named
  shape.
- **REQ-the-eq-is-a-third-bottom-row** — The section is the middle item of the
  `.bottom` flex column (scope row · EQ · keyboard), sized by its content. The
  scope's `ResizeHandle` still sizes only the scope row via `--scope-h`. A grown
  EQ eats the keyboard's slack like a grown scope does
  ([scope](scope.md) REQ-a-scope-resize-handle). Folded, it costs its bar.
- **REQ-every-preset-bank-pins-eq-off** — Every factory preset bank pins
  `fx.eq.on: 0` ([presets](presets.md) REQ-a-factory-preset-sets-the-full-sound).
  The drum and sampler EQs are song-level and unaffected.
- **REQ-the-eq-page-mirrors-the-scope-row** (v2) — The page uses the bottom row's
  grid: the controls sit in a column as wide as the wheels box, and the graph's
  left edge lands on the scope canvas's. What keeps that exact:
  - one gutter, `--wheel-col`, declared on `.bottom` and read by both;
  - the column is `calc(var(--wheel-col) - 1px)`, clearing the panel border;
  - the tab shell's horizontal padding is removed for this panel through
    `TabOptions.pageClass`.

  **Height comes from `--scope-h`**, so the scope's grip resizes both. This is a
  deliberate coupling: two panels meant to read as one grid must not resize
  apart. The control stack fits the 130 px floor (`SCOPE_H_MIN`): three size-28
  knobs fill the 112 px column. The dropdown's `min-width` is reset from this
  side.
- **REQ-the-eq-explains-itself-through-badges** (v3) — Seven badges: `eq` on the
  section root, and per lane `eq.graph.<lane>` and `eq.knobs.<lane>` (the knob row
  carries `data-help`). [onboarding](onboarding.md)
  REQ-the-equalizer-carries-seven-badges owns them. The graph topic's band list
  is generated from `EQ_BANDS`.

## Technical design

### Contract / public interface

```yaml
# src/state/eq.ts — PURE. No DOM, no audio nodes. Imported by BOTH layers.
EqBand: { hz: number, type: BiquadFilterType }
EQ_BANDS: readonly EqBand[]        # length 8
EQ_BAND_COUNT: number
EQ_GAIN_MAX: 18                    # dB, symmetric
EQ_HP_REF: 20                      # Hz — the highpass's fixed reference
EQ_LP_REF: 20000
EQ_FILTER_Q_DB: 0.7                # HP/LP shape, in DECIBELS
EQ_WIDTH_DEFAULT: 1
detuneCents(targetHz, refHz): number             # 1200 * log2(target / ref)
eqResponseDb(s, hz, sampleRate): number          # composite magnitude, dB
eqStageCoeffs(type, f0, qOrQdb, gainDb, sampleRate): BiquadCoeffs
eqIsFlat(s: EqSettings): boolean   # the LED's `muted` state
readEqSettings(bus, prefix): EqSettings

EqSettings:
  gains: readonly number[]         # dB per band
  width: number
  hp: number                       # Hz
  lp: number                       # Hz

# src/state/eq-presets.ts
EqPreset: { b: readonly number[], hp?: number, lp?: number, width?: number }
EQ_PRESETS: Record<string, EqPreset>
EQ_PRESET_CUSTOM: 'Custom'         # the sentinel; never a table entry
EQ_PRESET_FLAT: 'Flat'
eqPresetNames(): string[]
applyEqPreset(bus, prefix, name): void   # writes the curve AND `.on` = 1
matchEqPreset(s: EqSettings): string     # a table name, or EQ_PRESET_CUSTOM

# src/audio/effects/eq.ts
class Equalizer extends WrappedEffect
  constructor(ctx)
  setBand(i, db), setWidth(q), setHighpass(hz), setLowpass(hz)
  bind(bus, prefix)                # bindBypassMix + 11 subscribes; no setMix
  # protected drainSeconds() -> 0.12

# src/ui/components/tabs.ts
TabOptions.title?: SectionTitleOptions  # rendered first in `.bar`
TabOptions.pageClass?: string      # extra class on every page shell

# src/ui/components/canvas-text.ts
haloText(ctx, text, x, y, fill): void

# src/ui/components/eq-graph.ts
class EqGraph
  constructor({ bus, prefix, lane, sampleRate })
  el: HTMLElement
  setVisible(v: boolean): void
  destroy(): void

# src/ui/panels/eq-panel.ts
buildEqPanel(bus, engine: StudioApi): { el, tabs: TabContainer, destroy(): void }
  # reads engine.ctx.sampleRate only — already on the facade
```

### Data shapes (registry)

```yaml
# Per prefix in {fx.eq, fx.drum.eq, fx.sampler.eq}
<prefix>.on:     { min: 0, max: 1, default: 0, step: 1, taper: discrete, labels: [off, on] }
<prefix>.hp:     { min: 20, max: 2000, default: 20, taper: exp }        # default = off
<prefix>.b0..b7: { min: -18, max: 18, default: 0 }                      # dB, fmtDbRaw
<prefix>.lp:     { min: 200, max: 20000, default: 20000, taper: exp }   # default = off
<prefix>.width:  { min: 0.4, max: 8, default: 1 }                       # labelled Q
```

`hp` and `lp` format as `off` at their no-op extreme (law 5).

### Layer touchpoints & ordering

```yaml
state/eq.ts               -> read by audio/effects/eq.ts AND ui/components/eq-graph.ts
state/params.ts           -> eqParams(prefix) x3, each FIRST in its chain's block
audio/effects/eq.ts       -> span processedIn -> hp -> b0..b7 -> lp -> processedOut
audio/effects/fx-chain.ts -> 'eq' first in all three order arrays
ui/shell/bottom.ts        -> buildBottom appends the section between `top` and `kbWrap`
```

The graph's `bus.subscribe` calls fire immediately, and every page stays mounted
and subscribed. So a load repaints a hidden tab too
([panel-tabs](panel-tabs.md) REQ-every-page-stays-in-the-dom).

### Persistence

```yaml
localStorage:
  websynth.ui.collapsed.eq : the section's fold state   # ui/components/collapse-toggle.ts
not_persisted:
  the selected tab          # session-only view state
  the selected preset name  # derived by matchEqPreset, so it cannot go stale
```

The 36 params ride `ParamBus.snapshot()` into presets, songs, share links and the
autosave. There is no serialization code.

## Gesture inventory (ADR-014)

| Gesture | Target | Outcome |
| --- | --- | --- |
| drag | the graph | Write band gains: pointer Y → dB, interpolating across every band crossed since the last move. |
| tap | the graph | A zero-length drag — sets the one band under the pointer. |
| `Shift` + drag | the graph | Fine: quarter the dB travel (the scratch graph's precedent). |
| double-tap | a band column | That band back to 0 dB ([param-reset-baseline](param-reset-baseline.md) precedent). |
| pointermove, no button | the graph | Hover readout of Hz and dB ([scope](scope.md) REQ-hovering-reads-out-a-frequency). Desktop only, never the sole route. |
| wheel | the graph | **Nothing** — the bottom row scrolls the page. |
| right-click / long-press | the graph | **Nothing.** |
| tap | a tab's LED | **Nothing** (REQ-the-eq-tab-led-only-indicates). |
| tap | a tab | Show that lane's EQ, expanding the section first if folded. |
| tap | the bar, off a tab | Fold / unfold. |
| tap | the ON switch | Engage or bypass that lane's EQ. The only control that does. |
| pick | the preset dropdown | Write the named curve **and** engage. |
| tap | RESET | That lane's curve flat, filters open; `.on` untouched. |

Precedent (law 4): a finger across a graphic EQ's fader bank, and the draw mode of
software EQs. Law 3: there is **no undo for a drag**, since `ParamBus` has none.
The mitigations are band double-tap and lane RESET. Law 6: band columns are
~42 px on a 360 px phone, which is acceptable for a sweep surface.

## Scenarios (BDD)

```gherkin
Scenario: The EQ is first in every chain and the engine is untouched
  Given the three chain factories
  Then each one's order array begins with 'eq'
  And each binds it at fx.eq / fx.drum.eq / fx.sampler.eq
# pinned by: tests/audio/effects/eq.test.ts

Scenario: The band span is wired highpass, eight bands, lowpass
  Given a new Equalizer
  Then processedIn feeds hp, hp feeds b0, b7 feeds lp, and lp feeds processedOut
  And the eight band nodes carry the types and frequencies of EQ_BANDS
# pinned by: tests/audio/effects/eq.test.ts

Scenario: The filters sweep on detune and never rewrite frequency (REQ-a-real-highpass-and-lowpass)
  Given a bound Equalizer
  When the hp and lp params move
  Then only detune is written after construction
  And frequency still reads EQ_HP_REF and EQ_LP_REF
# pinned by: tests/audio/effects/eq.test.ts

Scenario: A band gain change is ramped, never cancelled (REQ-a-real-highpass-and-lowpass)
  Given a bound Equalizer
  When a band gain changes
  Then it is written with setTargetAtTime and cancelScheduledValues is never called
# pinned by: tests/audio/effects/eq.test.ts, tests/audio/no-unanchored-cancel.test.ts

Scenario: Q (`.width`) moves the peaking bands only (REQ-one-q-knob-over-the-bands)
  Given a bound Equalizer
  When width changes
  Then Q is written on the six peaking bands and on neither shelf
# pinned by: tests/audio/effects/eq.test.ts

Scenario: The drain outlasts the slowest band's ring-down (REQ-the-eq-declares-a-longer-drain)
  Given the highest Q and the lowest peaking band
  Then drainSeconds exceeds Q / (pi * f0) for it
# pinned by: tests/audio/effects/eq.test.ts

Scenario: A boosted curve is a level step on engage, and that is intended (REQ-no-auto-makeup-gain)
  Given a curve with a boosted band
  Then the effect declares no makeup gain node between its input and output
# pinned by: tests/audio/effects/eq.test.ts

Scenario: Every named Spectrum zone contains a band (REQ-eight-fixed-eq-bands)
  Given SPECTRUM_ZONES and EQ_BANDS
  Then each zone has at least one peaking band inside its from..to range
# pinned by: tests/state/eq.test.ts

Scenario: Every default is a no-op (REQ-the-eq-is-a-no-op-by-default)
  Given a ParamBus with registerDefaults applied
  Then every <prefix>.on is 0, every band gain is 0, hp is at its min and lp at its max
  And eqResponseDb reads 0 dB across the whole axis at those values
# pinned by: tests/state/eq.test.ts

Scenario: A boosted band reads its own gain at its own centre (REQ-the-drawn-curve-is-exact)
  Given a single band boosted by 12 dB at the default width
  Then eqResponseDb at that band's centre is 12 dB
  And it falls back toward 0 dB an octave either side
# pinned by: tests/state/eq.test.ts

Scenario: Raising Q narrows the skirt without moving the peak (REQ-one-q-knob-over-the-bands)
  Given one boosted band
  When `.width` rises
  Then the response an octave away shrinks while the response at the centre does not
# pinned by: tests/state/eq.test.ts

Scenario: The EQ registers 12 params on each of three prefixes (REQ-eq-params-come-from-one-factory)
  Given registerDefaults
  Then fx.eq, fx.drum.eq and fx.sampler.eq each carry on/hp/b0..b7/lp/width
# pinned by: tests/state/eq.test.ts

Scenario: The synth EQ is a patch param and the other two are not (REQ-eq-params-come-from-one-factory)
  Given isPatchParam
  Then fx.eq.b0 is a patch param
  And fx.drum.eq.b0 and fx.sampler.eq.b0 are not
# pinned by: tests/state/eq.test.ts

Scenario: An engaged but flat EQ is distinguishable from a shaping one (REQ-the-eq-tab-led-only-indicates)
  Given the registered defaults
  Then eqIsFlat is true
  When any band, hp or lp moves off its default
  Then eqIsFlat is false
# pinned by: tests/state/eq.test.ts

Scenario: Applying a preset writes the curve and engages the EQ (REQ-eq-presets-are-a-table-of-bus-writes)
  Given a lane whose EQ is off
  When Hiss Removal is applied
  Then its lp and band gains are written and .on becomes 1
# pinned by: tests/state/eq-presets.test.ts

Scenario: Flat reproduces the registered defaults exactly (REQ-eq-presets-are-a-table-of-bus-writes)
  Given a shaped curve
  When Flat is applied
  Then every band gain, hp, lp and width equals its registered default
# pinned by: tests/state/eq-presets.test.ts

Scenario: Every preset writes only registered ids, within range (REQ-eq-presets-are-a-table-of-bus-writes)
  Given every entry in EQ_PRESETS
  Then each names EQ_BAND_COUNT gains inside +/-EQ_GAIN_MAX
  And each hp/lp lies inside its registered range
# pinned by: tests/state/eq-presets.test.ts

Scenario: A curve that matches no preset reports Custom (REQ-eq-presets-are-a-table-of-bus-writes)
  Given a hand-drawn curve matching no table entry
  Then matchEqPreset returns Custom
  And a curve equal to a table entry returns that entry's name
# pinned by: tests/state/eq-presets.test.ts

Scenario: The section is folded on first load and remembers a choice (REQ-the-eq-section-is-a-folded-tab-container)
  Given no stored websynth.ui.collapsed.eq
  Then the section renders collapsed
  When the user unfolds it and the section is rebuilt
  Then it renders expanded
# pinned by: tests/ui/eq-panel.test.ts, e2e/equalizer.spec.ts

Scenario: The header reads EQUALIZER before the three tabs (REQ-the-eq-section-is-a-folded-tab-container)
  Given the built section
  Then the bar's first child is the title and the tabs follow it
  And the caret is the bar's last child
# pinned by: tests/ui/eq-panel.test.ts

Scenario: The row title reads as a heading, not a fourth tab (REQ-the-eq-section-is-a-folded-tab-container)
  Given the equalizer's tab bar
  Then its first child is the shared section title, led by the sliders icon
  And that heading is var(--text), undimmed, a colour no tab state uses (section-title.md REQ-heading-is-white-and-inert)
# pinned by: tests/ui/eq-panel.test.ts, tests/ui/section-title.test.ts

Scenario: The tab LED tracks the param and reads muted when flat (REQ-the-eq-tab-led-only-indicates)
  Given a lane whose EQ is off
  Then its tab LED reads off
  When the EQ is switched on with a flat curve
  Then it reads muted
  When a band is boosted
  Then it reads on
# pinned by: tests/ui/eq-panel.test.ts

Scenario: EQ tab ids never shadow the pattern row's (REQ-eq-tab-ids-are-namespaced)
  Given the built section
  Then its testids are tab-eq-seq / eq-drums / eq-sampler and panel-eq-*
  And no element mints a bare tab-seq, tab-drums or tab-sampler
# pinned by: tests/ui/eq-panel.test.ts

Scenario: The sharpness knob reads Q, and its row anchors the badge (REQ-one-q-knob-over-the-bands, REQ-the-eq-explains-itself-through-badges)
  Given the built section
  Then each lane's third knob is bound to <prefix>.width and labelled Q
  And each lane's knob row carries data-help="eq.knobs.<lane>"
  And no element still carries the orphaned data-help="fx.eq"
# pinned by: tests/ui/eq-panel.test.ts

Scenario: Editing away from a preset shows Custom (REQ-eq-presets-are-a-table-of-bus-writes)
  Given Hiss Removal is selected
  When one band is changed
  Then the dropdown reads Custom
# pinned by: tests/ui/eq-panel.test.ts

Scenario: RESET flattens the lane and leaves the switch alone (REQ-eq-presets-are-a-table-of-bus-writes)
  Given an engaged, shaped EQ
  When RESET is pressed
  Then the curve returns to flat and .on is still 1
# pinned by: tests/ui/eq-panel.test.ts

Scenario: Dragging across the graph writes every band it crosses (REQ-the-curve-is-drawn-by-dragging)
  Given the graph for a lane
  When the pointer is dragged from one band to another several columns away in one move
  Then every band between them is written, none skipped
# pinned by: tests/ui/eq-graph.test.ts

Scenario: Double-tapping a band resets it (REQ-the-curve-is-drawn-by-dragging)
  Given a band at -9 dB
  When it is double-tapped
  Then it returns to 0 dB and its neighbours are untouched
# pinned by: tests/ui/eq-graph.test.ts

Scenario: A wheel over the graph changes nothing (REQ-the-curve-is-drawn-by-dragging)
  Given the graph
  When a wheel event arrives
  Then no param is written
# pinned by: tests/ui/eq-graph.test.ts

Scenario: A dozen param writes repaint the graph once (REQ-the-graph-computes-from-bus-values)
  Given the graph is visible
  When a preset writes twelve params in one turn
  Then exactly one repaint is scheduled
# pinned by: tests/ui/eq-graph.test.ts

Scenario: A hidden graph does not repaint, and re-syncs on reveal (REQ-the-graph-computes-from-bus-values)
  Given the graph is not visible
  When its params change
  Then nothing is painted
  When it becomes visible
  Then it paints once, from the current values
# pinned by: tests/ui/eq-graph.test.ts

Scenario: The graph releases everything it took (REQ-the-graph-computes-from-bus-values)
  Given a mounted graph
  When destroy runs
  Then its bus subscriptions, ResizeObserver, drag listeners and pending frame are gone
# pinned by: tests/ui/eq-graph.test.ts

Scenario: The control column is exactly the wheels' width (REQ-the-eq-page-mirrors-the-scope-row)
  Given the bottom section's stylesheet and the EQ page's
  Then both resolve their first grid column from the same --wheel-col
  And the EQ subtracts only its own 1px border from it
# pinned by: tests/ui/eq-panel.test.ts

Scenario: The graph takes its height from the scope (REQ-the-eq-page-mirrors-the-scope-row)
  Given the EQ page's stylesheet
  Then the graph box's height is var(--scope-h), the property the scope owns
# pinned by: tests/ui/eq-panel.test.ts

Scenario: The graph's left edge lands on the scope's (REQ-the-eq-page-mirrors-the-scope-row)
  Given the section is open in a real browser
  When the EQ canvas and the scope canvas are measured
  Then their left edges agree within a pixel, and so do their widths
# pinned by: e2e/equalizer.spec.ts

Scenario: Resizing the scope resizes the EQ graph with it (REQ-the-eq-page-mirrors-the-scope-row)
  Given the section is open
  When --scope-h changes
  Then the EQ graph's height changes by the same amount
# pinned by: e2e/equalizer.spec.ts

Scenario: The scope keeps its own row and its resize handle (REQ-the-eq-is-a-third-bottom-row)
  Given the bottom section's stylesheet
  Then .bottom is a flex column, --scope-h sizes only the scope row, and the keyboard keeps its floor
# pinned by: tests/ui/eq-panel.test.ts

Scenario: Every factory preset bank pins the synth EQ off (REQ-every-preset-bank-pins-eq-off)
  Given every factory preset
  Then each names fx.eq.on with the value 0
# pinned by: tests/state/preset.test.ts

Scenario: The magnitude formula describes the filter its coefficients define (REQ-the-drawn-curve-is-exact)
  Given one stage's coefficients from eqStageCoeffs
  When its impulse response is run through the difference equation and transformed
  Then the closed-form magnitude agrees with it at, above and below the corner
# pinned by: tests/state/eq.test.ts

Scenario: The drawn curve matches a real filter within 0.5 dB (REQ-the-drawn-curve-is-exact)
  Given a lane EQ with a shaped curve
  When the same filters are built in an OfflineAudioContext
  Then getFrequencyResponse agrees with data-eq-curve at every band centre
# pinned by: e2e/equalizer.spec.ts

Scenario: The section folds, switches lane and reaches the bus (REQ-the-eq-section-is-a-folded-tab-container, REQ-the-curve-is-drawn-by-dragging)
  Given the app at rest
  When the EQUALIZER bar is clicked and the DRUM MACHINE tab is chosen
  Then that lane's page is on screen
  When its ON switch is pressed and the graph is dragged
  Then fx.drum.eq.on is 1 and a band gain has moved
# pinned by: e2e/equalizer.spec.ts
```

## Tests & verification

- Unit: `tests/state/eq.test.ts`, `tests/state/eq-presets.test.ts`,
  `tests/audio/effects/eq.test.ts`, `tests/ui/eq-panel.test.ts`,
  `tests/ui/eq-graph.test.ts` — `npm test`. E2E: `e2e/equalizer.spec.ts` (the only
  check against a real `BiquadFilterNode`).
- Drift pins that move with it: `tests/state/authoring-docs.test.ts`,
  `tests/state/param-wiring.test.ts`, `tests/ui/typography.test.ts`,
  `tests/audio/no-unanchored-cancel.test.ts`; `npm run gen:params` then
  `check:params`.
- **By ear** (ADR-010, [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)),
  on **both** engines, since HP/LP ride `detune` automation. Listen for zipper on
  a fast draw, a clean step (not a click) on engaging a boosted curve, and the
  drum highpass stopping the kick pumping the kit.

## Open questions / future

- **No master EQ.** It would be one more `eqParams` call plus an Engine splice. The
  master already carries the DJ filter and the VCA compressor.
- **No live spectrum behind the curve.** It would cost three analysers, three
  `StudioApi` members and a gated loop, so it was declined to keep "no loop".
- **No weak-tier reduction**: dropping bands would change the sound, not trim a
  cost (ADR-018's reasoning).
