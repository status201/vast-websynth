# Mod matrix

```yaml
id: mod-matrix
status: implemented
version: 3   # v3: the modulation BAND's direction is coloured — green up,
             #     yellow down; a knob's own arc never is (REQ-13)
             # v2: a mod-wheel route also draws its live position (REQ-12)
owner: core
related:
  - architecture
  - lfo
  - envelopes
  - filter-models
  - voicing
  - runtime-performance
  - floating-window
source:
  - src/audio/mod-matrix.ts        # route table, fan-out, source/dest wiring
  - src/audio/engine.ts            # builds the matrix in the voice loop; subscribes mod.*
  - src/audio/voice.ts             # exposes the per-voice sources
  - src/state/params.ts            # mod.* params + the two append-only label arrays
  - src/ui/components/mod-matrix-window.ts
  - src/state/mod-routing.ts       # the vocabulary + the per-voice rule + depth table
  - src/state/mod-depth.ts         # REQ-11 reach + REQ-12 position maths, pure
  - src/ui/components/knob.ts      # the range band, the live tick, its direction colour
  - src/ui/components/fx-group.ts  # rowDivider, shared with the Song row
```

Many sources into many destinations, with a depth per route — summed in the audio graph, so a
route costs one `GainNode` and no main-thread work at all.

## Background / Why

Before this, modulation routing was two dropdowns: each LFO held **exactly one** destination, and
[lfo](lfo.md) REQ-12 forbade the two from sharing one. That rule exists only because there is one
destination slot per LFO — it is a symptom of the shape, not a musical decision — and lfo.md's own
open questions named the fix: *"A modulation matrix — many sources, many destinations,
per-destination depth — is the real next step, and it would supersede REQ-12 rather than
extend it."*

The implementation is far smaller than the feature sounds, because **the audio graph is already a
statically wired matrix**. `LFO` never calls `connect()` or `disconnect()` at runtime: all five of
its taps stay wired to every destination for the whole session, and `setDest` merely cross-fades
five `GainNode`s so exactly one is non-zero. Routing here has always been a *scalar*. This feature
raises the gain count and lets the player address them.

[ADR-017](../decisions/adr-017-modulation-in-graph.md) records the boundary that keeps this from
becoming a third way to move a parameter: **modulation is a graph concern, automation is a bus
concern.**

## Requirements

- **REQ-1 (one gain per route, rewired only while silent)** — a route is **one `GainNode` per
  voice** whose gain is the route's depth. Changing a route's source or destination **ramps that
  gain to zero first, rewires while it is silent, then ramps back**. Nothing is ever connected or
  disconnected while audible, so a re-patch cannot click.

  This is a deliberate step away from `LFO.setDest`, which never rewires at all — it keeps every
  tap permanently connected and cross-fades five gains. That works for a fixed source and five
  destinations (10 nodes). Generalising it to a *selectable* source would mean a node per
  (row × source × destination × voice) — over 300 `GainNode`s, every one summed per block whether
  it is in use or not, which is the opposite of cheap. One gain per route costs **54 nodes total**
  (6 rows × 8 voices, plus one bus-wide gain per row) and moves the only graph edit onto a user
  gesture, where a 20 ms mute is inaudible and arguably wanted — a re-patch *should* sound like
  one. Nothing rewires per frame, per tick, or per note.

- **REQ-2 (eight rows: two grandfathered, six new)** — rows 0–1 are LFO 1 and LFO 2, and they keep
  their **existing params**: destination `lfo.dest` / `lfo2.dest`, depth `lfo.amount` /
  `lfo2.amount`. Rows 2–7 are six new routes, `mod.<n>.src` / `.dst` / `.amt` for `n = 0..5`.
  Grandfathering rather than migrating is the whole back-compat story: every saved preset, song
  and share link keeps its meaning **with no migration code**, because the params it names are
  untouched.

- **REQ-3 (inert by default, and free to persist)** — every new param defaults to `0`
  (`src` = `off`, `dst` = `none`, `amt` = 0), so a preset that predates the matrix loads silently
  ([ADR-006](../decisions/adr-006-no-op-param-defaults.md)). Because they are plain numeric
  params they ride into presets *and* songs through the existing `params` bag — **no
  `SONG_VERSION` bump, and `serialize.ts`, the JSON schemas and `llms.txt` are untouched.**

