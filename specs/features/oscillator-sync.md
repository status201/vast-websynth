# Oscillator sync (hard + reversing soft sync)

```yaml
id: oscillator-sync
status: implemented
version: 3                     # v3: cross-modulation — the pair lands on each Osc's pre-level
                               #     `signal` tap, and takes an a-rate `fm` input (cross-modulation.md)
                               # v2: review — the engagement state machine moves out of Voice
                               #     into SyncEngagement (SRP); LFO depths come from LFO_DEST_SCALE;
                               #     SyncOscNode.create(ctx) loses its unused initialHz
owner: core
related:
  - oscillators                # osc1/osc2 this pairs up; the open question it answers
  - mod-matrix                 # the `sync` destination
  - lfo                        # the `sync` destination
  - voicing                    # unison/drift/glide reach the pair through the voice
  - runtime-performance        # the pair is created on first use (REQ-boot-cost-matches-the-request)
  - ../decisions/adr-026-oscillator-sync-is-a-per-voice-worklet-pair
  - ../decisions/adr-010-musical-stable-cheap-dsp
  - ../decisions/adr-012-true-bypass-disconnects
  - ../decisions/adr-017-modulation-in-graph
  - cross-modulation           # v3: ring mod reads the pair's outputs, FM drives its slave
source:
  - public/worklets/sync-osc.js      # the DSP
  - src/audio/sync-osc/node.ts       # the wrapper
  - src/audio/sync-osc/engagement.ts # native <-> pair crossfade + idle gate (SyncEngagement)
  - src/audio/frequency-line.ts      # the glide maths Osc and the pair share
  - src/audio/oscillator.ts          # native fade + the mirror the pair follows
  - src/audio/voice.ts               # engage/disengage, the pitch + sync junctions
  - src/audio/engine.ts              # lazy creation, subscriptions
  - src/audio/lfo.ts                 # toSync
  - src/state/lfo-routing.ts         # LFO_DEST_SCALE — one depth table for the LFO and the arcs
  - src/audio/mod-matrix.ts          # the sync destination
  - src/state/params.ts              # osc2.sync, osc2.syncPitch, LFO_DEST_LABELS
  - src/state/mod-routing.ts         # MOD_DEST_LABELS
  - src/state/mod-depth.ts           # the SYNC knob's reach arc
  - src/ui/panels/synth-panels.ts    # SYNC segmented + knob on OSC 2
  - public/sw.js                     # the worklet is precached in CORE_ASSETS
```

Oscillator sync locks osc2 (the **slave**) to osc1 (the **master**): every time the
master completes a cycle, the slave is reset (**hard**) or reversed (**soft**). The
slave's own pitch then stops being heard as pitch and becomes timbre, and sweeping
it gives the classic tearing, vocal sync lead.

## Background / Why

A native `OscillatorNode` cannot reset its phase, so no form of sync can be built
from the graph the oscillators already use ([oscillators](oscillators.md) →
"Open questions" asked for a worklet oscillator to be proposed against ADR-010
rather than added silently). [ADR-026](../decisions/adr-026-oscillator-sync-is-a-per-voice-worklet-pair.md)
is that proposal: a per-voice worklet that renders both oscillators while sync is
engaged, with every discontinuity band-limited, and nothing at all while it is
not.

The research behind the choice (the kinds of sync, and the five ways to
band-limit them) is recorded in the ADR. In short: a precomputed-wave bank (the
PWM trick) is alias-free but cannot sweep, and the sweep *is* the sound; a naive
reset aliases at −3…−24 dB; polyBLEP gets to −16…−39 dB; the windowed-sinc
residual shipped here reaches the measurement floor in band.

## Requirements

