# Dirt (the drive effect, and its TYPE: DISTORTION · OVERDRIVE · FUZZ)

```yaml
id: dirt-types
status: implemented
version: 1
owner: core
related:
  - effects            # the insert-effect contract (WrappedEffect, bypass, drain, chain order)
  - delay-types        # the precedent: one effect with a TYPE, one append-only table
  - dropdown           # TYPE is a ParamDropdown in the panel header
  - fx-group           # the sampler's DIRT header group hosts the dropdown after the title
  - fx-slot-picker     # why this is *not* a slot entry
  - runtime-performance
  - untrusted-input
source:
  - src/state/dirt.ts                   # DIRT_TYPES: TYPE's one table (keys + labels)
  - src/state/params.ts                 # dirtParams: on/drive/tone/mix + type, at the fx.dist prefixes
  - src/audio/effects/dirt.ts           # Dirt: DISTORTION_VOICING, applyDrive, the lazy trigger
  - src/audio/effects/dirt-switch.ts    # lazy: DirtSwitch — the dip-and-swap, TYPE and DRIVE once it is in
  - src/audio/effects/dirt-voicings.ts  # lazy, with the switch: VOICINGS (overdrive, fuzz), VoicingRouter's biquad pool
  - src/audio/effects/fx-chain.ts       # the `dirt` member of the synth and sampler chains
  - src/audio/drive-curve.ts            # memoizeDriveCurve: one cache per voicing
  - src/main.ts                         # warmDeferred idle-imports the switch
  - src/ui/components/dirt-type-controls.ts # Dirt's face: DIRT_KNOBS and the TYPE dropdown, shared by both surfaces
  - src/ui/components/param-dropdown.ts # typeDropdown: the `${prefix}.type` selector the delay shares
  - src/audio/effects/effect.ts         # BUTTERWORTH_Q_DB: the DC block's Q, shared with the delay and ring mod
  - src/ui/components/fx-group.ts       # dirtFxGroup: the sampler's DIRT header group
  - src/ui/panels/fx-rack.ts            # synth: the Dirt panel's title is the dropdown
  - src/ui/panels/sampler-panel.ts
```

## Background / Why

The chain had one saturator, called "Distortion": a pre-gain into a hard-kneed,
symmetric `tanh` WaveShaper, a lowpass TONE and a make-up gain. That is a
*distortion*: a lot of gain, squashed dynamics, only odd harmonics. Players reach
for two other characters of the same job. An **overdrive** has less gain and a
soft knee that cleans up when played quieter. Its asymmetric curve adds even
harmonics, and its low end stays tight because the bass is driven less than the
mids. A **fuzz** is the most gain of the three: a near-square clip with a
slightly offset duty, a scooped midrange and a gated sputter as a note dies.

Nobody chains two saturators, so these are **one effect with a TYPE**, as with
the delay ([delay-types](delay-types.md)). They are not effects in a slot
([fx-slot-picker](fx-slot-picker.md)), which exists for effects that run at the
same time. Mutual exclusion then comes for free. They share DRIVE, TONE and MIX.
TYPE changes what DRIVE does and which few filters sit around the clipper. Every
song, preset and share link from before TYPE must sound exactly as it did
(ADR-006), and the order is musical, stable, cheap (ADR-010). The cheap part
also covers boot: only DISTORTION ships in the entry chunk.

Once DISTORTION was one of three types, the effect could no longer be called
Distortion. The panel read "Distortion ▾ DISTORTION", which is redundant and
wrong for the other two. The long legend also widened the title enough to push
the ON switch out of the panel and stop the type from truncating. The effect is
**Dirt**, the players' umbrella term for the overdrive, distortion and fuzz
family.

## Requirements

