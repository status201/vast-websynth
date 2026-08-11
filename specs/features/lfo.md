# LFO & mod wheel

```yaml
id: lfo
status: implemented
version: 8                  # v8: REQ-12's mutual exclusion is SUPERSEDED by the mod
                            #     matrix; the two LFOs become its rows 0-1, keeping
                            #     lfo.dest / lfo.amount unchanged (mod-matrix.md)
                            # v7: REQ-10..15 — a second LFO (lfo2.*), mutually
                            #     exclusive destinations, arbitrated PWM, tab pages
                            # v6: REQ-9 — lfo.sync locks the rate to the tempo
                            # v5: lfo.rate is exponentially tapered (REQ-8)
                            # v4: `shape` destination — v3: `pulse` implemented
owner: core
related:
  - architecture
  - ladder-filter
  - filter-models        # owns the `shape` destination's target param
  - envelopes
  - effects              # the pan node sits at the end of the synth insert chain
  - render-to-sampler    # the bank-render tap moved downstream of the panner
  - oscillators          # owns pulse width; the `pulse` destination drives it
  - panel-tabs           # v7: hosts the LFO 1 / LFO 2 pages
  - dropdown             # v8: greying now serves mod-matrix REQ-7, not REQ-12
  - mod-matrix           # v8: the LFOs are its rows 0-1; supersedes REQ-12
source:
  - src/audio/lfo.ts
  - src/audio/pwm.ts       # the `pulse` destination's control loop (v3)
  - src/state/params.ts
  - src/audio/engine.ts    # panner construction + LFO fan-out
  - src/state/lfo-routing.ts   # v8: the two-LFO vocabulary; the REQ-12 rule is gone
  - src/ui/panels/lfo-panel.ts # v7: the two-page panel
```

**Two** global low-frequency oscillators, each with a selectable destination, plus
a mod wheel that adds into the first one's depth.

## Background / Why

An LFO provides cyclic modulation (vibrato, tremolo, filter wobble). Each is a
single engine-level node (not per-voice), routed to one destination at a time. The
**mod wheel** sums into LFO 1's amount so a performance gesture can bring modulation
in on top of the patched base amount — clamped to `[0, 1]` so it never overshoots.

Until v7 there was exactly one LFO, which made a patch choose between a filter
sweep *and* a vibrato. v7 adds an identical second LFO (`lfo2.*`), off by default.
The two are kept on **different destinations** so the pair reads as two independent
movements rather than one doubled one — and because `pulse`, alone among the
destinations, genuinely cannot be shared (REQ-14).

## Requirements

- **REQ-1** — Each LFO has rate / amount / waveform / destination.
- **REQ-2** — LFO 1's effective amount = `min(1, lfo.amount + master.modWheel)`;
  **both** `lfo.amount` and `master.modWheel` recompute it. LFO 2's effective
  amount is `lfo2.amount` alone — see REQ-11.
- **REQ-3** — Destination is one of the `LFO_DEST_LABELS` (range `0..6`, v4).
  Labels are **append-only**: an index is a stored value in every preset, song
  and share link, so reordering silently rewrites saved patches.
- **REQ-4** — (v2) The `pan` destination sweeps a single `StereoPannerNode` on
  the **synth bus**, placed after the insert chain and before `preMaster`. At
  full amount the sweep is hard L↔R; `StereoPannerNode.pan` clamps to `±1` by
  construction, so the destination is bounded for any amount. Because the LFO is
  global (one oscillator shared by all voices), a bus panner and a per-voice
  panner are audibly identical here — the bus node is chosen so the insert chain
  stays 1-channel (ADR-010, *cheap*; same reasoning as [ladder-filter](ladder-filter.md)
  REQ-9).
