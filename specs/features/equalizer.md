# Equalizer (per-lane drawable EQ — sequencer · drums · sampler)

```yaml
id: equalizer
status: implemented
version: 2   # v2: REQ-18 — the page mirrors the scope row (one shared
             #     gutter, height from --scope-h). It shipped with the graph
             #     at ~300px and the knobs beside it, aligning with nothing
owner: core
related:
  - architecture
  - effects              # the chain this joins, at the head of all three
  - scope                # the log frequency axis + zone names it reuses
  - machine-status       # the tab LED (setIndicator / MachineState)
  - testids
  - runtime-performance  # REQ-4/REQ-6/REQ-7 — the repaint contract
  - presets              # REQ-2b — a factory bank pins every synth-FX `.on`
  - param-catalogue      # registration order is a published artefact
  - drum-kits            # the "named table of bus writes" precedent
  - dropdown
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
  - src/ui/components/canvas-text.ts   # haloText, hoisted out of Scope
  - src/ui/components/scope.ts         # now calls the hoisted haloText
  - src/ui/components/tabs.ts          # TabOptions.title + .pageClass
  - src/ui/app.ts                      # buildBottom mounts it
  - src/ui/styles/eq.module.css
  - src/ui/styles/tabs.module.css      # .title (the row heading)
  - src/ui/styles/layout.module.css    # the third .bottom row + --wheel-col
```

A bypass-able **equalizer on each of the three lane buses**, drawn as a curve
rather than dialled as knobs, in its own collapsible section. The generic insert
machinery it rides on — `Effect`, `BypassWrapper`, true bypass, `bindBypassMix` —
is [effects](effects.md); this spec covers only what an EQ adds.

## Background / Why

The instrument had no EQ at all. The one filter a player could reach across a
whole bus was `fx.djfilter` ([performance](performance.md)), a master-bus
performance sweep — so there was no way to take the mud out of a drum bus, tame
hiss on a recorded sample, or darken one lane without darkening the mix. Per-track
tone controls exist (`drum.t<i>.tone`, `sampler.s<i>.tone`) but they are single
lowpasses on one voice, not a bus tool.

The gap became pointed when [scope](scope.md) v13 gave the Spectrum a log
20 Hz–20 kHz axis and a **Zones** overlay naming the four bands people mix
against — MUD, BOXY, NASAL, HARSH. The app could now *show* a problem it gave
you no way to fix. This closes that loop: the EQ's band centres sit inside those
same four zones, on the same axis, so "see it, fix it" is one gesture.

Three constraints shaped every choice below, in the order
[ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md) ranks them.
*Musical*: shelves at the ends, real filters for LP/HP, and a position in the
chain (head) where the EQ shapes what the drive and the drum compressor react to.
*Stable*: native `BiquadFilterNode`s, **no worklet and no audio-thread JS**, and
no `cancelScheduledValues` anywhere — so the unanchored-cancel trap
([architecture](../architecture.md)) cannot apply here by construction.
*Cheap*: ten biquads per lane, free while bypassed, and a UI that computes its
curve from bus values so it needs no analyser and runs no animation loop.

## Requirements

- **REQ-1** — **One `Equalizer` per lane, first in its insert chain.** It is an
  ordinary `Effect` chain member ([effects](effects.md) REQ-3), so
  `src/audio/engine.ts` is untouched — `fx-chain.ts` owns membership, order and
  prefix, and `bind` self-wires under
  [ADR-008](../decisions/adr-008-components-self-wire-params.md):

  ```
  voiceBus ─→ EQ ─→ dist → wah → phaser → delay → reverb → duck → synthPan ─┐
   drumBus ─→ EQ ─→ comp → drumPhaser → drumDelay → drumReverb ─────────────┤
    smpBus ─→ EQ ─→ dist → phaser → delay → reverb → duck ──────────────────┤
                                                                            ▼
                                                                       preMaster
  ```

  **Head, not tail**, for three reasons that all point the same way. It is where
  an EQ is *musical* on this instrument: before the distortion, so it shapes what
  the drive bites on rather than filtering the result; and before the drum bus's
  1176-style compressor, so a highpass stops the kick pumping the whole kit —
  the reason [effects](effects.md) REQ-4 puts that compressor first in the first
  place. It is where an EQ is *cheap*: the synth path is 1-channel until the
  reverb ([architecture](../architecture.md)), so a head-position EQ runs ten
  1-channel biquads instead of ten 2-channel ones. And it leaves `FxChain.tail`
  and the bank-render tap alone, so
  [render-to-sampler](render-to-sampler.md) needs no thought.