- **REQ-the-effect-is-called-dirt** — The effect is **Dirt** everywhere a person
  or a reader meets it:
  - the synth panel's legend ("Dirt") and the sampler header group ("DIRT");
  - the in-app help, the authoring guide and the docs;
  - the code (`Dirt`, `dirt.ts`, the chains' `dirt` member, `DIRT_TYPES`) and
    the specs.

  "Distortion" survives only as the DISTORTION type's label and key. The one
  deliberate exception is the stored param ids, `fx.dist.*` and
  `fx.sampler.dist.*`. They are in every saved song, preset, share link and
  demo, so renaming them would reset every one of those (ADR-006). They keep
  their old name, and so does everything minted from them: the help topic
  `fx.dist`, and the testids `switch-fx.dist.on`, `dropdown-fx.dist.type` and
  `fxgroup-fx.sampler.dist`.
- **REQ-the-dirt-type-is-one-append-only-table** — `DIRT_TYPES` in
  `src/state/dirt.ts` is the single table behind `${prefix}.type` on `fx.dist`
  and `fx.sampler.dist`. Each row is an engine key and a label. An index is a
  stored value, so the list is **append-only**:

  | Index | Label | Character |
  | --- | --- | --- |
  | 0 | DISTORTION | Dirt as it always was |
  | 1 | OVERDRIVE | soft, asymmetric, touch-sensitive, tight lows |
  | 2 | FUZZ | near-square, scooped mids, sputters on decays |

  `dirtTypeOf(v)` resolves a stored value. A non-finite or out-of-range index
  resolves to `'distortion'` and never throws (ADR-015). The param is discrete,
  defaults to 0, and is clamped by the bus like every discrete param.
- **REQ-distortion-is-the-unchanged-dirt** — At type 0, `Dirt` builds and
  drives **exactly** the graph the old Distortion did: `processedIn → preGain →
  shaper → tone → postGain → processedOut`, with the same constants:
  - pre-gain 1 + 8a;
  - `tanh` with k = 1 + 50a, over 2048 taps;
  - post-gain 1 / (1 + 1.5a).

  There are no extra nodes: the biquad pool (REQ-every-type-is-one-voicing) is
  created the first time a type other than DISTORTION is wired. A song that
  never leaves DISTORTION constructs, connects and imports nothing new.
- **REQ-every-type-is-one-voicing** — `VOICINGS` in `dirt-voicings.ts` is a
  `Record<DirtType, Voicing>`, so the compiler requires one entry per table row.
  Its `distortion` entry is `DISTORTION_VOICING`, which lives in `dirt.ts`
  because the boot path needs it. A `Voicing` holds:
  - its own bucketed curve cache (`memoizeDriveCurve`,
    [effects](effects.md) REQ-drive-curves-are-bucketed-and-memoized);
  - its `preGain(a)` and `postGain(a)` laws;
  - at most one `pre` and two `post` biquad settings, which wire before and after
    the shaper.

  The filters are three biquads in a pool owned by a `VoicingRouter`. A type
  change reconfigures them and connects only the ones its voicing lists, and the
  rest stay disconnected (ADR-012). Adding a type is one table row plus one
  voicing. It never adds a second shaper.
- **REQ-overdrive-voicing** — OVERDRIVE:
  - the synth reaches Dirt quietly: a held note measured about −35 dBFS RMS on
    the bench. So the total gain into the knee is what sets the character. It
    runs exponentially from 5× (nearly clean) to 100× (heavy): G(a) = 5·20^a;
  - curve `tanh(k·x + c) − tanh(c)`, with k = 3 + 3a and c = 0.4. The offset in
    `tanh` space makes it asymmetric, which gives even harmonics, and the curve
    is normalized (REQ-every-dirt-type-is-bounded);
  - pre-gain G(a) / k;
  - post-gain a constant 0.65. The level therefore *rises* with DRIVE, as a real
    overdrive's gain knob does, and meets DISTORTION's around DRIVE 0.9;
  - pre: a lowshelf, −6 dB below 250 Hz;
  - post: a DC block (highpass, 20 Hz, `BUTTERWORTH_Q_DB`) and a lowshelf,
    +3 dB below 250 Hz.

  The shelf pair drives the bass less, then gives most of it back, so the low
  end stays tight without going thin. At DRIVE 0 the curve is nearly linear.
  Over the range, a quieter input stays cleaner than a loud one, which is the
  touch-sensitivity.
- **REQ-fuzz-voicing** — FUZZ:
  - pre-gain 1 + 4a;
  - the curve is applied in two steps:
    - a dead zone of d = 0.015 (`dz(x)`, |x| below d is 0 and the rest is
      rescaled), which gates the tail of a dying note into the sputter;
    - then `C(k·dz(x) + c) − C(c)`. Here `C` is the cubic soft clip
      `1.5u − 0.5u³`, clamped at ±1, which has a harder knee than `tanh`.
      k = 4 + 36a and c = 0.3;
  - post-gain 1.2 / (1 + a). That is within about 3 dB of DISTORTION at the
    same DRIVE, and leaves the bass about 2 dB of headroom below full scale (a
    fitted 1.9 / (1 + 1.6a) clipped an A1 at DRIVE 0.2);
  - post: a DC block and a peaking scoop of −6 dB at 900 Hz (Q 0.7, read
    linearly for a peaking filter);
  - no pre filter, so the low end stays full.

  These constants are what shipped after the first bench pass
  (REQ-every-dirt-type-is-heard). Moving one is a sound change, and gets heard
  again.
- **REQ-every-dirt-type-is-bounded** — No type has feedback. A WaveShaper clamps
  its input to ±1, and every curve is normalized so that max |y| = 1 and
  f(0) = 0 at every bucket. The output of the clipper is therefore bounded by
  construction, and silence in gives silence out. The DC block removes the DC an
  asymmetric curve makes, so a bypass never thumps. The biquads have fixed
  settings and no loop.
- **REQ-a-dirt-type-switch-is-click-free** — Moving TYPE while the effect is
  live ducks the wet path first:
  1. `postGain` glides to 0 with a 5 ms constant (`TYPE_DIP_S`).
  2. After `TYPE_SWAP_MS` (40 ms, eight constants, about −70 dB), the pool is
     rewired, the new voicing's curve and pre-gain are applied at the current
     DRIVE, and `postGain` glides back to the new law with `RAMP_SMOOTH`.

  A switch during a pending swap replaces its target, so a rapid flip settles on
  the last value. While the wrapper has quiesced for a bypass (input cut, nothing
  sounding), the swap is immediate and nothing dips. A DRIVE move during a dip
  updates the pre-gain and curve but leaves `postGain` down until the swap.
- **REQ-the-other-dirt-types-load-on-first-use** — The type switch and the
  other voicings are one lazy chunk for every Dirt: `DirtSwitch`
  (`dirt-switch.ts`), plus OVERDRIVE, FUZZ and the router (`dirt-voicings.ts`).
  It is imported on the first choice of a type other than DISTORTION, and
  idle-warmed at boot like the delay's (`main.ts` `warmDeferred`). The entry
  chunk holds only `Dirt`: DISTORTION, `applyDrive` and the trigger. This
  mirrors the delay, where `DelaySwitch` takes the knobs once it is in
  ([delay-types](delay-types.md) REQ-the-other-types-load-on-first-use). From
  then on, `Dirt` forwards TYPE and DRIVE to the switch.
  - While the import is in flight, Dirt keeps sounding as DISTORTION. The
    switch then starts from the latest TYPE and does an ordinary dip and swap.
  - A failed import is logged, and Dirt stays DISTORTION, untouched.
  - The next TYPE choice **or the next switch-on** retries. A switch-on has to
    retry too, because the bus ignores a write of the value it already holds.

  The import is operation-scoped ([lazy-load-failure](lazy-load-failure.md)
  REQ-lazy-scope-is-surfaces-not-operations), and nothing throws into a
  subscriber.
- **REQ-dirt-type-is-the-panel-title** — In the synth rack, the Dirt panel's
  title *is* the TYPE dropdown: a `ParamDropdown` with a "Dirt" legend over the
  type, as the Delay's is ([delay-types](delay-types.md)
  REQ-type-is-a-header-dropdown-and-char-a-knob). The header fits its panel at
  every width. The value truncates like the Delay's "SPACE E…", and the ON switch
  stays inside the panel. A "Distortion" legend broke both
  (REQ-the-effect-is-called-dirt).

  The sampler's DIRT header group keeps its title and hosts an unlabelled
  dropdown after it (`afterTitle`, collapsing with the knobs while the effect is
  bypassed, [fx-group](fx-group.md) v5). No knob dims, because all three mean
  something in every type.
