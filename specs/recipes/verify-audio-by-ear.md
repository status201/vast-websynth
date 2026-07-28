# Recipe — verify a change by ear (render, listen, measure)

```yaml
id: verify-audio-by-ear
status: implemented
version: 1
owner: core
related:
  - architecture
  - ../features/zoetrope           # the worked instance: two defects found only this way
  - ../features/audio-export       # the capture path this reuses
  - ../decisions/adr-010-musical-stable-cheap-dsp
source:
  - scripts/audio-bench.mjs        # renders a take through the real graph
  - scripts/audio-metrics.mjs      # pure measurement + --compare
```

A repeatable **playbook**, not a feature. Unit tests can prove a DSP change is
bounded, finite and cheap while saying nothing at all about whether it sounds
like anything — so any change to how the instrument *sounds* is verified by
rendering a take through the real graph and listening to it. The worked instance
is [zoetrope](../features/zoetrope.md).

## Background / Why

[ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md) ranks DSP work
**musical, stable, cheap — in that order**. The test suite covers the second and
third: boundedness, no NaN, no per-frame allocation, correct wiring. Nothing in
it covers the first.

Zoetrope shipped that way. Its worklet passed thirteen unit tests and ten e2e
specs, and measured clean against every synthetic input tried — periodic,
detuned, chordal, melodic, noisy — while the shipped effect sounded broken. The
gap was everything *around* the worklet: the voice pool, the filter, the FX
chain, the pitch-signal feed, the bypass wrapper. Two real defects (`sub`
stepping its gain at a splice; the zero-crossing detector chasing partials) were
invisible to unit tests and obvious within one rendered take.

The rule that follows: **a change that alters what the instrument sounds like is
not verified until someone has heard it.** Metrics are the regression guard, not
the acceptance test.

## Steps

### 1. Render a baseline and a candidate — `npm run bench:audio`

Capture goes through the app's own `RecorderController`, so a take is the same
file the Export button produces — there is no second recording path to keep
honest. Takes are deterministic: `exportSong` renders exactly one pass of the
longest enabled chain.

```bash
# hold a note (isolates one voice + the FX chain)
npm run bench:audio -- --name before --note A2 --seconds 6 --set fx.zoetrope.on=0
npm run bench:audio -- --name after  --note A2 --seconds 6 --set fx.zoetrope.on=1

# a full song pass, drums muted so the lane under test isn't buried
npm run bench:audio -- --name solo --demo "Night Rider" --set drum.mute=1 --set sampler.mute=1
```

`--set id=value` writes any `ParamBus` id before the take; `--demo` loads a demo
song; `--url` reuses an already-running dev server instead of spawning one.
Output lands in `bench/` (gitignored).

### 2. Listen

The point of the exercise. Hand the path over rather than describing the sound.

### 3. Measure — `npm run bench:metrics`

```bash
npm run bench:metrics -- --compare bench/before.wav bench/after.wav
npm run bench:metrics -- bench/after.wav --f0 220 --above 1760 --spectrum
```

- **bursts** — runs of consecutive samples whose step dwarfs the local norm.
  Splice/discontinuity artefacts appear as *short runs at a high rate*. This is
  the metric that separated a working `sub` from a broken one (3/s vs 123/s).
- **energy above band** — drive the graph with material of a known harmonic
  ceiling; anything above it was generated (aliasing, or steps).
- **harmonic-comb dominance** — detects diffuse material being forced onto a
  pitch, the "buzzy robot" failure of cycle splicing.

### 4. Pin it

Turn whatever the render exposed into a unit test on synthetic material, so it
cannot come back silently — see the `splice continuity (bench regressions)`
block in `tests/audio/zoetrope-worklet.test.ts`.

## Gotchas

- **Always render a bypassed baseline on the same material.** A demo song with
  drums measures ~1300 discontinuity bursts/s *with the effect switched off* —
  those are drum transients, and read as an artefact if taken at face value.
  Every number here is only meaningful as a delta.
- **Mute the lanes you are not testing.** An insert on the synth chain is
  inaudible in the mix next to drums; `--set drum.mute=1 --set sampler.mute=1`
  is usually the difference between a useless take and a clear one.
- **Synthetic probes can exonerate wrongly.** A pure-tone probe rated `sieve` the
  worst control in the module; on real material it was indistinguishable from
  bypassed. Trust the rendered take over the bench-of-one.
- Takes are **real time** — a 16-bar song is ~16 s. That is the cost of
  measuring the real graph, and it is worth it.

## Scenarios (BDD)

```gherkin
Scenario: A splice discontinuity is caught before it ships
  Given a DSP change that steps a gain at a cycle boundary
  When a take is rendered through the real graph and measured
  Then its discontinuity-burst rate is far above the bypassed baseline
  And the defect is reproducible as a unit test on synthetic material
# pinned by: tests/audio/zoetrope-worklet.test.ts
```

## Tests & verification

- `tests/audio/zoetrope-worklet.test.ts` — the regressions this loop found,
  pinned on synthetic material so they run in CI.
- `npm run bench:audio` / `npm run bench:metrics` — the loop itself; manual by
  design, because the acceptance test is a person listening.