- **REQ-5** — (v2) The **amplitude-domain** destinations (`amp`, `pan`) — and, from
  v4, the coefficient-domain `shape` (REQ-7) — are fed through a shared
  one-pole-ish lowpass (`lowpass`, 200 Hz, `Q = 0.5` — critically damped, no
  overshoot), so a `square`/`saw` waveform's instantaneous jump becomes a ~2 ms
  slew instead of a click. The **frequency-domain** destinations (`pitch`,
  `cutoff`) are fed from the oscillator directly: a stepped octave or filter jump
  is a musical event, not a click. At LFO rates the smoothing is inaudible on
  shape (−0.02 dB, ~6° at 20 Hz). Each LFO owns its own smoothing filter.
  - (v8) `modTap`, the unit-amplitude output the [mod matrix](mod-matrix.md) reads,
    is a **fourth consumer of the smoothed path**. It has to be: a matrix route can
    land on any destination, including the amplitude-domain ones, and the tap cannot
    know which in advance. The same "inaudible at LFO rates" measurement is what
    makes that safe for the frequency-domain destinations it may also feed.
- **REQ-6** — (v3) The `pulse` destination sweeps oscillator **pulse width**. It
  is the one destination with **no audio-node output**: a native
  `OscillatorNode` has no width `AudioParam`, so it is driven by `PwmDriver`
  from a JS-side mirror of the LFO shape rather than by a gain node. Its
  contract, rate cap and cost budget live in
  [oscillators](oscillators.md) REQ-6..REQ-10. Because one LFO holds one
  destination, that LFO's JS mirror and its own audio oscillator are never both
  in use, so they cannot drift against each other in any way a listener can hear
  — still true with two LFOs, since each owns its own oscillator and only the
  driver's owner runs a mirror (REQ-14).
- **REQ-7** — (v4) The `shape` destination sweeps the POLY filter's pole-mix
  morph, `filter.shape` ([filter-models.md](filter-models.md) REQ-6/11) — the LFO
  sweeps the filter's *type*, not just its cutoff. Depth is `±0.5` around the
  knob's position. Despite being frequency-domain in effect, it is fed from the
  **smoothed** path like `amp`/`pan`, not the raw path like `cutoff`: it moves
  filter *coefficients*, so a `square` waveform's instantaneous jump is a click,
  not a musical step. It is a no-op under the LADDER model, which ignores
  `filter.shape` (filter-models REQ-7).
- **REQ-8** — (v5) `lfo.rate` is **exponentially tapered**. Rate is perceived in
  octaves, not in Hz: linearly, the musically useful sub-1 Hz region occupied the
  first ~5% of the knob's travel (~9 px of a 200 px drag) while half the dial was
  spent between 10 and 20 Hz. `exp` spreads it evenly — each equal turn is a
  constant *ratio*, so 0.05→0.5→5 Hz are equally spaced, matching how every
  hardware LFO rate pot is wired. `min = 0.05 > 0`, which `exp` requires.
  - **Stored values are untouched.** Presets, songs and share links hold the
    rate in Hz, so every saved patch loads at exactly the rate it always had and
    `preset-validate` sees no change. The registered range stays `0.05..20`.
  - **One thing does change**: motion-sequencer anchors are stored in *taper
    space* (`MotionStep.x/y`, 0..1) and resolved via `fromNorm` at play time
    ([motion-sequencer](motion-sequencer.md)), so a motion lane whose axis is
    assigned to `lfo.rate` replays at a different rate than it was recorded at —
    a mid-travel anchor moves from ~10 Hz to 1 Hz. No factory demo assigns that
    axis. Accepted rather than migrated: the alternative is a song-format
    version that rewrites stored coordinates per axis param, which is a lot of
    machinery for a lane nothing ships.

- **REQ-9** — (v6) **`lfo.sync` locks the rate to the tempo.** A free-running LFO
  drifts against the song: set a 3 Hz wobble at 120 BPM, change to 128, and it no
  longer lines up with anything. `lfo.sync` is a discrete param whose index 0 is
  `free` — **the default, and an exact no-op** — followed by the note divisions
  from `utils/tempo.ts` (`1/1`, `1/1 D`, `1/1 T`, … `1/32 T`). Rules:
  - While synced, the effective rate is `1 / (beats * 60 / bpm)` and is
    recomputed on **every** `transport.bpm` change, so the wobble tracks a tempo
    ramp or an incoming MIDI clock without the user touching anything.
  - `lfo.rate` itself is **not rewritten**. The stored patch value is what the
    knob returns to when sync goes back to `free`, and a synced patch that loads
    on a build without this param still sounds as it always did (ADR-006).
  - The rate knob **dims** while synced — the same treatment `filter.shape` gets
    on the LADDER model (filter-models.md REQ-7) and the BPM knob gets while
    clock-slaved: the control keeps its place and stops pretending to be live.
  - The division list is the **same table** the tempo-sync help badges recommend
    from (tempo-sync-help.md), so the advisory and the real thing cannot
    disagree. That spec's "Open questions" proposed exactly this promotion.
  - `pwm.setRate` follows the same effective rate, since PWM rides the LFO
    (REQ-6). With two LFOs, "the LFO" means the one that owns the driver
    (REQ-14).