- **REQ-4 (the label arrays are append-only)** — `MOD_SOURCE_LABELS` and `MOD_DEST_LABELS` are
  append-only, for the same reason as `SCALE_LABELS` and `LFO_DEST_LABELS`: the stored value is
  the **index**, so inserting or reordering silently re-targets every saved route.

- **REQ-5 (destinations are summing `AudioParam`s, and `pulse` is not one)** — the destination
  list is curated, not the whole param registry, because a destination must be something
  modulation can *sum into*. `pulse` is deliberately absent: it has no node at all — it is a
  240 Hz main-thread `setPeriodicWave` write — so it cannot sum and stays **arbitrated** on rows
  0–1 via `lfo.dest` ([lfo](lfo.md) REQ-14). Anything else a player wants to move belongs to the
  [motion sequencer](motion-sequencer.md) or the [XY Pad](xy-pad.md); ADR-017 is where that
  division is argued, and the UI says so rather than looking like a missing feature.

- **REQ-6 (`resonance` becomes reachable)** — `filter.resonance` is an **a-rate `AudioParam` on
  the filter worklet that nothing can currently address**. It joins the destination list, which
  makes it the first thing the matrix buys that was previously impossible rather than merely
  awkward.

- **REQ-7 (per-voice sources may not drive bus-wide destinations)** — sources are **global**
  (LFO 1/2, mod wheel, random) or **per-voice** (filter env, amp env, velocity, key). A per-voice
  source into a bus-wide destination is not well defined: eight voices' envelopes summing into one
  `StereoPannerNode` is mush, not modulation. Such a destination is therefore **greyed in the
  list with the reason shown, never removed** — the `Dropdown.setDisabledOptions` idiom lfo.md
  REQ-12 already used. `pan` is the only bus-wide destination today.