- **REQ-the-dirt-type-gesture-inventory** — (ADR-014) The dropdown is the only
  new control, and its gestures are `ParamDropdown`'s own
  ([dropdown](dropdown.md)). Click or tap the title or the dropdown to open it,
  then click an entry to choose it. Escape or a click outside closes it with
  nothing chosen. A motion lane or a song load may move TYPE like any discrete
  param.
- **REQ-dirt-type-testids** — The dropdowns are `dropdown-fx.dist.type` and
  `dropdown-fx.sampler.dist.type` ([testids](testids.md)); the ids keep the
  legacy prefix (REQ-the-effect-is-called-dirt).
- **REQ-every-dirt-type-is-heard** — A voicing ships only after it has been
  heard (ADR-010). That means `npm run bench:audio` on Chromium **and** Firefox,
  against a bypassed baseline, at DRIVE 0.2, 0.5 and 0.9 on a lead and a bass
  patch, plus a TYPE switch mid-note.

## Technical design

### Contract / public interface

```yaml
DIRT_TYPES:                 # src/state/dirt.ts — [key, label][], append-only
DIRT_TYPE_LABELS: string[]
dirtTypeOf(v): DirtType     # 'distortion' | 'overdrive' | 'fuzz'; bad input → 'distortion'
Dirt:                       # src/audio/effects/dirt.ts (entry)
  setDrive(a): void         # DISTORTION here; forwarded to the switch once it is in
  setTone(hz): void
  setMix(m): void
  setType(v): void          # imports the switch on the first non-DISTORTION type, then forwards
  bind(bus, prefix): void   # prefix is fx.dist / fx.sampler.dist; + `${prefix}.type`
applyDrive(ctx, nodes, voicing, a, post?): void   # one drive law for both classes
DirtSwitch:                 # src/audio/effects/dirt-switch.ts (lazy)
  setType(v): void          # REQ-a-dirt-type-switch-is-click-free
  setDrive(a): void         # leaves postGain down during a dip
  quiesce(on): void
DIRT_KNOBS: [suffix, label][]                         # src/ui/components/dirt-type-controls.ts — DRIVE · TONE · MIX
dirtTypeDropdown(bus, prefix, legend?): HTMLElement   # = typeDropdown(bus, prefix, DIRT_TYPE_LABELS, legend)
dirtFxGroup(bus, prefix): HTMLElement                 # src/ui/components/fx-group.ts
```

