# Recipe — verify a change by ear (render, listen, measure)

```yaml
id: verify-audio-by-ear
status: implemented
version: 1
owner: core
related:
  - architecture
  - ../features/audio-export       # the capture path this reuses
  - ../features/effects            # the usual subject: an insert on a bus
  - ../decisions/adr-010-musical-stable-cheap-dsp
source:
  - scripts/audio-bench.mjs        # renders a take through the real graph
  - scripts/audio-metrics.mjs      # pure measurement + --compare
```

A repeatable **playbook**, not a feature. Unit tests can prove a DSP change is
bounded, finite and cheap while saying nothing at all about whether it sounds
like anything — so any change to how the instrument *sounds* is verified by
rendering a take through the real graph and listening to it.

## Background / Why

[ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md) ranks DSP work
**musical, stable, cheap — in that order**. The test suite covers the second and
third: boundedness, no NaN, no per-frame allocation, correct wiring. Nothing in
it covers the first.

This exists because an effect once shipped having passed every unit test and e2e
spec it had, and measured clean against every *synthetic* input tried — periodic,
detuned, chordal, melodic, noisy — while the shipped result sounded broken. The
gap was everything *around* the DSP kernel: the voice pool, the filter, the FX
chain, the control-signal feeds, the bypass wrapper. Two real defects were
invisible to the unit tests and obvious within one rendered take.

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
npm run bench:audio -- --name before --note A2 --seconds 6 --set fx.reverb.on=0
npm run bench:audio -- --name after  --note A2 --seconds 6 --set fx.reverb.on=1

# a full song pass, other lanes muted so the one under test isn't buried
npm run bench:audio -- --name solo --demo "Night Rider" --set drum.mute=1 --set sampler.mute=1
```

`--set id=value` writes any `ParamBus` id before the take; `--demo` loads a demo
song; `--note` holds one or more notes (`A2`, `C#3`, or a MIDI number, comma
separated); `--url` reuses an already-running dev server instead of spawning one.
Output lands in `bench/` (gitignored).

### 2. Listen

The point of the exercise. Hand the path over rather than describing the sound.

### 3. Measure — `npm run bench:metrics`

```bash
npm run bench:metrics -- --compare bench/before.wav bench/after.wav
npm run bench:metrics -- bench/after.wav --f0 220 --above 1760 --spectrum
```

- **bursts** — runs of consecutive samples whose step dwarfs the local norm.
  Splice/discontinuity artefacts appear as *short runs at a high rate*; this is
  the metric that separated a working alternate-cycle gain from one that stepped
  at every splice (3/s vs 123/s on the same material).
- **energy above band** — drive the graph with material of a known harmonic
  ceiling; anything above it was generated (aliasing, or steps).
- **harmonic-comb dominance** — detects diffuse material being forced onto a
  pitch, the classic failure of any cycle- or grain-based process.

### 4. Pin it

Turn whatever the render exposed into a unit test on synthetic material, so it
cannot come back silently. The render finds it; the unit test keeps it found.

## Gotchas

- **Always render a bypassed baseline on the same material.** A demo song with
  drums measures ~1300 discontinuity bursts/s *with the effect under test
  switched off* — those are drum transients, and read as damning evidence if
  taken at face value. Every number here is only meaningful as a delta.
- **Mute the lanes you are not testing.** An insert on the synth chain is
  inaudible in the mix next to drums; `--set drum.mute=1 --set sampler.mute=1`
  is usually the difference between a useless take and a clear one.
- **Synthetic probes can exonerate wrongly, and condemn wrongly.** A pure-tone
  probe once rated a control the worst in its module; on real material it was
  indistinguishable from bypassed. Trust the rendered take over the bench-of-one.
- **A take that measures clean can still sound bad.** These metrics catch
  discontinuities and generated energy, not musicality — a process can be
  mathematically smooth and still be something nobody wants to play. That
  judgement is the listener's, which is why step 2 is not optional.
- Takes are **real time** — a 16-bar song is ~16 s. That is the cost of
  measuring the real graph, and it is worth it.

## Tests & verification

- `npm run bench:audio` / `npm run bench:metrics` — the loop itself. Manual by
  design, because the acceptance test is a person listening.
- Whatever regression a take exposes gets pinned in `tests/audio/` on synthetic
  material, so CI keeps it fixed.