- **REQ-sync-off-is-the-native-path** — `osc2.sync` defaults to `off`, and while it
  is off the voice sounds exactly as before sync existed: the native oscillators
  feed the mixer (through `Osc`'s unity fade gain, an exact `×1`), the sync
  worklet does not exist (or is disconnected and idle) and nothing a preset or
  song already contains sounds different (ADR-006).
- **REQ-sync-has-hard-and-soft-modes** — `osc2.sync` is discrete
  `off | hard | soft`. **hard** resets the slave to the start of its cycle at the
  master's wrap. **soft** is *reversing* sync: the slave's direction of travel
  flips at the master's wrap, so its value stays continuous and only its slope
  turns — a rounder, triangle-core character that also aliases less. Threshold,
  phase-advance, inhibit and overlap variants are out of scope.
- **REQ-sync-pitch-is-the-sweep** — `osc2.syncPitch`, `0..48` semitones, sets
  the slave's pitch **above** osc2's own octave + tune. It is inert while sync is
  off. Its default is `12`, so engaging sync is audible straight away (an inert
  param's default is still a no-op, ADR-006).
- **REQ-the-pair-owns-both-phases** — While engaged, one worklet per voice renders
  **both** osc1 (output 0) and osc2 (output 1). The master never stays native
  beside a phantom copy in the worklet: the worklet cannot read a native node's
  phase, voices run for the whole session, and two pitch computations would
  drift apart, so at ratio 1 the pair would comb-cancel note to note instead of
  reinforcing. One owner makes the lock structural.
- **REQ-the-pair-follows-every-osc-control** — The pair plays what the OSC 1 / OSC 2
  panels say: wave, octave, tune and pulse width (including a live PWM sweep)
  reach it through a mirror on each `Osc`. The pair's outputs land on each
  `Osc.signal`, the pre-level tap the native fade feeds too, so level stays on
  `Osc.out` and there is one level control whichever path is sounding (v3; the
  tap is what ring mod and FM read, [cross-modulation](cross-modulation.md)
  REQ-oscillator-signals-are-tapped-pre-level). Glide uses the same
  maths as the native oscillator (`FrequencyLine`). The sub-oscillator stays
  native and unsynced.
- **REQ-every-pitch-source-reaches-the-pair** — Pitch bend, the per-note bend,
  both LFOs' `pitch`, analogue drift and matrix `pitch` routes move the pair
  exactly as they move the native oscillators. Each source connects to the
  voice's `pitchTargets()` — the three native detunes plus one pitch junction
  that feeds the pair — so the list is written once, not per call site.
- **REQ-sync-is-a-modulation-destination** — `sync` is appended to
  `MOD_DEST_LABELS` (full scale ±48 st) and to `LFO_DEST_LABELS` (±24 st at full
  amount). Both sum into a per-voice sync junction whose own offset is the knob,
  so per-voice sources work in-graph and sample-accurately — the filter envelope
  sweeping sync, the archetypal patch (ADR-017). The SYNC knob draws its reach
  arc from both, like CUTOFF ([mod-matrix](mod-matrix.md)
  REQ-a-modulated-knob-shows-its-reach).
- **REQ-engaging-sync-crossfades** — Engaging or disengaging crossfades the native
  and pair paths with complementary `RAMP_BYPASS` ramps, then **disconnects** the
  side that went silent (ADR-012): the native oscillators stop rendering while
  sync is on, and the pair stops while it is off. A toggle made inside the
  crossfade window supersedes the earlier one, never races it.
- **REQ-the-pair-is-built-on-first-use** — No sync worklet module is loaded and no
  pair node exists until `osc2.sync` first leaves `off`
  ([runtime-performance](runtime-performance.md) REQ-boot-cost-matches-the-request). Until the pairs are ready, voices
  keep playing native. If the load fails, sync stays inert and the synth plays
  on — the failure is logged, never thrown into a subscriber. The worklet file is
  in the service worker's precached `CORE_ASSETS` beside the other three, so an
  installed app can engage sync offline. The thin wrapper is a static import, on
  purpose. An `import()` of it saved 0.8 kB of entry chunk, but it added a hashed
  chunk that an offline session may never have fetched. That would be a second
  way for the first engagement to fail, and it would buy almost nothing.
- **REQ-the-pair-idles-with-the-voice** — An engaged pair follows the voice's
  lifecycle exactly like the filter ([ladder-filter](ladder-filter.md)
  REQ-the-filter-idles-when-gated): active from `noteOn`, inactive once the
  voice goes idle. The amp VCA is closed at every flip, so the gate is
  inaudible.
- **REQ-every-discontinuity-is-band-limited** — Each value jump (saw/square edges,
  hard resets, wave/width changes) gets a band-limited step residual, each slope
  jump (triangle corners, sine resets, reversals) a band-limited ramp, and a sine
  reset's curvature jump a third-order residual, all placed at the event's
  sub-sample time. The kernel is a Blackman-Harris-windowed sinc of half-length
  `16` at cutoff `0.42·fs`, integrated once per module and shared by every
  instance. It needs lookahead, so **both** outputs are delayed by the same 16
  samples (0.33 ms at 48 kHz) and stay aligned.
- **REQ-the-reset-keeps-the-overshoot** — A hard reset does not put the slave at
  phase 0; it puts it where it would be had it started at the master's exact
  wrap instant (`overshoot × slave increment`). Without that, the slave's cycle
  length jitters by up to a sample, which is heard as roughness at high pitch.
- **REQ-the-slave-is-dc-free** — The slave output passes a 5 Hz DC blocker, and a
  pulse's analytic mean (`2w−1`) is subtracted from both oscillators. A synced
  wave's mean moves with the ratio, and a sweep would otherwise push a
  sub-audio wobble into the filter. The native oscillators carry no DC either,
  so this is what keeps the engage crossfade from thumping.
- **REQ-the-pair-is-bounded** — Output is finite and bounded for any parameter,
  including NaN and Infinity: every increment is clamped to `[0, 0.45]` cycles
  per sample (so at most one crossing per breakpoint per sample, never past
  Nyquist), the sync offset is clamped to `[-24, 72]` st, and a block that still
  ends non-finite resets the pair and outputs silence (ADR-010 *stable*).

## Technical design

### Data shapes (registry)

```yaml
osc2.sync:      { discrete, labels: OSC_SYNC_LABELS, range: 0..2, default: 0 }    # off | hard | soft
osc2.syncPitch: { range: 0..48, default: 12, unit: st }                           # inert while sync is off
MOD_DEST_LABELS: [..., 'sync']        # append-only (mod-matrix REQ-label-arrays-are-append-only), scale 48 st
LFO_DEST_LABELS: [..., 'sync']        # append-only (lfo REQ-destination-is-one-of-the-labels), ±24 st = LFO_DEST_SCALE.sync
```

### Contract / public interface

```yaml
SyncOscNode (src/audio/sync-osc/node.ts):
  static loadModule(ctx)          # '/worklets/sync-osc.js', once, on first engagement
  static create(ctx)              # one per voice
  master / slave: GainNode        # the two outputs' fade gains, 0 until engaged
  freq: FrequencyLine             # drives the a-rate `frequency` param (Hz)
  detune, syncPitch: AudioParam   # a-rate (cents, semitones), fed by the voice's junctions
  fm: AudioParam                  # a-rate FM index β (v3, cross-modulation.md REQ-fm-reaches-the-sync-pair)
  setMode(m)                      # k-rate `mode`: 0 free (tests), 1 hard, 2 soft
  masterMirror, slaveMirror       # OscMirror -> wave1/2, masterCents/slaveCents, width1/2 (k-rate)
  setActive(on)                   # the idle gate (REQ-the-pair-idles-with-the-voice)
SyncEngagement (src/audio/sync-osc/engagement.ts):  # one per voice; owns the state machine
  attach(pair)                    # once: mirrors on, pitch curve caught up, stored mode applied
  setMode(m)                      # stored before a pair exists; engage/disengage crossfade
  setFrequency(hz, when, glide)   # every note, engaged or not
  setVoiceActive(on)              # idle gate, only while engaged
  # one pending disconnect at a time: a toggle inside the window clears it
FrequencyLine (src/audio/frequency-line.ts):
  set(hz, when, glideSec)         # the anchored-cancel glide Osc already used
  at(t)                           # closed-form value of the curve at t
Osc:
  setMirror(m | null)             # pushes current wave/cents/width at once, then every change
  fadeNative(on) / dropNative()   # REQ-engaging-sync-crossfades
  frequencyAt(t)
Voice:                            # owns the junctions; delegates engagement to SyncEngagement
  pitchTargets(): AudioParam[]    # REQ-every-pitch-source-reaches-the-pair
  syncTarget: AudioParam          # the sync junction's offset
  attachSync(node)                # plugs the junctions in, then SyncEngagement.attach
  setSyncMode(m) / setSyncPitch(st)
LFO_DEST_SCALE (src/state/lfo-routing.ts):
  sync: 24                        # read by LFO.update AND mod-depth's arc — one number, two readers
```

### Worklet message contract

```yaml
port in:  boolean                 # active flag; defaults to true so a lost message costs CPU, never a note
port out: none
processorOptions:                 # measurement hooks for the alias test; the node never passes them
  kernel: 'sinc' | 'poly' | 'naive'
  half: 1..31                     # sinc half-length
outputs: 2, mono each             # 0 = master (osc1), 1 = slave (osc2)
```

### Layer touchpoints & ordering

```yaml
registry: src/state/params.ts -> osc2.sync, osc2.syncPitch, LFO_DEST_LABELS += sync
routing:  src/state/mod-routing.ts -> MOD_DEST_LABELS += sync, MOD_DEST_SCALE[sync] = 48
engine:   osc2.sync      -> ensureSync() (lazy, memoized) then all(v.setSyncMode)
          osc2.syncPitch -> all(v.setSyncPitch)
graph (per voice, engaged):
  pitch sources -> pitchTargets() = [osc1.detune, osc2.detune, sub.detune, pitchMod.offset]
  pitchMod -> pair.detune ; syncMod(offset = knob) -> pair.syncPitch
  lfo.toSync, matrix sync routes -> syncMod.offset
  pair out0 -> master gain -> osc1.signal ; pair out1 -> slave gain -> osc2.signal
  native osc1/osc2 -> Osc.fade -> Osc.signal   (faded out, then disconnected)
  Osc.signal -> Osc.out (level)
  fmMod (cross-mod's index junction) -> pair.fm
ui: OSC 2 panel — SYNC segmented (off/hard/soft) + SYNC knob (shown while sync != off)
```

The junctions are `ConstantSourceNode`s at offset 0 (pitch) and at the knob's
value (sync), so every target in every list stays an `AudioParam`. The native
path's connections are unchanged; the pitch junction is an *additional*
destination of each source, which is why sync-off renders exactly as before.

## Scenarios (BDD)

```gherkin
Scenario: Sync off is the native path (REQ-sync-off-is-the-native-path, backward compat)
  Given a preset that never set osc2.sync
  Then osc2.sync is off and no sync worklet module has been loaded
  And the native oscillators feed the mixer as before
# pinned by: tests/audio/voice-sync.test.ts, tests/state/params.test.ts

Scenario: Engaging sync builds the pairs once, on first use (REQ-the-pair-is-built-on-first-use)
  Given the engine has booted with sync off
  When osc2.sync becomes hard, then off, then soft
  Then the worklet module is loaded exactly once and one pair exists per voice
# pinned by: tests/audio/engine-sync.test.ts

Scenario: Engaging crossfades native to pair, then cuts the native side (REQ-engaging-sync-crossfades)
  Given a voice with its pair attached
  When sync is set to hard
  Then the pair's gains ramp to 1 and the native fades ramp to 0
  And after the crossfade the native oscillators are disconnected
  When sync is set back to off within the crossfade window
  Then the native side is not disconnected and the pair is cut instead
# pinned by: tests/audio/voice-sync.test.ts

Scenario: The pair follows the OSC panels (REQ-the-pair-follows-every-osc-control)
  Given a voice with its pair attached
  When osc1's wave, octave or width changes, or osc2's tune changes
  Then the pair's matching param is written
# pinned by: tests/audio/voice-sync.test.ts

Scenario: Every pitch source reaches the pair (REQ-every-pitch-source-reaches-the-pair)
  Given the engine is running
  Then pitch bend, both LFOs' pitch, drift and the per-note bend connect to each voice's pitch junction
  And a matrix pitch route wires the junction along with the three detunes
# pinned by: tests/audio/engine-sync.test.ts, tests/audio/voice-sync.test.ts, tests/audio/mod-matrix.test.ts

Scenario: Sync is a modulation destination (REQ-sync-is-a-modulation-destination)
  Given mod row 0 routes filter env to sync at amount 0.5
  Then each voice's sync junction receives the route at 24 semitones
  And the SYNC knob's reach is 24 semitones
  And an LFO on sync drives its toSync output at ±24 semitones
# pinned by: tests/audio/mod-matrix.test.ts, tests/state/mod-depth.test.ts, tests/audio/engine-sync.test.ts

Scenario: Hard sync locks the slave to the master's period (REQ-sync-has-hard-and-soft-modes)
  Given the pair in hard mode at a non-integer ratio
  Then the slave output repeats with the master's period
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: A wrap that lands exactly on a sample still resets (regression, REQ-sync-has-hard-and-soft-modes)
  Given a master period of a whole number of samples
  Then every master wrap resets the slave
  # Found while implementing: a breakpoint at the very end of a span was deferred
  # to "the next span", the phase normalised past 1 with no event, and the slave
  # was never reset — sync silently off on every integer-period pitch.
# pinned by: tests/audio/sync-osc-worklet.test.ts (the 64-sample period case)

Scenario: Soft sync keeps the slave continuous (REQ-sync-has-hard-and-soft-modes)
  Given the pair in soft mode with a triangle slave
  Then no sample-to-sample step exceeds what the slave's own slope allows
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: Sync aliasing is at the floor in band (REQ-every-discontinuity-is-band-limited)
  Given a saw slave hard-synced at ratios 1.5 to 7.9 on masters from 130 Hz to 5.6 kHz
  Then energy between the harmonics is at least 60 dB down below 10 kHz
  And the shipped kernel beats polyBLEP and a naive reset by at least 15 dB in every case
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: The pair is bounded for any input (REQ-the-pair-is-bounded, edge)
  Given NaN, Infinity, 0 Hz and extreme sync offsets on every param
  Then every output sample is finite and within ±2
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: The pair idles with the voice (REQ-the-pair-idles-with-the-voice)
  Given sync is engaged
  When a note starts and later releases to idle
  Then the pair is told active at noteOn and inactive once the voice is idle
# pinned by: tests/audio/voice-sync.test.ts

Scenario: The SYNC knob is only on show while sync is engaged
  Given osc2.sync is off
  Then knob-osc2.syncPitch is hidden
  When the user selects hard
  Then it appears
# pinned by: e2e/controls.spec.ts
```

## Tests & verification

- Unit: `tests/audio/sync-osc-worklet.test.ts` (the DSP under the stubbed
  worklet globals, the pattern of `ladder-filter-worklet.test.ts`),
  `tests/audio/voice-sync.test.ts`, `tests/audio/engine-sync.test.ts`, plus the
  existing `mod-matrix` / `mod-depth` / `params` suites — `npm test`.
- E2E: `e2e/controls.spec.ts` — `npm run e2e`.
- **The alias metric** is objective because a hard-synced wave is exactly periodic
  at the master's frequency: with a half-integer period in samples, every folded
  partial lands *between* the harmonics, so the DFT bins between them measure
  aliasing directly.
- Measured at 48 kHz (prototype, Node):
  - The shipped kernel puts saw, triangle and square slaves at or below −60 dB in
    band, and at −36…−89 dB in total, against −3…−24 dB naive and −16…−39 dB for
    polyBLEP.
  - A **sine slave** degrades above ~3 kHz masters (−17…−46 dB at the top). A
    sine segment near Nyquist has higher-order jumps that do not converge, so
    only oversampling would fix it. That is accepted under ADR-010.
- **Cost** (Node, 8 voices all sounding, vibrato on): ~3.5–12% of one core
  across runs and settings, the top end being a 1 kHz note at ratio 8. The
  ladder filter, which runs regardless, measures ~3.4% the same way. The pair
  runs only for sounding voices with sync on. Not yet measured inside a browser.
- **Rendered through the real graph** (`npm run bench:audio`, A2 held, saw/saw,
  LFO on `sync`, 2026-10-27):
  - The spectral centroid holds at ~1.6 kHz with sync off. It sweeps
    1.47–2.62 kHz at the LFO's period with hard sync, and 1.68–2.54 kHz with
    soft.
  - Firefox renders the same sweep (1.52–2.72 kHz against a steady 1.85 kHz).
  - That proves the pair engages and the LFO destination works in-graph on both
    engines. It is not a listening verdict.
- **By ear** (ADR-010, `recipes/verify-audio-by-ear.md`):
  - `npm run bench:audio` on Chromium **and** `--browser firefox`, because the
    pair is driven by AudioParam automation.
  - A/B against the sync-off baseline, on a demo with the drums muted.
  - Passing tests do not settle how it sounds.

## Open questions / future

- **The engage step is level-matched on Blink, not on Gecko.** Gecko's native
  oscillators render quieter: sync-off rms 0.0160 there, against 0.0248 on
  Chromium. The pair is the same DSP on both (0.0251), so on Firefox engaging
  sync is ~4 dB louder. The difference lives in the native path and predates
  this feature. Settle it by ear before compensating either side.
- The engage crossfade itself (toggling sync over a held note) has not been
  rendered: the bench applies its `--set`s before the take, not during it.

- Threshold ("weak") sync is the cheapest next mode — the same DSP behind a gate.
- ~~Ring mod and linear FM are all-native neighbours and want their own spec.~~
  Done in v3: [cross-modulation](cross-modulation.md). FM inside the pair is not
  through-zero yet.
- The sub-oscillator could join the pair as a third phase if a locked sub turns
  out to matter by ear.
