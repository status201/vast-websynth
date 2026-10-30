# Cross-modulation (ring mod + linear FM, OSC 1 as the modulator)

```yaml
id: cross-modulation
status: implemented
version: 1
owner: core
related:
  - oscillators                # the two Osc wrappers this taps
  - oscillator-sync            # the pair gains an `fm` input; ring reads its outputs too
  - mod-matrix                 # the `fm` destination
  - responsive-synth-panels    # OSC 1's second row
  - presets                    # the five showcases; every bank pins osc1.fm/ring off
  - onboarding                 # OSC 1 / OSC 2 help badges
  - runtime-performance        # nothing renders while unused
  - ../decisions/adr-006-no-op-param-defaults
  - ../decisions/adr-010-musical-stable-cheap-dsp
  - ../decisions/adr-012-true-bypass-disconnects
  - ../decisions/adr-017-modulation-in-graph
source:
  - src/audio/cross-mod.ts           # CrossMod: the per-voice FM + ring graph and its engagement
  - src/audio/oscillator.ts          # Osc.signal (the pre-level tap), frequencyParam, cents
  - src/audio/voice.ts               # owns a CrossMod; fmTarget; the osc setters that keep k current
  - src/audio/sync-osc/engagement.ts # the pair lands on Osc.signal
  - src/audio/sync-osc/node.ts       # SyncOscNode.fm
  - public/worklets/sync-osc.js      # the `fm` param
  - src/audio/engine.ts              # subscriptions + the FM in-use predicate
  - src/audio/mod-matrix.ts          # the fm destination, usesDest
  - src/state/params.ts              # osc1.fm, osc1.ring
  - src/state/mod-routing.ts         # MOD_DEST_LABELS += fm
  - src/state/mod-depth.ts           # the FM knob's reach arc
  - src/ui/panels/synth-panels.ts    # FM + RING on OSC 1
```

Two classic two-oscillator timbres, both built from native nodes. **Ring
modulation** multiplies OSC 1 by OSC 2, which gives sum and difference
frequencies: bells, metal, robot voices. **Linear FM** drives OSC 2's frequency
with OSC 1's waveform: DX-style electric pianos, clangs and basses.

## Background / Why

[oscillator-sync](oscillator-sync.md) → "Open questions" left both as "all-native
neighbours that want their own spec". OSC 1 is already the master in sync, so it
is the modulator here as well. Its panel had three knobs while OSC 2 carried
WIDTH, SYNC and a segmented control. Putting the two new controls on OSC 1 evens
the panels out, and it reads correctly: OSC 1's knobs are its *outputs*. LEVEL
goes to the mixer, FM into OSC 2's pitch, and RING (1×2) into the mixer. SYNC
stays on OSC 2, because sync is something OSC 2 does to itself.

Five factory presets show off cross-mod and sync: `tines`, `chime` and `growl`
(FM), `clang` (ring) and `tear` (sync plus FM). Each one's A/B is one knob to 0
([presets](presets.md) REQ-factory-presets-span-the-instrument-families). OSC 1
and OSC 2 carry separate help badges, because one topic covering both had grown
too long ([onboarding](onboarding.md) REQ-each-oscillator-carries-its-own-badge).

## Requirements

- **REQ-cross-mod-off-is-the-native-path** — `osc1.fm` and `osc1.ring` default to
  `0` (ADR-006). At 0 no part of either graph is connected to anything that
  sounds, so every existing preset and song renders as it did before.
- **REQ-oscillator-signals-are-tapped-pre-level** — Each `Osc` has a unity
  `signal` junction between its sources and its LEVEL gain
  (`native → fade → signal → out`). The sync pair's outputs land on `signal` too,
  so the junction always carries *the sounding oscillator*, native or pair. Both
  cross-mods read it, so OSC 1 at LEVEL 0 still modulates (a silent FM
  modulator is the textbook 2-op setup). A ×1 gain is an exact multiply.