- **REQ-8 (depth is in the destination's own unit)** — a route's amount is scaled by the
  destination, not by the source: semitones for cutoff, cents for pitch, and the same fixed
  depth scalars the LFO taps already use ([lfo](lfo.md) REQ-13 — pitch ±2400 ¢, cutoff ±48 st,
  shape ±1, amp ±0.5, pan ±1 — plus the two the matrix adds, resonance ±4.2 and drive ±4). Summation stays bounded because the summands are, and because the
  `AudioParam`s clamp. [ADR-005](../decisions/adr-005-cutoff-as-midi-note.md)'s rule — cutoff
  modulators emit **semitones**, never Hz — is now enforced in one table rather than restated per
  contributor.

- **REQ-9 (bipolar depth)** — amount is `-1..1`, so a route can be inverted without needing an
  inverted copy of the source. `0` is the no-op (REQ-3).

- **REQ-10 (the matrix supersedes REQ-12's exclusion)** — two rows may hold the same destination;
  they sum, which lfo.md REQ-13 already specified and the audio graph already did. `blockedDests`
  is deleted; `lfo-routing.ts` keeps the prefix vocabulary the two-page LFO panel still
  needs. **This can change no existing sound**: the
  validators already accepted both `dest` params independently, so a file with both LFOs on one
  destination already loaded and already summed — only the *UI block* disappears.

- **REQ-10b (a source nothing selects costs nothing)** — the `random` sample-&-hold is
  driven from the main thread: the clock schedules one new value on its
  `ConstantSourceNode` per 16th, at the tick's own time so it lands with the beat. That
  write is **gated on whether any live row actually reads `random`** — with no such row
  the node feeds nothing, and scheduling automation on it forever is pure cost for
  silence. Liveness is the same predicate that decides a route's gain (`src` set, `dst`
  set, and not a per-voice source into a bus-wide destination, REQ-7), read straight
  from the rows at tick time rather than cached, so re-patching a row needs no
  invalidation. This is [runtime-performance](runtime-performance.md) REQ-1's rule —
  cost is proportional to what the player asked for — applied to a modulation source,
  and it is the same reasoning ADR-012 used to disconnect a bypassed effect.

- **REQ-11 (a modulated knob shows its reach)** — a faceplate knob whose param any
  route points at draws a **range band**: an inner arc spanning `value ± Σ|depth|`,
  the reach of every route aimed there. It is computed from the route params alone —
  **no audio-thread readback and nothing per frame** — so it costs a repaint only when
  a route changes.

  The band shows **reach**. Where modulation currently *is* usually lives on the audio
  thread and is **per-voice** — eight sounding voices have eight different
  filter-envelope values — so drawing it would need a port message per frame *and* an
  answer to "which voice?".

- **REQ-12 (a source the main thread already knows also shows its position, v2)** —
  the reach-only rule above was too coarse, and the case it got wrong is the one that
  matters most. Sources split by **where their current value lives**:

  | | current value | drawn |
  | --- | --- | --- |
  | LFO 1/2, random, envelopes, velocity, key | audio thread, and per-voice for four of them | band only |
  | **mod wheel** | a `ParamBus` param — already here, exactly, for free | band **and** a live tick |

  A route from the mod wheel therefore draws a **position tick** inside its band, at
  `value + wheel × depth`, moving as the wheel moves.

  This was found by using it: with `mod wheel → resonance` patched, the wheel changed
  the sound but **nothing on screen moved** — the knob never moves (no route moves a
  knob; modulation never touches the `ParamBus`) and the band's width is set by AMOUNT,
  not by the wheel. Meanwhile the *cutoff* band did move, because the wheel widens
  LFO 1's depth ([lfo](lfo.md) REQ-11) — so the only thing animating was the one
  destination the player had not routed. A working feature read as a broken one.

  The wheel is the source a player is physically **holding**, so it is exactly where a
  static picture is least acceptable — and it is the one whose live value costs
  nothing. The tick is drawn even at wheel zero, where it sits on the value: "here is
  where the wheel has you" is information, and it shows the travel about to happen.

  The wheel's contribution to **LFO 1's depth** is deliberately not counted in the
  tick — that widens the band, which REQ-11 already draws. Counting it in both would
  draw one gesture twice.

  Three details that are load-bearing rather than cosmetic:
  - Both ends run through the param's **own taper**, not an offset in normalized
    space, so the band is honest on a `power`-tapered knob like `filter.resonance`
    where equal param steps are not equal travel.
  - It rides an **inner radius**. At the value arc's radius the value painted over the
    band's lower half, and a bipolar route — which swings both ways — read as one-sided
    headroom.
  - An LFO row contributes at the **LFO's own** shallower scale (±24 semitones of
    cutoff, not the matrix's ±48 — [lfo](lfo.md) REQ-13), and LFO 1's band widens with
    the **mod wheel**, because the wheel adds into its depth (REQ-11 there). A band
    that ignored either would promise a sweep the instrument does not play.

  Only four destinations have a knob to draw on — cutoff, resonance, shape, drive.
  `pitch`, `amp` and `pan` are owned by no single control (three oscillator detunes,
  the tremolo VCA, the bus panner), so they have no band. Knobs are self-wiring
  ([ADR-008](../decisions/adr-008-components-self-wire-params.md)): each asks whether
  anything can modulate *it* and subscribes only if so, so the ~100 knobs on the
  faceplate overwhelmingly subscribe to nothing.

- **REQ-13 (the band's direction has a colour, v3)** — the modulation band and its
  tick are coloured by which way the routes push: **green is up, yellow is down.**
  Both states are declared rather than leaving one to the default, so the pair reads
  as one scale instead of "coloured" versus "normal".

  **Only the band.** A knob's own value arc is never coloured by sign, even on a
  bipolar control like the filter envelope amount or a matrix AMOUNT — its pointer
  already says where it sits, and the readout already says `-26st`. Colour is spent
  on what position *cannot* say, and the direction an unseen route pushes is exactly
  that: the matrix window is usually shut, so without this the FILTER panel cannot
  tell an inverted route from a shallow one.

  This is narrower than the rule first shipped, which coloured every bipolar knob's
  own arc. That version put a signal on something already obvious and, at a glance,
  made a plain envelope setting look like a modulation state.

  When routes on one destination **disagree in sign** the band stays neutral. "The
  modulation is negative" is then not a true statement about that knob, and a colour
  claiming it would be worse than no colour at all — so `modSignFor` is unanimous
  rather than a sum.

## Technical design

### Contract / public interface

```yaml
src/audio/mod-matrix.ts:
  MOD_ROWS: 6                          # the free rows; LFO 1/2 are rows 0-1 (REQ-2)
  ModMatrix:
    constructor(ctx, sources: ModSources)
    connectVoice(v: Voice): void       # fan-out, the connectLfoToVoice idiom (REQ-1)
    setSource(row, src): void          # cross-fade; never rewires
    setDest(row, dst): void
    setAmount(row, amt): void
    destBlockedFor(src): number[]      # REQ-7 — bus-wide dests under a per-voice source

src/state/params.ts:
  MOD_SOURCE_LABELS: string[]          # APPEND-ONLY; index 0 === 'off'
  MOD_DEST_LABELS: string[]            # APPEND-ONLY; index 0 === 'none'
```

### Data shapes (registry)

```yaml
mod.<n>.src: { discrete, labels: MOD_SOURCE_LABELS, range: 0..N, default: 0 }   # off
mod.<n>.dst: { discrete, labels: MOD_DEST_LABELS,   range: 0..M, default: 0 }   # none
mod.<n>.amt: { range: -1..1, default: 0 }                                        # bipolar, no-op
# n = 0..5 -> 18 params. Rows 0-1 reuse lfo.dest/lfo.amount and add nothing (REQ-2).
```

```yaml
# Destination table — the unit and depth each route is scaled by (REQ-8)
none:      -                                      -
cutoff:    v.filter.cutoffNote    a-rate  per-voice   semitones, x48
resonance: v.filter.resonance     a-rate  per-voice   0..4.2,    x4.2   # REQ-6
pitch:     osc{1,2,sub}.detune    a-rate  per-voice   cents,     x2400
shape:     v.filter.shape         a-rate  per-voice   0..1,      x1
amp:       v.tremolo.gain         a-rate  per-voice   base 1,    x0.5
drive:     v.filter.drive         k-rate  per-voice   0.5..8,    x4
pan:       Engine.synthPan.pan    a-rate  BUS-WIDE    -1..1,     x1     # REQ-7 applies
```

### Gesture inventory — a matrix row (ADR-014)

The window is a table of rows, each `[source ▾] → [dest ▾] [amount] [range]`. Rows 0–1 show
`LFO 1` / `LFO 2` as fixed text rather than a picker, because their source cannot change.

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| pick a source | the row's source; `off` frees the row | motion track param picker |
| pick a destination | cross-fades the route onto it (REQ-1) | LFO `DEST` dropdown |
| drag the amount | bipolar depth, shown in the destination's own unit (`+14 st`, `−25 ¢`) | every `Knob` |
| Shift + drag the amount | fine adjust | app-wide knob convention |
| double-click the amount | back to `0` — i.e. the route off, without losing its source and destination | knob double-tap resets to the loaded value |
| hover a disabled destination | its `title` says why (REQ-7: "pan is bus-wide; the filter envelope is per-voice") | lfo.md REQ-12's holder hint |
| drag the title bar | move the window | [floating-window](floating-window.md) REQ-3 |
| `Escape` | — deliberately nothing: Escape is panic, app-wide | [floating-window](floating-window.md) REQ-4 |
| drag a row onto another | — no reordering. Rows are independent summands, so their order carries no meaning; a drag would imply one | — |
| a delete button per row | — none: `source = off` is the same act with one fewer control, and it is not destructive (the row keeps its settings) | ADR-014 law 3 |
| disabling an unassigned row | — never. The row stays live or its own pickers become unreachable | [motion-sequencer](motion-sequencer.md) REQ-16 |

### Layer touchpoints & ordering

```yaml
construction (engine): ModMatrix is built with the LFOs and the pitch-bend source,
  BEFORE the voice loop, so connectVoice() can run inside it — the same place
  connectLfoToVoice(this.lfo, v) already runs.
engine (subscribeParams):
  mod.<n>.src -> matrix.setSource(n, round(x))
  mod.<n>.dst -> matrix.setDest(n, round(x))
  mod.<n>.amt -> matrix.setAmount(n, x)
per-voice sources: Voice exposes filEnv.out, ampEnv.out, and two ConstantSourceNodes
  (velocity, key) whose offsets are set at noteOn alongside the existing scalars.
ui: src/ui/components/mod-matrix-window.ts, launched from the LFO panel + Live FX row.
```

### Persistence

`mod.*` persist as ordinary params inside a preset's or song's `params` bag — no new file
section, no version bump (REQ-3). **Not** persisted: the live modulation value (it exists only in
the audio graph), and the window's open state.

## Scenarios (BDD)

```gherkin
Scenario: A route with zero depth changes nothing (REQ-3, back-compat)
  Given every mod.* param is at its default
  Then the rendered audio is identical to before the matrix existed
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: The sample-&-hold is silent while nothing reads it (REQ-10b)
  Given no row selects random as its source
  When the transport runs
  Then no value is scheduled on the random source at all
# pinned by: tests/audio/mod-matrix.test.ts (usesSource)

Scenario: Routing random anywhere starts the sample-&-hold (REQ-10b)
  Given a row routes random to a destination with a non-zero depth
  When the transport runs
  Then one new value is scheduled per 16th, at that tick's own time
# pinned by: tests/audio/mod-matrix.test.ts (usesSource)

Scenario: A route the matrix refuses does not wake the source (REQ-10b, edge)
  Given a row routes a per-voice source to a bus-wide destination
  Then the route is held at zero gain (REQ-7)
  And the source counts as unused, because nothing can hear it
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: Two rows on one destination sum (REQ-10)
  Given row 2 and row 3 both target cutoff
  Then both gains feed the same AudioParam and their contributions add
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: Changing a destination rewires only while silent (REQ-1)
  Given a route is running at depth
  When its destination changes
  Then its gain ramps to zero before anything is disconnected
  And the new destination is connected before the gain ramps back
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: Two changes in quick succession settle on the last one (REQ-1, edge)
  Given a route's destination is changed twice inside the mute ramp
  Then only the final destination ends up connected, and the gain returns to depth
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: Resonance is reachable for the first time (REQ-6)
  Given a route targets resonance
  Then it connects to the filter worklet's resonance AudioParam
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: A per-voice source cannot drive pan (REQ-7)
  Given a route's source is the filter envelope
  Then the audio layer wires nothing, and the route is held at zero gain
  And the window offers pan but disabled, with the reason shown
# pinned by: tests/audio/mod-matrix.test.ts, tests/ui/mod-matrix-window.test.ts,
#            e2e/mod-matrix.spec.ts

Scenario: Every launcher toggles one window, never a second (floating-window REQ-2)
  Given the matrix window is open
  When its launcher is used again
  Then the window closes, and re-opening yields exactly one window
# pinned by: e2e/mod-matrix.spec.ts

Scenario: The window says where the params it cannot reach live (ADR-017)
  Given the matrix window is open
  Then it names the Motion lanes and the XY Pad
  # without this the curated destination list reads as a missing feature
# pinned by: tests/ui/mod-matrix-window.test.ts

Scenario: Depth is bipolar (REQ-9)
  Given two routes with equal and opposite amounts on one destination
  Then their contributions cancel
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: The two LFO rows still read their old params (REQ-2, back-compat)
  Given a preset saved before the matrix with lfo.dest = cutoff and lfo.amount = 0.5
  When it loads
  Then row 0 shows cutoff at that depth and sounds exactly as it did
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: Label arrays are append-only (REQ-4, regression)
  Then index 0 of each array is the inert option, and the known prefix never changes
# pinned by: tests/state/mod-params.test.ts

Scenario: A modulated knob grows a range band, and loses it again (REQ-11)
  Given a route points at filter.cutoff
  Then the cutoff knob draws a band over the span the route can reach
  And taking the route to zero depth removes the band rather than hiding it
# pinned by: tests/ui/knob.test.ts

Scenario: A knob nothing can modulate subscribes to nothing (REQ-11)
  Given a param no destination maps to
  Then its knob has no band and no route subscriptions at all
# pinned by: tests/ui/knob.test.ts, tests/state/mod-depth.test.ts

Scenario: The band agrees with what is heard (REQ-11)
  Given an LFO row on cutoff at full depth
  Then the band spans the LFO's own +-24 semitones, not the matrix's +-48
  And raising the mod wheel widens LFO 1's band, because it widens its depth
# pinned by: tests/state/mod-depth.test.ts

Scenario: A mod-wheel route draws a tick that follows the wheel (v2, REQ-12)
  Given a route runs from the mod wheel to resonance
  Then the resonance knob shows a tick inside its band
  And moving the wheel moves the tick
# pinned by: tests/ui/knob.test.ts, tests/state/mod-depth.test.ts

Scenario: The tick shows at wheel zero, sitting on the value (v2, REQ-12, edge)
  Given a mod-wheel route and the wheel down
  Then the tick is drawn, so the travel about to happen is visible
# pinned by: tests/ui/knob.test.ts, tests/state/mod-depth.test.ts

Scenario: An audio-thread source gets a band but no tick (v2, REQ-12)
  Given a route runs from LFO 1 to cutoff
  Then the cutoff knob shows a band and no tick, because its position is not known here
# pinned by: tests/ui/knob.test.ts

Scenario: The wheel widening LFO 1 is drawn once, not twice (v2, REQ-12, regression)
  Given LFO 1 is routed to cutoff and the wheel is raised
  Then the band widens, and no tick appears for it
# pinned by: tests/state/mod-depth.test.ts

Scenario: An inverted route is visible with the window shut (v3, REQ-13)
  Given a route on filter.resonance is negative
  Then the FILTER panel's RESO band and tick read yellow
  And making it positive turns them green
# pinned by: tests/ui/knob.test.ts

Scenario: A knob's own value is never coloured by its sign (v3, REQ-13)
  Given a bipolar control set well below zero
  Then its own arc and pointer are unchanged, because position already says that
# pinned by: tests/ui/knob.test.ts

Scenario: Routes that disagree in sign stay neutral (v3, REQ-13, edge)
  Given one route up and one route down on the same destination
  Then the band is coloured neither way, because neither would be true
# pinned by: tests/ui/knob.test.ts, tests/state/mod-depth.test.ts

Scenario: The matrix does not run on the main thread (REQ-1)
  Given routes are active and the transport is running
  Then no per-frame ParamBus write is made on their behalf
# pinned by: tests/audio/mod-matrix.test.ts
```

## Tests & verification

- Unit: `tests/audio/mod-matrix.test.ts`, `tests/state/mod-params.test.ts`,
  `tests/ui/mod-matrix-window.test.ts` — `npm test`
- E2E: `e2e/mod-matrix.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`; `npm run check:params` (18 new params republish the catalogue)
- **By ear** ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)) — this is modulation, so
  a green suite proves nothing about whether it is musical. `npm run bench:audio`, A/B against
  `amt: 0`, untested lanes muted ([verify-audio-by-ear](../recipes/verify-audio-by-ear.md)). Two
  questions in particular: does `resonance` stay stable as a destination at high depth, and does a
  per-voice envelope → cutoff route sound genuinely **polyphonic** — each voice sweeping on its
  own — rather than mono-triggered?