- **REQ-10** — (v7) **There are two LFOs**, `lfo.*` and `lfo2.*`, identical in
  every respect except REQ-11. Both param sets are produced by **one
  `lfoParams(prefix)` factory** in `registerDefaults`, so range, default, taper,
  format and label array cannot drift apart — "the same as the first one" is a
  structural guarantee, not a comment. Both reuse `WAVE_LABELS`,
  `LFO_DEST_LABELS` and `LFO_SYNC_LABELS` verbatim (REQ-3's append-only rule
  covers both). `lfo2.dest` defaults to `0` (`off`) **and** `lfo2.amount` to `0`
  — a double no-op, so every preset, song and share link that predates v7 sounds
  identical (ADR-006). Being additive scalar params, they need **no song-format
  version bump** (ADR-007); `SONG_VERSION` stays 7.

- **REQ-11** — (v7) **The mod wheel feeds LFO 1 only.** `master.modWheel` sums
  into `lfo.amount` (REQ-2) and does not reach `lfo2.amount`, which is set by its
  knob alone. This is the one deliberate asymmetry between the two LFOs. The
  wheel is a performance gesture with one classic meaning — bring in the vibrato
  — and a wheel that simultaneously opens a second, unrelated modulation is a
  single gesture with two outcomes (ADR-014 law 2). LFO 2 is the patched,
  set-and-forget modulator; LFO 1 is the played one.

- **REQ-12** — (v7) ~~**Destinations are mutually exclusive, in the UI.**~~
  **Superseded in v8 by [mod-matrix](mod-matrix.md) REQ-10.** The two LFOs may now
  hold the same destination, and it sums — which REQ-13 below already specified and
  the audio graph already did. `blockedDests` is deleted along with the `paramHint`
  that named the holder; `lfo-routing.ts` keeps the prefix vocabulary the two-page
  panel still needs.

  The rule was never musical: it existed because each LFO had exactly **one**
  destination slot, so sharing one meant losing a route. Once depth is per-route
  that cost is gone, and blocking the combination only withheld something the
  engine handled correctly. It also never was a data invariant — `preset-validate`
  and `song-validate` always accepted both `dest` params anywhere in `0..6`
  **independently** (rejecting a duplicate would break ADR-007's lenient additive
  stance), so a hand-authored file could already reach the state the UI forbade.
  **Removing the block therefore cannot change how any saved sound plays**; it only
  stops the UI from disagreeing with the data model.

  What replaces it is a rule with an actual reason behind it:
  [mod-matrix](mod-matrix.md) REQ-7 greys a **bus-wide** destination while a
  **per-voice** source is selected, because that combination is genuinely
  ill-defined. The greying idiom itself — disabled and visible, never removed, with
  the reason readable without hover (ADR-014 law 6) — is inherited unchanged.

- **REQ-13** — (v7) **Duplicated destinations sum, and stay bounded.** Every
  destination except `pulse` is a `GainNode` into a summing `AudioParam`, so a
  hand-authored file with both LFOs on one destination is well-defined rather
  than undefined: pitch `±2400` cents, cutoff `±48` semitones (still additive in
  semitone space — ADR-005 holds), shape `±1.0` around the knob, amp `0.0..2.0`
  around the tremolo VCA's base `1.0` (the trough touches silence exactly and
  never inverts), and pan clamped to `±1` by `StereoPannerNode` (REQ-4's bounding
  argument holds unchanged for two sources).