- **REQ-fm-index-is-relative-to-the-modulator** — `osc1.fm` is the modulation
  index β, `0..8`. OSC 2's instantaneous frequency is `f2 + β · f1 · osc1(t)`,
  where `f1` is OSC 1's sounding frequency. The timbre therefore holds across the
  keyboard, under glide, bend, LFO pitch and drift, and when either oscillator's
  octave changes. The graph achieves this without a per-frame loop. Web Audio
  scales `frequency` inputs by `2^(detune/1200)`, so the deviation fed in is
  `β · f_note · k · osc1(t)` with `k = 2^((cents1 − cents2)/1200)`. Shared pitch
  modulation cancels, and only the octave/tune ratio `k` is computed, on a knob
  change. `f_note` is a per-voice constant source that follows the note through
  the same `FrequencyLine` glide as the oscillators.
- **REQ-fm-is-through-zero-on-the-native-path** — The deviation is not clamped,
  so with β large enough OSC 2's frequency crosses zero and its phase runs
  backwards (Web Audio's nominal frequency range is `±Nyquist`). This is what
  keeps high-index FM in tune. Blink and Gecko both do it (measured, see Tests &
  verification).
- **REQ-fm-reaches-the-sync-pair** — While sync is engaged, the native OSC 2 is
  disconnected, so FM moves into the pair. The worklet takes an a-rate `fm` param
  (the same β signal) and adds `β · masterInc · master(t)` to the slave's
  increment. The master value is the previous sample's naive value, a one-sample
  delay. The index means the same thing on both paths, so engaging sync does not
  re-scale FM. Inside the pair FM is **not** through-zero: the slave increment
  keeps its `[0, 0.45]` clamp (oscillator-sync.md REQ-the-pair-is-bounded). FM at
  0 leaves the worklet's output identical.
- **REQ-fm-is-a-modulation-destination** — `fm` is appended to `MOD_DEST_LABELS`
  (full scale 8 index units). A per-voice junction (`fmMod`, offset = the knob)
  sums the routes, in-graph and sample-accurate. Filter env → FM is the
  archetypal decaying-brightness FM patch (ADR-017). The FM knob draws its reach
  arc from the matrix (mod-matrix.md REQ-a-modulated-knob-shows-its-reach). The
  LFOs reach `fm` through the matrix: `LFO_DEST_LABELS` is not extended.
- **REQ-ring-is-its-own-level** — `osc1.ring`, `0..1`, is the level of a third
  source in the voice mix: `osc1.signal × osc2.signal × RING_MAKEUP`. It is
  independent of both oscillators' LEVELs, so pure ring means turning both LEVELs
  down. The product of two unit waves is quieter than either. `RING_MAKEUP` = √2
  levels sine×sine exactly against one sine at the same knob value; saw×saw stays
  about 4 dB under a saw (measured, see Tests & verification).
- **REQ-ring-is-dc-free** — The product of two DC-free waves is not DC-free.
  Near-unison oscillators give a mean that wobbles at the beat rate and thumps
  into the filter. The ring path therefore passes a 20 Hz highpass biquad
  (`RING_HP_HZ`) before its level. The biquad is Butterworth: Web Audio reads a
  high-pass `Q` in **dB**, so it is `RING_HP_Q_DB` ≈ −3.01. 0.7071 read as dB
  would be a linear Q of ~1.09, a bump at 20 Hz.
- **REQ-cross-mod-disconnects-when-unused** — Each path is engaged only while it
  can be heard, and disconnected otherwise (ADR-012). FM is engaged while
  `osc1.fm > 0` or a live matrix row targets `fm`. Ring is engaged while
  `osc1.ring > 0`. Each path's input edges are cut along with its output edge,
  not just its output. Blink skips a chain the destination cannot reach, but
  Gecko renders every node it holds. Engaging connects before any gain rises.
  Disengaging cuts the connections `DISCONNECT_DELAY_MS` after the gain reached 0. A re-engage inside
  that window cancels the cut instead of racing it. While FM is disengaged,
  OSC 2's `frequency` has no input and keeps the browser's k-rate fast path.
- **REQ-cross-mod-is-bounded** — The registry clamps the knobs. In the worklet,
  β is clamped to `±16` and the result to the existing increment bounds, and the
  block-end NaN guard still applies. On the native path, Web Audio clamps an
  oscillator's computed frequency to `±Nyquist`, so any route sum stays finite.
- **REQ-the-modulator-controls-live-on-osc-1** — OSC 1 shows `OCT TUNE LEVEL`
  over `FM RING` (plus WIDTH on the square wave). FM and RING are always on show,
  so OSC 1 always has two rows. Up to 3199px the row break holds. From 3200px,
  the step where six 52px boxes fit (the same step `.hex` takes,
  responsive-synth-panels.md REQ-ultrawide-panels-are-one-row), OSC 1 goes to
  one row. OSC 2 is unchanged.

## Technical design

### Data shapes (registry)

```yaml
osc1.fm:   { range: 0..8, default: 0, taper: power, curve: 2, format: index (1 dp) }  # β; half-way = 2
osc1.ring: { range: 0..1, default: 0, format: pct }
MOD_DEST_LABELS: [..., 'fm']   # append-only (mod-matrix REQ-label-arrays-are-append-only)
MOD_DEST_SCALE[fm]: 8          # index units, = the knob's full range
```

### Contract / public interface

```yaml
Osc:
  signal: GainNode              # unity, pre-level; the pair lands here too
  frequencyParam: AudioParam    # the native node's frequency (FM input)
  cents: number                 # octave*1200 + tune, read for k
CrossMod (src/audio/cross-mod.ts):   # one per voice, owned by Voice
  fmTarget: AudioParam          # fmMod.offset: the knob + matrix routes
  fmSignal: AudioNode           # fmMod itself: the pair's `fm` input listens here
  setFmIndex(beta)              # knob
  setFmInUse(on)                # engine's predicate: knob > 0 || a live fm row
  setRatio(cents1, cents2)      # k, ramped
  setFrequency(hz, when, glide) # f_note, every note
  setRing(level)                # knob; engages/disengages itself
Voice:
  fmTarget: AudioParam
  setOscOctave(osc, o) / setOscTune(osc, cents)   # the Osc write, then k
  setFm(beta) / setFmInUse(on) / setRing(level)
SyncOscNode:
  fm: AudioParam                # a-rate, β
ModMatrix:
  usesDest(dst): boolean        # any live row on this destination
```

### Layer touchpoints & ordering

```yaml
registry: src/state/params.ts -> osc1.fm, osc1.ring
routing:  src/state/mod-routing.ts -> MOD_DEST_LABELS += fm, MOD_DEST_SCALE[fm] = 8
engine:   osc1.fm -> all(v.setFm), refreshFm()
          mod.N.src / mod.N.dst -> refreshFm()     # in use = fm > 0 || modMatrix.usesDest(fm)
          osc1.ring -> all(v.setRing)
          osc{1,2}.octave/detune -> v.setOscOctave / v.setOscTune
graph (per voice):
  fmMod(ConstantSource, offset = β) -> fmAmt.gain (base 0)   ; matrix fm routes -> fmMod.offset
  osc1.signal -> fmAmt -> fmHz -> osc2.frequencyParam        # first and last edge only while FM is in use
  hzSrc(ConstantSource, FrequencyLine) -> kGain(k) -> fmHz.gain (base 0)   # hzSrc -> kGain likewise
  fmMod -> pair.fm                                           # at attachSync
  osc1.signal -> ringVCA.gain (base 0) ; osc2.signal -> ringVCA -> ringHP(20 Hz) -> ringLevel -> mix
                                                             # the two input edges only while ring is engaged
ui: OSC 1 — FM + RING knobs behind the row break
```

`fmMod` is a `ConstantSourceNode`, so every modulation target stays an
`AudioParam`, as with sync's junctions. `fmAmt` and `fmHz` are two separate
multipliers: β (with routes, in index units) times `f_note · k` (Hz). A route
then reads in index units whatever the oscillators' tuning.

## Scenarios (BDD)

```gherkin
Scenario: Cross-mod off is the native path (REQ-cross-mod-off-is-the-native-path)
  Given a voice with osc1.fm and osc1.ring at 0
  Then nothing is connected to osc2's frequency and the ring VCA has no input
# pinned by: tests/audio/cross-mod.test.ts, tests/state/params.test.ts

Scenario: The taps carry the sounding oscillator (REQ-oscillator-signals-are-tapped-pre-level)
  Given a voice with its sync pair attached
  When sync is engaged
  Then the pair's outputs connect to osc1.signal and osc2.signal, not to the outs
# pinned by: tests/audio/voice-sync.test.ts

Scenario: FM depth follows the modulator (REQ-fm-index-is-relative-to-the-modulator)
  Given FM is in use
  When osc1 is an octave above osc2
  Then the ratio gain is 2
  And each note sets the note-frequency source through the glide line
# pinned by: tests/audio/cross-mod.test.ts

Scenario: FM engages and disengages (REQ-cross-mod-disconnects-when-unused)
  When FM goes in use the chain connects to osc2's frequency
  And when it goes out of use it is disconnected only after the delay
  And going back in use inside the delay cancels the cut
# pinned by: tests/audio/cross-mod.test.ts

Scenario: A matrix route alone engages FM (REQ-fm-is-a-modulation-destination)
  Given osc1.fm is 0
  When mod row 0 routes filter env to fm
  Then each voice's fm junction receives the route at 8 x the amount
  And FM is in use
  And the FM knob's reach is 8 x the amount
# pinned by: tests/audio/mod-matrix.test.ts, tests/audio/engine-sync.test.ts, tests/state/mod-depth.test.ts

Scenario: FM reaches the sync pair (REQ-fm-reaches-the-sync-pair)
  Given a voice with its pair attached
  Then the fm junction is connected to the pair's fm param
# pinned by: tests/audio/voice-sync.test.ts

Scenario: FM at 0 leaves the pair unchanged (REQ-fm-reaches-the-sync-pair)
  Given the pair in hard mode
  Then rendering with fm = 0 matches rendering without the param
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: FM under hard sync stays periodic and band-limited (REQ-fm-reaches-the-sync-pair)
  Given a saw slave hard-synced with fm = 2 at a half-integer master period
  Then the slave repeats with the master's period
  And energy between the harmonics stays well below the harmonics
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: The pair stays bounded under any fm (REQ-cross-mod-is-bounded, edge)
  Given NaN, Infinity and ±1000 on fm
  Then every output sample is finite and within ±2 (hard sync, saw: well inside the
  pair's ±4 bound, oscillator-sync.md REQ-the-pair-is-bounded)
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: Ring is its own level, DC-blocked (REQ-ring-is-its-own-level, REQ-ring-is-dc-free)
  When osc1.ring rises above 0
  Then osc1.signal drives the ring VCA's gain and osc2.signal its input
  And the ring path runs through a 20 Hz highpass into the mix
  When it returns to 0 the inputs are disconnected after the delay
# pinned by: tests/audio/cross-mod.test.ts

Scenario: OSC 1 carries the modulator controls (REQ-the-modulator-controls-live-on-osc-1)
  Then the OSC 1 panel shows knob-osc1.fm and knob-osc1.ring
  And they sit on a second line until 3200px, where OSC 1 goes to one row
# pinned by: e2e/controls.spec.ts, e2e/responsive-panels.spec.ts
```

## Tests & verification

- Unit: `tests/audio/cross-mod.test.ts`, `tests/audio/voice-sync.test.ts`,
  `tests/audio/sync-osc-worklet.test.ts`, `tests/audio/mod-matrix.test.ts`,
  `tests/audio/engine-sync.test.ts`, `tests/state/mod-depth.test.ts` — `npm test`.
- E2E: `e2e/controls.spec.ts`, `e2e/responsive-panels.spec.ts` — `npm run e2e`.
- **FM inside the pair, aliasing** (Node, 48 kHz, sine master, saw slave hard-synced
  at ×1.5, energy between the harmonics below 10 kHz). FM + hard sync is still
  exactly periodic at the master's period, so the oscillator-sync alias metric applies:

  | master | β 0 | β 1 | β 3 | β 6 | naive, β 1–6 |
  | --- | --- | --- | --- | --- | --- |
  | 130 Hz | −64 dB | −59 | −62 | −65 | −28…−25 |
  | 744 Hz | −70 | −61 | −57 | −52 | −21…−17 |
  | 2.9 kHz | −79 | −44 | −35 | −34 | −15…−11 |

  The first two rows are pinned at −50 dB. At a 2.9 kHz master the slave's
  increment swings across the kernel's 16-sample width and clamps at 0 Hz, so the
  residuals' locally-constant-increment assumption fails. That is accepted under
  ADR-010, as the sine slave's top end is (oscillator-sync.md → Tests & verification).
- **Native FM on both engines** (OfflineAudioContext in Playwright's Chromium and
  Firefox, 2026-10-28). Both apply `detune` to an audio-rate `frequency` input
  exactly as the spec says: `(110 Hz, +1200 ¢, dev D)` renders identically to
  `(220 Hz, 0 ¢, dev 2D)`. That is the property REQ-fm-index-is-relative-to-the-modulator
  stands on. Both also run **through zero** with the signed frequency: a 50 Hz
  carrier at 300 Hz deviation matches a signed-phase reference to 1e-4 (Blink) and
  0.01 (Gecko), against 2.0 for an `|f|` model.
- **Rendered through the real graph** (`npm run bench:audio`, A2, sine/sine,
  filter open, Chromium and Firefox):
  - The takes cover FM β 1, 3 (ratio 1:2) and 6 (through zero), ring of sines
    and of saws, and FM with sync on and off. None shows non-finite output or
    bursts above its no-FM baseline.
  - With OSC 1 muted, FM β 3 at 1:2 measures 0.0122 rms on Blink and 0.0137 on
    Gecko. Layered with OSC 1 the gap is larger (0.0176 vs 0.0309), because the
    FM sideband at OSC 1's own pitch adds to it or cancels it depending on the
    two oscillators' relative phase. That is layering, not FM depth.
  - `RING_MAKEUP` = √2. Ring 70% of sine×sine measures 0.0225 rms against one
    sine at LEVEL 70% at 0.0221, on both engines. Saw×saw lands 3.7–4.7 dB under
    a saw (0.0098 vs 0.0149 on Blink, 0.0087 vs 0.0150 on Gecko).
  - One Chromium ring-saw take closed the page mid-capture. It did not reproduce
    in two re-runs.
  - These are measurements, not a listening verdict.
- **By ear** (ADR-010) is still owed. A/B against cross-mod off on both engines:
  - FM sine→sine at β 1/3/6 and filter env → `fm`
  - FM with sync on and off
  - ring at non-integer ratios, including whether saw×saw wants more than √2

## Open questions / future

- Through-zero FM inside the sync pair: the slave would run backwards on a
  negative increment, which needs a reversed hard reset.
- FM from the sub-oscillator, or OSC 2 → OSC 1 (feedback-style) FM.
- An `fm` entry in `LFO_DEST_LABELS`, if routing the LFO through the matrix
  proves clumsy.