- **REQ-2** — **Eight fixed bands: a low shelf, six peaks, a high shelf**, with
  centres chosen so **every named Spectrum zone contains one**. That alignment is
  the feature's whole musical claim, and it is what makes the De-Mud / De-Box /
  De-Nasal / De-Harsh presets (REQ-15) mean something rather than being four
  arbitrary dips.

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

  Fixed centres rather than a movable parametric band, deliberately: *drawing a
  line* is the gesture this feature is for (REQ-12), and a drawn line maps onto a
  fixed grid unambiguously while fitting it to movable bands is a curve-fit with
  no single answer. Surgical work is served instead by WIDTH (REQ-4), which
  narrows a band to a notch in place. The table lives once, in `state/eq.ts`, and
  is read by **both** the audio filters and the drawn curve, so the two cannot
  disagree about where a band is.

- **REQ-3** — **A real highpass and lowpass, swept in cents on `detune`.** Two
  extra biquads at `Q.value = 0.7` — the same shape and slope as the DJ filter's
  `djLow`/`djHigh` — bracket the eight bands, so LOW PASS / HIGH PASS /
  BAND PASS are filters rather than ±18 dB tilts.

  That `0.7` is **in decibels**, not a linear Q: the Web Audio spec reads `Q`
  that way for `lowpass` and `highpass` (and linearly for `peaking`, and not at
  all for the shelves, which fix their slope at `S = 1`). It is the single
  easiest thing to get wrong here, and getting it wrong would make the drawn
  curve disagree with the audio while looking entirely plausible — which is why
  `eqStageCoeffs` spells the three cases out separately rather than sharing one
  `alpha`. `frequency.value` is written
  **once**, to `EQ_HP_REF` (20 Hz) and `EQ_LP_REF` (20 kHz), and never again; the
  knob drives `detune = 1200 * log2(target / ref)`. This is the rule
  [effects](effects.md) REQ-11 and [performance](performance.md) REQ-10 already
  impose on every swept filter in the app, and the reason is the same: a linear
  Hz write can reach the `AudioParam` floor where a biquad degenerates, and cents
  cannot.

  Every other write here is a `setTargetAtTime` at `RAMP_SMOOTH`, and **nothing
  in this effect ever calls `cancelScheduledValues`** — so the Gecko
  unanchored-cancel defect ([architecture](../architecture.md)) is not avoided by
  care but excluded by construction.

- **REQ-4** — **WIDTH is one knob over all eight bands' `Q`.** It is what makes a
  single graphic EQ span broad tone-shaping and surgical repair: at 0.4 the bands
  overlap into a smooth tilt, at 8 one band is a notch. Web Audio's `lowshelf`
  and `highshelf` ignore `Q` by specification, so WIDTH moves the six peaking
  bands only — the shelves keep their fixed slope at every setting. That is a
  property of the node, stated here so it reads as known rather than as a bug.

- **REQ-5** — **Off by default, and a no-op at every default.** `fx.<lane>.eq.on`
  defaults to `0`; every band gain defaults to `0 dB`; HP defaults to its floor
  and LP to its ceiling. So
  [ADR-006](../decisions/adr-006-no-op-param-defaults.md) holds twice over — no
  existing preset, song, share link or demo changes — and the effect costs
  nothing until switched on, because
  [ADR-012](../decisions/adr-012-true-bypass-disconnects.md)'s true bypass
  disconnects the whole ten-filter span. `< 0.5` is bypassed, as
  [effects](effects.md) REQ-5 defines for every insert.

- **REQ-6** — **Params come from one `eqParams(prefix)` factory, instantiated per
  chain**, beside `distParams`/`phaserParams`/`delayParams`/`reverbParams` — so
  the three EQs cannot drift into three different EQs
  ([param-catalogue](param-catalogue.md) REQ-1b). Twelve ids per lane, 36 in all.
  Each call site sits **first** in its chain's block in `registerDefaults()`, so
  the published catalogue's order keeps mirroring signal order.

  The sound-vs-song split needs no code: `preset-session.ts`'s
  `NON_PATCH_PREFIXES` already contains `fx.drum.` and `fx.sampler.`, so `fx.eq.*`
  is part of **the sound** (captured by presets, marks the selector dirty) while
  the drum and sampler EQs are song-level. That falls out of the prefix, and the
  prefix was chosen for it.

- **REQ-7** — **The EQ declares a drain longer than the default.**
  `recipes/add-an-effect.md` warns that a biquad is only memoryless at low Q — its
  ring-down is roughly `Q / (pi * f0)`, which for the 150 Hz band at WIDTH 8 is
  ~17 ms *per filter*, compounded down a ten-filter series and past
  `DRAIN_DEFAULT_S` (20 ms). `drainSeconds()` returns `0.12`, so the two-stage
  bypass teardown ([effects](effects.md) REQ-2c) hands back a span holding
  silence, and re-enabling can never replay the last bar.