- **REQ-14** — (v7) **`pulse` is arbitrated, because it is a parameter write and
  not a summed connection.** There is one shared `PwmDriver` (REQ-6), and it
  takes a **source index** and tracks an owner:
  - A source claims the driver when it selects `pulse` and the driver is either
    unowned or owned by a **higher** index. It releases when it leaves `pulse`.
    `setRate` / `setWave` / `setAmount` from a non-owner are ignored.
  - **Lowest index wins**, not last-to-claim. `bus.restore()` iterates a
    snapshot's own key order, which is JSON insertion order and so not
    deterministic across hand-authored files; lowest-index-wins is file-order
    independent and matches "LFO 1 got there first".
  - So with both on `pulse`, LFO 1 sweeps the width and **LFO 2's selection is
    inert** — harmless, since `pulse` has no output node and all five of that
    LFO's gains sit at `0`.
  - The owner check is what makes the shared driver safe at all: without it,
    LFO 2 merely *changing its destination away from* `pulse` would call
    `setDest(non-pulse)` and stop LFO 1's live sweep.

- **REQ-15** — (v7) **The two LFOs share one panel, as two tab pages.** The
  faceplate is an 8-column grid and all eight columns are taken, so LFO 2 is a
  second page in the LFO panel rather than a ninth panel. The
  [panel-tabs](panel-tabs.md) strip **is** the panel's header — `LFO 1` and
  `LFO 2` split the row evenly and there is no separate `LFO` title, so the
  pair costs no more vertical space than any other panel's heading (panel-tabs
  REQ-9/REQ-10). Both pages stay in the DOM with live subscriptions, so the
  hidden one is already correct when revealed. The selected page is
  **session-only view state**: never a param, never persisted (panel-tabs.md
  REQ-2). Because a modulating LFO on the hidden page would otherwise be
  invisible state, its tab carries a **lamp** whenever
  `dest !== off && amount > 0` (ADR-014 law 5) — which is where the unselected
  tab's dark well earns its keep, since that is the tab the lamp has to be
  legible on.

## Technical design

### Data shapes (registry)

Both LFOs register the same five params, emitted by one `lfoParams(prefix)`
factory for `prefix` in `lfo`, `lfo2` (REQ-10):

```yaml
<prefix>.rate:   { range: 0.05..20, default: 4, format: Hz, taper: exp }  # v5, REQ-8
<prefix>.amount: { range: 0..1, default: 0 }            # no-op default
<prefix>.wave:   { discrete, labels: WAVE_LABELS, range: 0..3, default: 0 }
<prefix>.dest:   { discrete, labels: LFO_DEST_LABELS, range: 0..6, default: 0 }  # v4: +shape
<prefix>.sync:   { discrete, labels: LFO_SYNC_LABELS, range: 0..18, default: 0 } # v6, REQ-9
master.modWheel: { range: 0..1, default: 0 }            # sums into LFO 1 only (REQ-11)
```

`LFO_DEST_LABELS = ['off', 'cutoff', 'pitch', 'amp', 'pulse', 'pan', 'shape']`.
Index `0` stays `off`, so the default remains a no-op (ADR-006), and appending
keeps every value an existing patch can hold (`0..5`) at its original meaning.
`LFO_SYNC_LABELS = SYNC_LABELS` (`free` + 18 divisions), index `0` = `free`.

### Contract / public interface

```yaml
LFO:                   # one instance per LFO; `new LFO(ctx)` twice
  toPitch:  GainNode   # cents      -> osc detune  (raw)
  toCutoff: GainNode   # semitones  -> filter cutoffNote (raw)
  toAmp:    GainNode   # linear     -> tremolo gain (smoothed)
  toPan:    GainNode   # -1..1      -> synth bus panner.pan (smoothed, v2)
  toShape:  GainNode   # -0.5..0.5  -> every voice's filter.shape (smoothed, v4)
  setRate(hz) / setWave(idx) / setAmount(0..1) / setDest(idx)
  bind(bus, prefix, pulse, src, modWheelId?)   # v7: self-wires its own params
# `pulse` has no output node — see PwmDriver (oscillators.md).

LfoPulseSink:          # v7: the slice of PwmDriver an LFO may drive. Structural,
  setDest(src, d)      #  so lfo.ts imports nothing from pwm.ts and the existing
  setRate(src, hz)     #  pwm -> lfo import stays a one-way edge.
  setWave(src, idx)
  setAmount(src, a)
```