## Status

Shipped in stages, each independently useful:

1. **Done** — ADR-017, this spec, the params, the routing engine (including `resonance`
   as a destination), and REQ-12's removal. The matrix is fully functional and reachable
   through `mod.*` params, so a preset, share link or MCP-authored song can already use
   it; `blockedDests` now guards the per-voice rule in both layers.
2. **Done** — the floating window, launched from the Song tab's Live FX row beside the
   XY Pad's door, sharing one controller so every launcher toggles the same window.
3. **Done** — the range arcs. A modulated knob draws an inner band over the span
   modulation can take it (REQ-11).

## Open questions / future

- **An envelope follower off the drum bus** — the one distinctive source that is *not* free: it
  needs an `AnalyserNode` read or a worklet, so it carries main-thread cost that has to be argued
  on its own terms rather than smuggled in here. Would give sidechain-flavoured movement with no
  compressor.
- **Live modulation position on the knobs.** REQ-8's range arc is computed from params alone and
  is free; showing where modulation *currently* is would need a port message per frame, and is
  per-voice, so "which voice?" needs an answer first.
- **XY Pad and motion lanes as matrix sources.** Blocked on the automation-side defect ADR-017
  records: those two, plus Tape Stop, keep three uncoordinated restore caches over one `ParamBus`
  slot. Fixing that is a prerequisite, and it is an automation change, not a matrix one.
- Row count is fixed at six free rows. A pool would need the params to become non-scalar state,
  which is the one thing that would cost a `SONG_VERSION` bump.