- **REQ-8** — **No auto makeup gain: engaging a boosted EQ is a level change, by
  design.** [effects](effects.md) REQ-12 requires that toggling an effect not
  *step* the level, and every other insert honours it. An EQ is the deliberate
  exception, because the level change *is* the effect — an EQ that silently
  re-normalised what you drew would be lying about what it did. The makeup control
  already exists and is the right one: each lane's own volume (`seq.master`,
  `drum.master`, `sampler.master`). Recorded so the exception is a decision rather
  than an oversight, and so the ear check knows to confirm a clean *step* rather
  than the absence of one.

- **REQ-9** — **The section is one `TabContainer`, folded by default.** The header
  reads `EQUALIZER  ●SEQUENCER  ●DRUM MACHINE  ●SAMPLER` — a title plus three
  LED-bearing tabs — and everything but the title already exists on the component
  the pattern row uses: `indicator: true`, `setIndicator`, `collapsibleStoreKey`
  and `collapsedByDefault`. `TabOptions` therefore gains **`title?: string`**
  only, rendered as the **first** child of `.bar` (title first, caret last: a
  `margin-left: auto` caret appended before the title would drag the title to the
  right edge). `.tab` is already `text-transform: uppercase`, so the tab labels
  render as caps; `.title` matches it.

  `collapsedByDefault` is `() => true` unconditionally — this is a tool you reach
  for, not a surface you live in.