`bind` is the house param-wiring pattern (ADR-008, as `Effect.bind(bus, prefix)`):
each LFO subscribes its own `${prefix}.{rate,sync,amount,wave,dest}` plus
`transport.bpm`, and `modWheelId` only when given — which is LFO 1 only (REQ-11).
Putting the mod-wheel sum here rather than in a closure inside the private
`Engine.subscribeParams()` is what makes it unit-testable against a mock context.

`src/state/lfo-routing.ts` keeps the two-LFO vocabulary and **loses only the rule**:

```yaml
LFO_PREFIXES:  ['lfo', 'lfo2']
otherLfo(p)              -> the other prefix
# blockedDests(mine, theirs) — DELETED with REQ-12 (v8)
```

What greys a destination now is the per-voice/bus-wide rule in
[mod-matrix](mod-matrix.md) REQ-7, which lives in `src/state/mod-routing.ts` in exactly
this shape — pure, so the panel and the audio layer cannot disagree.

Depth at full amount, per destination: pitch `±1200` cents, cutoff `±24`
semitones, amp `±0.5` linear (added to the tremolo VCA's base `1.0`), pan `±1.0`,
shape `±0.5` (v4). Only the active destination's gain is non-zero; the rest ramp
to `0`.

### Layer touchpoints

```yaml
engine (subscribeParams):                    # v7: two bind calls replace the block
  this.lfo.bind(bus, 'lfo',  this.pwm, 0, 'master.modWheel')
  this.lfo2.bind(bus, 'lfo2', this.pwm, 1)   # no mod wheel — REQ-11
  osc{1,2}.pulseWidth -> this.pwm.setBase(i, x)   # stays in Engine: osc-owned
  # bind() must run after init(), which builds this.pwm. It already does:
  # subscribeParams dereferences this.pwm.
engine (construction):
  connectLfoToVoice(lfo, v)  # the 6 per-voice connects, called once per LFO per voice
  lfo.toPan, lfo2.toPan -> synthPan.pan      # two GainNodes, one AudioParam = sum
graph (v2):
  per LFO:       osc -> toPitch, toCutoff                    # raw
                 osc -> smooth(lowpass 200Hz Q0.5) -> toAmp, toPan, toShape
  synth bus:     voiceBus -> synthFx(dist..reverb) -> synthPan -> preMaster
                 synthPan  -> bankRenderNode.input           # tap moved past the panner
ui: src/ui/panels/lfo-panel.ts (both pages) + mod-wheel control
```

When the destination is the filter, modulation is additive in **semitones** —
the same invariant as [ladder-filter](ladder-filter.md) and [envelopes](envelopes.md).

The bank-render tap (see [render-to-sampler](render-to-sampler.md)) reads from
the panner, not the FX tail, so a rendered bank captures the pan movement the
user heard.

## Scenarios (BDD)

```gherkin
Scenario: The summed mod-wheel amount scales every destination's depth
  Given lfo.amount is 0.3 and master.modWheel is 0.5
  When the engine passes the sum 0.8 to the LFO
  Then the active destination's depth is 0.8 of its full-scale value
# pinned by: tests/audio/lfo.test.ts

Scenario: Amount is clamped at full (edge)
  Given a summed amount of 1.3 reaches the LFO
  Then the depth used is the full-scale value, not 1.3x it
# pinned by: tests/audio/lfo.test.ts

Scenario: Selecting pan drives the synth bus panner
  Given lfo.dest is set to "pan" and lfo.amount is 1
  Then toPan's gain ramps to 1 and toPitch/toCutoff/toAmp all ramp to 0
# pinned by: tests/audio/lfo.test.ts

Scenario: Switching away from pan re-centres the image
  Given lfo.dest is "pan"
  When the user selects "cutoff"
  Then toPan's gain ramps to 0, so pan settles at its 0 (centre) base value
# pinned by: tests/audio/lfo.test.ts

Scenario: Only the amplitude-domain destinations are smoothed (edge)
  Given the LFO waveform is square
  Then toAmp and toPan are fed through the smoothing lowpass
  And toPitch and toCutoff are fed from the oscillator directly
# pinned by: tests/audio/lfo.test.ts

Scenario: Selecting shape sweeps the POLY pole mix (v4)
  Given lfo.dest is set to "shape" and lfo.amount is 1
  Then toShape's gain ramps to 0.5 and every other destination gain ramps to 0
  And toShape is fed through the smoothing lowpass, not the raw oscillator
# pinned by: tests/audio/lfo.test.ts

Scenario: An existing patch's destination index is unchanged
  Given a preset saved before v2 with any "lfo.dest" in 0..4
  When it is loaded
  Then validation accepts it and index 3 is still "amp"
  And index 6 is now accepted, while 7 is still rejected
# pinned by: tests/state/preset-validate.test.ts

Scenario: The rate knob moves in octaves, not in Hz (v5, REQ-8)
  Given lfo.rate is exponentially tapered over 0.05..20
  Then the knob's midpoint is 1 Hz, not 10 Hz
  And equal turns anywhere on the dial multiply the rate by the same factor
# pinned by: tests/state/params.test.ts

Scenario: An existing patch's stored rate survives the taper change (v5, REQ-8)
  Given a preset saved before v5 with "lfo.rate" 12.5
  When it is loaded
  Then lfo.rate is still exactly 12.5 and validation accepts it
  And only the knob position it maps to has moved
# pinned by: tests/state/params.test.ts
Scenario: A synced LFO takes its rate from the tempo (v6, REQ-9)
  Given transport.bpm 120 and lfo.rate 7
  When lfo.sync is set to 1/4
  Then the LFO runs at 2 Hz, and at 1 Hz once the tempo halves
# pinned by: tests/ui/tempo-sync.test.ts, e2e/lfo-sync.spec.ts

Scenario: Free-running is the default and nothing changes (v6, REQ-9, ADR-006)
  Given lfo.sync is 0
  When the tempo changes
  Then the LFO keeps the rate the knob set
# pinned by: e2e/lfo-sync.spec.ts

Scenario: Leaving sync restores the knob's own rate (v6, REQ-9)
  Given a synced LFO whose stored lfo.rate is 7
  When lfo.sync goes back to free
  Then the LFO returns to 7 Hz — the stored value was never rewritten
# pinned by: e2e/lfo-sync.spec.ts

Scenario: The rate knob dims while synced (v6, REQ-9)
  When lfo.sync names a division
  Then knob-lfo.rate is aria-disabled, still visible and still holding its value
# pinned by: e2e/lfo-sync.spec.ts

Scenario: LFO 2 changes nothing until it is armed (v7, REQ-10, ADR-006)
  Given a preset saved before v7, with no lfo2.* keys
  When it is loaded
  Then lfo2.dest is off and lfo2.amount is 0, and the patch sounds unchanged
# pinned by: tests/state/params.test.ts, e2e/lfo2.spec.ts

Scenario: The two LFOs are registered identically (v7, REQ-10)
  Given both param sets come from one lfoParams(prefix) factory
  Then every lfo2.* def matches its lfo.* twin in min, max, default, taper and labels
# pinned by: tests/state/params.test.ts

Scenario: The mod wheel opens LFO 1 and leaves LFO 2 alone (v7, REQ-11)
  Given lfo.amount 0.3, lfo2.amount 0.4 and both destinations armed
  When master.modWheel moves to 0.5
  Then LFO 1's depth is 0.8 of full scale and LFO 2's is still 0.4
# pinned by: tests/audio/lfo.test.ts

Scenario: Both LFOs may now hold one destination (v8, REQ-12 superseded)
  Given lfo.dest is "cutoff"
  When the user opens LFO 2's destination list
  Then "cutoff" is selectable, not greyed
  And choosing it sums the two, as REQ-13 always specified
# pinned by: tests/ui/lfo-panel.test.ts, e2e/lfo2.spec.ts

Scenario: A hand-authored duplicate still loads and renders truthfully (v8, edge)
  Given a song puts both LFOs on "amp"
  When the panel renders
  Then each dropdown shows "amp" as its own value, neither is blank
  And validation accepted the file, as it always did
# pinned by: tests/ui/lfo-panel.test.ts, tests/state/preset-validate.test.ts

Scenario: Two LFOs on one destination sum, bounded (v7, REQ-13, edge)
  Given both LFOs are routed to "pan" at full amount
  Then both toPan gains reach 1 and the panner clamps the sum to +/-1
# pinned by: tests/audio/lfo.test.ts

Scenario: LFO 2 leaving a destination does not stop LFO 1's PWM sweep (v7, REQ-14)
  Given LFO 1 owns the pulse driver and is sweeping the width
  When LFO 2 switches its destination from "off" to "cutoff"
  Then the driver keeps running and LFO 1's sweep is uninterrupted
# pinned by: tests/audio/pwm.test.ts

Scenario: The lower LFO index wins the pulse driver (v7, REQ-14, edge)
  Given a hand-authored song sets both destinations to "pulse"
  When it loads in either key order
  Then LFO 1 drives the pulse width and LFO 2's setters are ignored
# pinned by: tests/audio/pwm.test.ts

Scenario: A modulating LFO on the hidden page lights its tab (v7, REQ-15)
  Given the panel is showing page 1 and lfo2.dest is "pan" at amount 0.6
  Then the LFO 2 tab is lit, and it goes dark when lfo2.amount returns to 0
# pinned by: tests/ui/lfo-panel.test.ts
```


## Tests & verification

- `tests/audio/lfo.test.ts`, `tests/audio/pwm.test.ts`,
  `tests/state/params.test.ts`, `tests/audio/mod-matrix.test.ts`,
  `tests/state/preset-validate.test.ts`, `tests/ui/lfo-panel.test.ts`,
  `e2e/lfo-sync.spec.ts`, `e2e/lfo2.spec.ts`, `e2e/controls.spec.ts`.
- `npm test` / `npm run e2e`.
- **By ear** (ADR-010, `recipes/verify-audio-by-ear.md`): the smoothing constants
  in REQ-5 are only settled by listening — square at full depth on both `amp` and
  `pan`, A/B'd against a bypassed baseline with the other lanes muted. v7 adds
  three takes that nothing automated can cover: both LFOs off must match the
  pre-v7 baseline (the REQ-10 no-op); LFO 1 → `pulse` while LFO 2 is toggled
  between `cutoff` and `off` must not drop the PWM sweep (REQ-14); and both LFOs
  on `amp` at full depth must bottom out at silence smoothly, not click or invert
  (REQ-13).

## Open questions / future

- The LFOs are monophonic/global by design; a per-voice LFO would be a separate
  feature with its own params.
- **Two is a hard-coded count, not a pool** — and it stayed that way. The matrix
  ([mod-matrix](mod-matrix.md)) answered the *routing* half of this: many
  destinations per source, depth per route, REQ-12 gone (v8). What it did **not**
  do is add a third oscillator — `LFO_PREFIXES`, the `lfoParams` factory,
  `PwmDriver`'s owner arbitration and the two-tab panel all still assume exactly
  two. A third LFO is now a small, separate change: register `lfo3.*`, and it
  becomes another matrix source.
- `Engine` never calls `pwm.dispose()`. Pre-existing; one shared driver (REQ-14)
  keeps it a single gap rather than two.
- `e2e/lfo-sync.spec.ts` and `e2e/lfo2.spec.ts` read `engine.lfo.osc` /
  `engine.lfo2.osc`, reaching a `private` field through an `any` cast at runtime.
  A `get rateHz()` accessor on `LFO` would be cleaner.
- `pulse` was a dead label until v3 — `update()` routed only pitch/cutoff/amp, so
  selecting it silenced all modulation while the UI advertised "PWM movement".
  Kept at index 4 rather than reclaimed, so no saved patch changed meaning.
- Motion lanes and XY assignments store values **normalized 0..1**, so a lane
  targeting `lfo.dest` shifts meaning when the range grows (`0.5` was `2`/pitch
  at `0..4`, is `3`/amp at `0..5`). Presets, songs and share links store raw
  values and are unaffected. Accepted rather than engineered around — automating
  a discrete destination is not a supported gesture.