### Data shapes

```yaml
Voicing:
  curve: (a) => Float32Array        # memoized, identity-stable per bucket
  preGain: (a) => number
  postGain: (a) => number
  pre: BiquadSpec[]                 # 0..1
  post: BiquadSpec[]                # 0..2
BiquadSpec:
  type: BiquadFilterType
  hz: number
  q: number                         # dB for lowpass/highpass, linear for peaking, ignored by shelves (equalizer.md)
  db: number                        # shelf/peak gain; 0 otherwise
```

### Layer touchpoints & ordering

- The chain order is unchanged: Dirt is second on the synth and sampler buses,
  behind the EQ. The drum bus has no Dirt (its tracks have their own drive).
- The order of `bind`'s subscriptions does not matter, because a swap re-applies
  the current DRIVE under the new voicing.

### Persistence

`fx.dist.type` and `fx.sampler.dist.type` are ordinary patch params. They are
saved in songs, presets and share links, and are absent from older files, which
then load at 0 (DISTORTION).

## Scenarios (BDD)

```gherkin
Scenario: An old song's Dirt is the distortion it always was (REQ-distortion-is-the-unchanged-dirt)
  Given a Dirt that has only ever been DISTORTION
  When it is built and driven
  Then it connects preGain → shaper → tone exactly as before, with no biquad pool
   And its curve and gain laws are the original ones
# pinned by: tests/audio/effects/dirt-types.test.ts

Scenario: Each type wires exactly its voicing (REQ-every-type-is-one-voicing)
  Given a live Dirt
  When TYPE becomes OVERDRIVE, then FUZZ, then DISTORTION
  Then after each swap the path between preGain and tone is exactly that voicing's pre · shaper · post
   And DISTORTION again is preGain → shaper → tone
# pinned by: tests/audio/effects/dirt-types.test.ts

Scenario: A bad stored type is DISTORTION (REQ-the-dirt-type-is-one-append-only-table)
  When dirtTypeOf is given NaN, -1, 99 or Infinity
  Then it returns 'distortion'
# pinned by: tests/audio/effects/dirt-types.test.ts

Scenario: Every curve is bounded (REQ-every-dirt-type-is-bounded)
  Given every voicing at every drive bucket
  Then max |curve| is 1, and the two centre taps (2048 taps straddle 0) average to 0
# pinned by: tests/audio/effects/dirt-types.test.ts

Scenario: A live switch dips and returns (REQ-a-dirt-type-switch-is-click-free)
  Given a live Dirt
  When TYPE is set to OVERDRIVE and the switch is in
  Then postGain glides toward 0, and the pool is not yet wired
   And once TYPE_SWAP_MS has passed, the overdrive is wired and postGain glides back to its law
# pinned by: tests/audio/effects/dirt-types.test.ts

Scenario: A rapid flip settles on the last value (edge)
  Given a live Dirt
  When TYPE is set to OVERDRIVE and then FUZZ within TYPE_SWAP_MS
  Then one swap happens, to FUZZ
# pinned by: tests/audio/effects/dirt-types.test.ts

Scenario: A quiesced switch does not dip (edge)
  Given a Dirt bypassed long enough for its wrapper to quiesce
  When TYPE is set to FUZZ
  Then the fuzz is wired as soon as its voicing is in, and postGain never glides to 0
# pinned by: tests/audio/effects/dirt-types.test.ts

Scenario: A failed load stays put and retries on switch-on (REQ-the-other-dirt-types-load-on-first-use)
  Given the switch's import fails
  When TYPE is set to OVERDRIVE on a live Dirt
  Then a warning is logged, the graph is still preGain → shaper → tone, and postGain keeps DISTORTION's law
   And once the import works, switching the effect off and on wires the overdrive
# pinned by: tests/audio/effects/dirt-types.test.ts

Scenario: The TYPE dropdown on both surfaces (REQ-dirt-type-is-the-panel-title, REQ-dirt-type-testids)
  Given the synth rack and the sampler DIRT group
  Then each has its dropdown showing DISTORTION, the synth's being the panel title with a "Dirt" legend
   And choosing FUZZ sets <prefix>.type to 2
# pinned by: tests/ui/dirt-type-ui.test.ts, e2e/dirt-type-header.spec.ts

Scenario: The Dirt header fits its panel at every width (regression, REQ-dirt-type-is-the-panel-title)
  Given Dirt is on and its type is DISTORTION, the longest label
  When the viewport is any of 360 · 393 · 480 · 600 · 660 · 768 · 900 · 1024 · 1200 · 1440 px wide
  Then the ON switch is inside the panel and the title ends before the switch
# pinned by: e2e/dirt-type-header.spec.ts (fails at 360 px with a "Distortion" legend)
```

## Tests & verification

- E2E: `e2e/dirt-type-header.spec.ts`. The Dirt header fits its panel across
  the width sweep, and the sampler DIRT dropdown sets the type.
- Unit: `tests/audio/effects/dirt-types.test.ts` (mock AudioContext, fake timers,
  a mocked failing import of the switch); `tests/ui/dirt-type-ui.test.ts` (jsdom). The
  `tests/ui/lazy-load-failure.test.ts` list includes `dirt.ts` among the
  operation-scoped imports. `bypass`, `effect-bind` and `fx-cost` must stay
  green. Run `npm test`.
- Typecheck: `npm run typecheck`. Bundle: `npm run build && npm run check:bundle`.
- By ear: REQ-every-dirt-type-is-heard, following `specs/recipes/verify-audio-by-ear.md`.

## Open questions / future

- The swap's dip is a ~40 ms gap in the wet at each TYPE change, measured on
  both engines. It is click-free, but a motion lane that changes TYPE every step
  makes it a rhythm of its own. If it is heard as a stutter, shorten it
  (`TYPE_SWAP_MS` 20 ms is still about −58 dB).
- More rows (a bit-crusher, a rectifier) are one table row plus one voicing each.
- Whether FUZZ's dead zone stays depends on the listening test.