- **REQ-10** — **The tab LED indicates; it never toggles.** `tabs.module.css`
  already states the constraint for the machine tabs — `pointer-events: none`, so
  the whole tab highlights as one unit and *every* click navigates — and the EQ
  tabs inherit it unchanged. The real switch is a `Switch` inside the tab body.
  This keeps [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2 intact
  (one gesture, one outcome) and matches the lamp being far too small a touch
  target to be a control (law 6).

  The three `MachineState` values carry over exactly, including the middle one:

  | LED | Meaning |
  | --- | --- |
  | `off` | `fx.<lane>.eq.on < 0.5` — bypassed |
  | `muted` | engaged, but the curve is flat and both filters are open |
  | `on` | engaged and shaping |

  The `muted` state is not decoration: an engaged EQ doing nothing is otherwise
  invisible state, which law 5 forbids.

- **REQ-11** — **Tab ids are `eq-`-namespaced.** `TabContainer` mints `tab-<id>`
  and `panel-<id>`, and `tab-seq` / `panel-seq` / `tab-drums` / `tab-sampler`
  already belong to the pattern row. The EQ's tabs are therefore `eq-seq`,
  `eq-drums`, `eq-sampler` — the same collision [panel-tabs](panel-tabs.md) REQ-3
  avoided by minting a separate `ptab-` namespace, answered here by namespacing
  the ids instead, since these really are `TabContainer` tabs.

- **REQ-12** — **The curve is drawn, and drawing is the primary gesture.** A drag
  across the graph writes band gains: pointer Y maps to dB, and every band crossed
  since the previous move is written, interpolated, so a fast sweep skips none.
  The full inventory is under *Gesture inventory* below.

- **REQ-13** — **The graph computes its curve from bus values, and runs no
  animation loop.** It subscribes its twelve params; a change marks it dirty and
  schedules **one** coalesced `requestAnimationFrame`, so applying a preset (a
  dozen writes) repaints once rather than a dozen times. There is no
  `AnalyserNode`, no per-frame work, and **no addition to `StudioApi`** — the UI
  never reaches for an audio node, so
  [ADR-009](../decisions/adr-009-ui-depends-on-studio-api-facade.md) and REQ-1 of
  [architecture](../architecture.md) are untouched. Repaints are gated on
  visibility per [runtime-performance](runtime-performance.md) REQ-4 — where a
  folded section counts as off screen — and re-sync once on reveal.

- **REQ-14** — **The drawn curve is exact, not an approximation, and is pinned
  against a real filter.** `BiquadFilterNode` is *specified* to use the RBJ
  cookbook coefficients, so `eqResponseDb` computing the same formulas is the
  same filter, not a model of one. Without a pin, the panel could confidently
  draw a curve the audio does not have — so the claim is split into the two
  questions it actually contains, and each is pinned where it can be answered:

  - **Does the closed form describe the filter these coefficients define?**
    `tests/state/eq.test.ts` runs the difference equation from `eqStageCoeffs`,
    takes a DFT of the impulse response, and requires it to agree with
    `eqResponseDb`. Numerically independent of the magnitude expression, so a
    sign slip or a mistaken `alpha` fails it. Runs everywhere.
  - **Does the browser's biquad use those coefficients?** Only a real
    `BiquadFilterNode` can say, and jsdom has none — so `e2e/equalizer.spec.ts`
    builds the same chain in an `OfflineAudioContext`, calls
    `getFrequencyResponse()`, and compares it with the `data-eq-curve` the graph
    mirrors, requiring agreement within 0.5 dB.

  Neither alone is enough: the first would pass a self-consistent filter that is
  not the one Web Audio builds, and the second cannot run in the unit suite.

- **REQ-15** — **Presets are a named table of bus writes, and applying one engages
  the EQ.** No new audio code and no new persistence — the same shape
  [drum-kits](drum-kits.md) uses, and every param it touches is already captured
  by presets and songs. `applyEqPreset` also writes `${prefix}.on = 1`: picking a
  preset is intent to *hear* it, and the switch's LED visibly moves, so the
  outcome is not invisible (law 5). The dropdown falls back to a `Custom` sentinel
  as soon as the curve is edited away from the named shape, so it never names a
  shape that is no longer on screen — the rule the scratch presets already follow.

- **REQ-16** — **The section is a third row of the bottom grid, between the scope
  and the keyboard.** `.bottom` becomes
  `grid-template-rows: var(--scope-h, 130px) auto minmax(160px, 1fr)`. The scope's
  `ResizeHandle` still writes `--scope-h` and still governs **row 1 alone**, so its
  contract is unchanged; an expanded EQ is absorbed by the same keyboard floor that
  [scope](scope.md) REQ-19 already has absorbing a grown scope — *"a growing scope
  eats the keyboard's slack, stops there, and only then does the page scroll."* The
  EQ is a second grower under a rule that was already written, not a new one. Cost
  while folded is the bar plus one grid gap, ~45 px, which is what the FX rack's
  folded bar already costs.

- **REQ-17** — **Every factory preset bank pins `fx.eq.on: 0`.**
  [presets](presets.md) REQ-2b requires each bank to set every synth-FX `.on`
  flag so switching sounds cannot leak the previous patch's FX; the synth EQ is a
  patch param (REQ-6) and joins that list. The drum and sampler EQs are song-level
  and are not affected.

- **REQ-18** (v2) — **The page mirrors the scope row.** The bottom region's
  first row is already `120px | 10px | 1fr` — the PITCH/OCT/MOD wheels beside
  the scope — and the EQ page uses **that same grid**: every control in a column
  exactly as wide as the wheels box, the graph filling the rest, its left edge
  landing on the scope canvas's. Three things make "exactly" true rather than
  approximately true, and each is a place this silently drifts:

  - **One gutter, named once.** `--wheel-col` is declared on `.bottom` and read by
    both `.bottomTop` and the EQ page. It was a bare `120px` literal in one rule, so
    the two were equal only by coincidence.
  - **The column is `calc(var(--wheel-col) - 1px)`.** The wheels box sits directly
    in `.bottom`; the EQ page sits inside a panel whose 1 px border it has to clear.
    Subtracting it is what puts the graph at the same x as the scope. The graph's
    right edge lands 1 px short for the same reason on the other side — the cost
    of the section having a frame at all, recorded rather than hidden.
  - **The tab shell's horizontal padding is removed** for this panel, via
    REQ-9's `pageClass`. `.content` is `padding: 10px 12px` and is shared with the
    pattern row, so it cannot be zeroed globally; the EQ supplies a class and
    keeps the vertical 10 px.

  **Height comes from `--scope-h`** ([scope](scope.md) REQ-19), so the scope's
  resize grip sizes both and the two panels are always the same height. That is
  a second consumer of a property the scope owns — a coupling, and a deliberate
  one: two panels that are supposed to read as one grid must not be resizable
  apart.

  The control stack is sized to the 130 px floor (`SCOPE_H_MIN`): a 32 px
  `ON`/`RESET` row, a 32 px preset dropdown and a 58 px knob row
  (`knob-size + 30`) with 4 px gaps. Three knobs at **size 28** are
  `3 x (28 + 8) + 2 x 2 = 112px` — the column's usable width. The dropdown's own
  `min-width: 120px` is the full column, so the EQ resets it from the consumer
  side; its menu is `position: fixed` and so escapes the shell's `overflow`.

  No inner border on the controls: the section is already a bordered panel, and
  the scope row never has to nest one because it has no outer frame.

## Technical design

### Contract / public interface

```yaml
# src/state/eq.ts — PURE. No DOM, no audio nodes. Imported by BOTH layers, which
# is the point: the filters and the drawing read one table.
EqBand: { hz: number, type: BiquadFilterType }
EQ_BANDS: readonly EqBand[]        # REQ-2, length 8
EQ_BAND_COUNT: number              # EQ_BANDS.length
EQ_GAIN_MAX: 18                    # dB, symmetric
EQ_HP_REF: 20                      # Hz — the highpass's fixed reference (REQ-3)
EQ_LP_REF: 20000                   # Hz — the lowpass's
EQ_FILTER_Q_DB: 0.7                # HP/LP shape, matching djLow/djHigh.
                                   # In DECIBELS: Web Audio reads `Q` that way
                                   # for lowpass/highpass (linearly for peaking).
EQ_WIDTH_DEFAULT: 1
detuneCents(targetHz, refHz): number             # 1200 * log2(target / ref)
eqResponseDb(s, hz, sampleRate): number          # composite magnitude, dB
eqStageCoeffs(type, f0, qOrQdb, gainDb, sampleRate): BiquadCoeffs
  # one stage's six coefficients. Public so the closed-form magnitude can be
  # checked against the difference equation those numbers define (REQ-14).
eqIsFlat(s: EqSettings): boolean   # REQ-10's `muted` state
readEqSettings(bus, prefix): EqSettings

EqSettings:                        # what both the response math and the UI pass
  gains: readonly number[]         # dB per band, length EQ_BAND_COUNT
  width: number
  hp: number                       # Hz
  lp: number                       # Hz

# src/state/eq-presets.ts
EqPreset: { b: readonly number[], hp?: number, lp?: number, width?: number }
EQ_PRESETS: Record<string, EqPreset>
EQ_PRESET_CUSTOM: 'Custom'         # the sentinel; never a table entry
EQ_PRESET_FLAT: 'Flat'
eqPresetNames(): string[]
applyEqPreset(bus, prefix, name): void   # writes the curve AND `.on` = 1 (REQ-15)
matchEqPreset(s: EqSettings): string     # a table name, or EQ_PRESET_CUSTOM

# src/audio/effects/eq.ts
class Equalizer extends WrappedEffect
  constructor(ctx)
  setBand(i, db), setWidth(q), setHighpass(hz), setLowpass(hz)
  bind(bus, prefix)                # bindBypassMix + 11 subscribes
  # no setMix — its absence declares the EQ has no `.mix` param (effects.md REQ-1)
  # protected drainSeconds() -> 0.12                                    (REQ-7)

# src/ui/components/tabs.ts
TabOptions.title?: string          # REQ-9 — rendered first in `.bar`
TabOptions.pageClass?: string      # REQ-18 — extra class on every page shell,
                                   #   so a consumer can override the shell's own
                                   #   padding without changing it for every panel

# src/ui/components/canvas-text.ts
haloText(ctx, text, x, y, fill): void   # hoisted out of Scope, one copy

# src/ui/components/eq-graph.ts
class EqGraph
  constructor({ bus, prefix, lane, sampleRate })
  el: HTMLElement                  # the wrapper; the canvas is inside it
  setVisible(v: boolean): void     # REQ-13's gate
  destroy(): void

# src/ui/panels/eq-panel.ts
buildEqPanel(bus, engine: StudioApi): { el, tabs: TabContainer, destroy(): void }
  # `engine` is read for ONE field, ctx.sampleRate (a digital filter's response
  # depends on it). Already on the facade, so still no new StudioApi member.
```

### Data shapes (registry)

```yaml
# Per prefix in {fx.eq, fx.drum.eq, fx.sampler.eq} — REQ-6
<prefix>.on:     { min: 0, max: 1, default: 0, step: 1, taper: discrete, labels: [off, on] }
<prefix>.hp:     { min: 20, max: 2000, default: 20, taper: exp }        # default = off
<prefix>.b0..b7: { min: -18, max: 18, default: 0 }                      # dB, fmtDbRaw
<prefix>.lp:     { min: 200, max: 20000, default: 20000, taper: exp }   # default = off
<prefix>.width:  { min: 0.4, max: 8, default: 1 }
```

`hp` and `lp` format as `off` at their no-op extreme rather than `20Hz` /
`20000Hz`, so a filter that is doing nothing says so (law 5).

### Layer touchpoints & ordering

```yaml
state/eq.ts               -> read by audio/effects/eq.ts AND ui/components/eq-graph.ts
state/params.ts           -> eqParams(prefix) x3, each FIRST in its chain's block
audio/effects/eq.ts       -> span processedIn -> hp -> b0..b7 -> lp -> processedOut
audio/effects/fx-chain.ts -> 'eq' first in all three order arrays; bind at the prefix
audio/engine.ts           -> UNCHANGED (ADR-008)
ui/app.ts                 -> buildBottom appends the section between `top` and `kbWrap`
ui/components/tabs.ts     -> TabOptions.title + TabOptions.pageClass
```

Ordering that matters: the graph's `bus.subscribe` calls fire immediately with
current values, so a page is correct before it is ever shown — and every page
stays mounted and subscribed, so a song or preset load repaints a hidden tab too
(the rule [panel-tabs](panel-tabs.md) REQ-5 states for the other strip).

### Persistence

```yaml
localStorage:
  websynth.ui.collapsed.eq : the section's fold state   # ui/components/collapse-toggle.ts
not_persisted:
  the selected tab          # session-only view state, never a param
  the selected preset name  # derived from the params by matchEqPreset, never stored
```

The 36 params ride the ordinary `ParamBus.snapshot()` path into presets, songs,
share links and the session autosave — no serialization code is involved.
[ADR-011](../decisions/adr-011-export-precision-and-default-sparse-serialization.md)
declined default-sparse params, so all 36 are written to every file: ~800 bytes
before deflate, well inside `MAX_SONG_JSON_BYTES`.

Which preset a lane is "on" is deliberately **not** stored. It is a pure function
of the params (`matchEqPreset`), so it cannot go stale, and storing it would make
the dropdown and the curve two sources of truth for one thing.

## Gesture inventory (ADR-014)

Required of every new interactive control (`recipes/design-an-interaction.md`).

| Gesture | Target | Outcome |
| --- | --- | --- |
| drag | the graph | Write band gains: pointer Y → dB, interpolating across every band crossed since the last move, so a fast sweep skips none. |
| tap | the graph | A zero-length drag — sets the one band under the pointer. |
| `Shift` + drag | the graph | Fine: quarter the dB travel. Precedent: the scratch graph's `Shift`. |
| double-tap | a band column | That band back to 0 dB. Precedent: knob double-tap ([param-reset-baseline](param-reset-baseline.md)). |
| pointermove, no button | the graph | Hover readout of the frequency and dB under the cursor, like the Spectrum's ([scope](scope.md) REQ-31). Desktop only, so never the sole route to anything. |
| wheel | the graph | **Nothing.** The bottom row scrolls the page; a wheel here would be a law-2 collision. |
| right-click / long-press | the graph | **Nothing.** |
| tap | a tab's LED | **Nothing** — inert by design (REQ-10); the switch is inside the tab. |
| tap | a tab | Show that lane's EQ, expanding the section first if folded. |
| tap | the bar, off a tab | Fold / unfold the section. |
| tap | the ON switch | Engage or bypass that lane's EQ. The only control that does. |
| pick | the preset dropdown | Write the named curve **and** engage the EQ (REQ-15). |
| tap | RESET | That lane's curve back to flat, filters open. Leaves `.on` alone. |

**Precedent followed (law 4).** Hardware first: running a finger across a
31-band graphic EQ's fader bank is the gesture this is a translation of. Its
software form is standard — Ableton EQ Eight's draw mode, and every touch EQ on
a tablet. Nothing here is invented.

**Law 3 (reversible), honestly.** A drawn curve is params on the bus, and
[pattern-undo](pattern-undo.md) covers step grids, not params — so there is **no
undo for a drag**. The mitigations are per-band double-tap and a lane RESET, both
one gesture away. Recorded rather than glossed: if a complaint arrives, this is
the requirement to revisit first.

**Law 6 (touch-first), honestly.** The graph is full width, so its eight band
columns are ~125 px on a desktop — far past the 44 px target. On a 360 px phone
they are ~42 px, just under it. What makes that acceptable is that the graph is a
*sweep* surface, not a tap-a-target surface: the gesture is a drag across many
bands, and column width is not the hit target. The graph keeps a floor height so
the dB axis stays usable at that width.

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

Scenario: The filters sweep on detune and never rewrite frequency (REQ-3)
  Given a bound Equalizer
  When the hp and lp params move
  Then only detune is written after construction
  And frequency still reads EQ_HP_REF and EQ_LP_REF
# pinned by: tests/audio/effects/eq.test.ts

Scenario: A band gain change is ramped, never cancelled (REQ-3)
  Given a bound Equalizer
  When a band gain changes
  Then it is written with setTargetAtTime and cancelScheduledValues is never called
# pinned by: tests/audio/effects/eq.test.ts, tests/audio/no-unanchored-cancel.test.ts

Scenario: WIDTH moves the peaking bands only (REQ-4)
  Given a bound Equalizer
  When width changes
  Then Q is written on the six peaking bands and on neither shelf
# pinned by: tests/audio/effects/eq.test.ts

Scenario: The drain outlasts the slowest band's ring-down (REQ-7)
  Given the widest WIDTH and the lowest peaking band
  Then drainSeconds exceeds Q / (pi * f0) for it
# pinned by: tests/audio/effects/eq.test.ts

Scenario: A boosted curve is a level step on engage, and that is intended (REQ-8)
  Given a curve with a boosted band
  Then the effect declares no makeup gain node between its input and output
# pinned by: tests/audio/effects/eq.test.ts

Scenario: Every named Spectrum zone contains a band (REQ-2)
  Given SPECTRUM_ZONES and EQ_BANDS
  Then each zone has at least one peaking band inside its from..to range
# pinned by: tests/state/eq.test.ts

Scenario: Every default is a no-op (REQ-5)
  Given a ParamBus with registerDefaults applied
  Then every <prefix>.on is 0, every band gain is 0, hp is at its min and lp at its max
  And eqResponseDb reads 0 dB across the whole axis at those values
# pinned by: tests/state/eq.test.ts

Scenario: A boosted band reads its own gain at its own centre (REQ-14)
  Given a single band boosted by 12 dB at the default width
  Then eqResponseDb at that band's centre is 12 dB
  And it falls back toward 0 dB an octave either side
# pinned by: tests/state/eq.test.ts

Scenario: WIDTH narrows the skirt without moving the peak (REQ-4)
  Given one boosted band
  When width rises
  Then the response an octave away shrinks while the response at the centre does not
# pinned by: tests/state/eq.test.ts

Scenario: The EQ registers 12 params on each of three prefixes (REQ-6)
  Given registerDefaults
  Then fx.eq, fx.drum.eq and fx.sampler.eq each carry on/hp/b0..b7/lp/width
# pinned by: tests/state/eq.test.ts

Scenario: The synth EQ is a patch param and the other two are not (REQ-6)
  Given isPatchParam
  Then fx.eq.b0 is a patch param
  And fx.drum.eq.b0 and fx.sampler.eq.b0 are not
# pinned by: tests/state/eq.test.ts

Scenario: An engaged but flat EQ is distinguishable from a shaping one (REQ-10)
  Given the registered defaults
  Then eqIsFlat is true
  When any band, hp or lp moves off its default
  Then eqIsFlat is false
# pinned by: tests/state/eq.test.ts

Scenario: Applying a preset writes the curve and engages the EQ (REQ-15)
  Given a lane whose EQ is off
  When Hiss Removal is applied
  Then its lp and band gains are written and .on becomes 1
# pinned by: tests/state/eq-presets.test.ts

Scenario: Flat reproduces the registered defaults exactly (REQ-15)
  Given a shaped curve
  When Flat is applied
  Then every band gain, hp, lp and width equals its registered default
# pinned by: tests/state/eq-presets.test.ts

Scenario: Every preset writes only registered ids, within range (REQ-15)
  Given every entry in EQ_PRESETS
  Then each names EQ_BAND_COUNT gains inside +/-EQ_GAIN_MAX
  And each hp/lp lies inside its registered range
# pinned by: tests/state/eq-presets.test.ts

Scenario: A curve that matches no preset reports Custom (REQ-15)
  Given a hand-drawn curve matching no table entry
  Then matchEqPreset returns Custom
  And a curve equal to a table entry returns that entry's name
# pinned by: tests/state/eq-presets.test.ts

Scenario: The section is folded on first load and remembers a choice (REQ-9)
  Given no stored websynth.ui.collapsed.eq
  Then the section renders collapsed
  When the user unfolds it and the section is rebuilt
  Then it renders expanded
# pinned by: tests/ui/eq-panel.test.ts, e2e/equalizer.spec.ts

Scenario: The header reads EQUALIZER before the three tabs (REQ-9)
  Given the built section
  Then the bar's first child is the title and the tabs follow it
  And the caret is the bar's last child
# pinned by: tests/ui/eq-panel.test.ts

Scenario: The tab LED tracks the param and reads muted when flat (REQ-10)
  Given a lane whose EQ is off
  Then its tab LED reads off
  When the EQ is switched on with a flat curve
  Then it reads muted
  When a band is boosted
  Then it reads on
# pinned by: tests/ui/eq-panel.test.ts

Scenario: EQ tab ids never shadow the pattern row's (REQ-11)
  Given the built section
  Then its testids are tab-eq-seq / eq-drums / eq-sampler and panel-eq-*
  And no element mints a bare tab-seq, tab-drums or tab-sampler
# pinned by: tests/ui/eq-panel.test.ts

Scenario: Editing away from a preset shows Custom (REQ-15)
  Given Hiss Removal is selected
  When one band is changed
  Then the dropdown reads Custom
# pinned by: tests/ui/eq-panel.test.ts

Scenario: RESET flattens the lane and leaves the switch alone (REQ-15)
  Given an engaged, shaped EQ
  When RESET is pressed
  Then the curve returns to flat and .on is still 1
# pinned by: tests/ui/eq-panel.test.ts

Scenario: Dragging across the graph writes every band it crosses (REQ-12)
  Given the graph for a lane
  When the pointer is dragged from one band to another several columns away in one move
  Then every band between them is written, none skipped
# pinned by: tests/ui/eq-graph.test.ts

Scenario: Double-tapping a band resets it (REQ-12)
  Given a band at -9 dB
  When it is double-tapped
  Then it returns to 0 dB and its neighbours are untouched
# pinned by: tests/ui/eq-graph.test.ts

Scenario: A wheel over the graph changes nothing (REQ-12)
  Given the graph
  When a wheel event arrives
  Then no param is written
# pinned by: tests/ui/eq-graph.test.ts

Scenario: A dozen param writes repaint the graph once (REQ-13)
  Given the graph is visible
  When a preset writes twelve params in one turn
  Then exactly one repaint is scheduled
# pinned by: tests/ui/eq-graph.test.ts

Scenario: A hidden graph does not repaint, and re-syncs on reveal (REQ-13)
  Given the graph is not visible
  When its params change
  Then nothing is painted
  When it becomes visible
  Then it paints once, from the current values
# pinned by: tests/ui/eq-graph.test.ts

Scenario: The graph releases everything it took (REQ-13)
  Given a mounted graph
  When destroy runs
  Then its bus subscriptions, ResizeObserver, drag listeners and pending frame are gone
# pinned by: tests/ui/eq-graph.test.ts

Scenario: The control column is exactly the wheels' width (REQ-18)
  Given the bottom section's stylesheet and the EQ page's
  Then both resolve their first grid column from the same --wheel-col
  And the EQ subtracts only its own 1px border from it
# pinned by: tests/ui/eq-panel.test.ts

Scenario: The graph takes its height from the scope (REQ-18)
  Given the EQ page's stylesheet
  Then the graph box's height is var(--scope-h), the property the scope owns
# pinned by: tests/ui/eq-panel.test.ts

Scenario: The graph's left edge lands on the scope's (REQ-18)
  Given the section is open in a real browser
  When the EQ canvas and the scope canvas are measured
  Then their left edges agree within a pixel, and so do their widths
# pinned by: e2e/equalizer.spec.ts

Scenario: Resizing the scope resizes the EQ graph with it (REQ-18)
  Given the section is open
  When --scope-h changes
  Then the EQ graph's height changes by the same amount
# pinned by: e2e/equalizer.spec.ts

Scenario: The scope keeps its own row and its resize handle (REQ-16)
  Given the bottom section's stylesheet
  Then it declares three rows, --scope-h sizes the first, and the keyboard row keeps its floor
# pinned by: tests/ui/eq-panel.test.ts

Scenario: Every factory preset bank pins the synth EQ off (REQ-17)
  Given every factory preset
  Then each names fx.eq.on with the value 0
# pinned by: tests/state/preset.test.ts

Scenario: The magnitude formula describes the filter its coefficients define (REQ-14)
  Given one stage's coefficients from eqStageCoeffs
  When its impulse response is run through the difference equation and transformed
  Then the closed-form magnitude agrees with it at, above and below the corner
# pinned by: tests/state/eq.test.ts

Scenario: The drawn curve matches a real filter within 0.5 dB (REQ-14)
  Given a lane EQ with a shaped curve
  When the same filters are built in an OfflineAudioContext
  Then getFrequencyResponse agrees with data-eq-curve at every band centre
# pinned by: e2e/equalizer.spec.ts

Scenario: The section folds, switches lane and reaches the bus (REQ-9, REQ-12)
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
  `tests/ui/eq-graph.test.ts` — `npm test`
- Drift pins that move with this: `tests/state/authoring-docs.test.ts` (the
  published catalogue), `tests/state/param-wiring.test.ts` (every registered id is
  referenced), `tests/ui/typography.test.ts` (the new `.title` serif selector must
  join the allowlist), `tests/audio/no-unanchored-cancel.test.ts`
- E2E: `e2e/equalizer.spec.ts` — `npm run e2e`. It carries REQ-14's pin, which is
  the only place the drawn curve can be checked against a real `BiquadFilterNode`.
- Generated: `npm run gen:params`, then `npm run check:params` must regenerate
  `public/params.json` and `public/params.md` byte-identically.
- Typecheck: `npm run typecheck`
- Dev bridge: `window.__synth.bus.get('fx.eq.b3')` (DEV only)
- **By ear, which is what actually signs this off**
  ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md); no green suite
  can): `npm run bench:audio`, always A/B against a bypassed baseline and with the
  lanes not under test muted (`recipes/verify-audio-by-ear.md`). Render **both**
  engines — the HP/LP knobs drive `detune` automation and Blink and Gecko disagree
  audibly there, which the mock param cannot model. Listen for zipper noise on a
  fast draw, confirm engaging a boosted curve is a clean *step* and not a click
  (REQ-8), and confirm the drum highpass ahead of the compressor actually stops
  the kick pumping the kit — that last one is REQ-1's main musical claim.

## Open questions / future

- **No master EQ.** A fourth tab over `preMaster` is the obvious extension and
  would cost one more `eqParams` call plus an Engine splice — but the master bus
  already carries the DJ filter and the VCA compressor, and three lanes was the
  scope asked for.
- **No live spectrum behind the curve.** Overlaying each lane's own spectrum is
  what would make "find the problem frequency" genuinely fast, and the axis is
  already shared so the drawing would line up. It costs three `AnalyserNode`s,
  three `StudioApi` members and a gated animation loop — deliberately declined
  here to keep REQ-13's "no loop at all" property, and worth revisiting as its
  own change.
- **No performance-mode reduction.** Dropping bands on a weak tier would change
  the sound rather than trim a cost, which is the reasoning
  [ADR-018](../decisions/adr-018-audio-graph-memory-is-committed-not-reclaimed.md)
  used to decline shortening the IR bank. Ten native biquads per lane, free while
  bypassed, is already inside any tier's budget.
- **No undo for a drawn curve** — see the law 3 note above. The general gap is
  that `ParamBus` has no undo at all; solving it here alone would be the wrong
  place.
