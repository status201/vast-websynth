# Recipe — verify a change by ear (render, listen, measure)

```yaml
id: verify-audio-by-ear
status: implemented
version: 2  # v2: the mono-down-mix gotcha — per-channel checks miss stereo
            #     decorrelation, and pure tones do not reproduce it
owner: core
related:
  - architecture
  - ../features/audio-export       # the capture path this reuses
  - ../features/effects            # the usual subject: an insert on a bus
  - ../features/time-stretch        # the mono-down-mix gotcha came from here
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
honest. `--demo` takes are **bar-exact and repeatable**: they call `exportSong`,
which by default renders exactly one pass of the longest enabled chain and
auto-stops. `--note` takes are a fixed wall-clock duration (the manual capture
verbs), so compare them by character rather than sample-for-sample.

`--runs` and `--tail-bar` expose the two export options
([audio-export](../features/audio-export.md) REQ-2/REQ-3), and both default
**off** precisely so a plain take stays bar-exact and comparable with every take
rendered before they existed. Reach for `--tail-bar` when the thing you are
judging is a *decay* — the default 350 ms grace cuts a long reverb mid-tail, and
you would be listening to the cut rather than the effect.

```bash
# hold a note (isolates one voice + the FX chain)
npm run bench:audio -- --name before --note A2 --seconds 6 --set fx.reverb.on=0
npm run bench:audio -- --name after  --note A2 --seconds 6 --set fx.reverb.on=1

# a full song pass, other lanes muted so the one under test isn't buried
npm run bench:audio -- --name solo --demo "Night Rider" --set drum.mute=1 --set sampler.mute=1
```

| flag | meaning |
| --- | --- |
| `--name <id>` | output basename → `bench/<id>.wav` (**required**) |
| `--note <spec>` | notes to hold: `A2`, `C#3`, a MIDI number, or a comma-separated chord (default `A2`) |
| `--seconds <n>` | take length in note mode (default 6) |
| `--velocity <0..1>` | note velocity in note mode (default 0.9) — anything velocity-sensitive needs it, since e.g. `filter.velAmount` only differs *between* velocities |
| `--project <path>` | import a `.websynth.zip` and render a song pass — the only way to hear a whole sampler arrangement |
| `--sample <path>` | load one WAV/MP3 into a slot and trigger it by hand, transport stopped |
| `--slot <n>` | which slot `--sample` fills (default 0) |
| `--hits <n>` / `--gap <s>` | how many times `--sample` triggers it, and how far apart (default 4, 1 s) |
| `--demo <name>` | load a demo song and render one full pass instead |
| `--runs <n>` | passes to render in `--demo` mode, 1..10 (default 1) |
| `--tail-bar` | hold the capture open a whole bar after the last step so tails decay (default off — a plain take stays bar-exact) |
| `--stagger <s>` | release the held notes one at a time, oldest first, `s` apart (default 0 = the whole chord drops at once) |
| `--set id=value` | a `ParamBus` write applied before the take — repeatable |
| `--url <url>` | drive an already-running server instead of spawning vite |
| `--format wav\|mp3` | capture format (default `wav`; metrics need `wav`) |
| `--headed` | show the browser, for debugging |

**Hearing the sampler needs `--project` or `--sample`, and they answer different
questions.** A *song* stores only its slots' filenames ([sampler](../features/sampler.md)
REQ-4), so a plain `--demo` of a `.json` demo renders a silent sampler lane. A
**project zip** carries the audio ([project-export](../features/project-export.md)),
and shipped zip demos exist — so `--project <file.websynth.zip>` renders the whole
arrangement with its slots filled, which answers *does the song sound right?*
`--sample` loads one clip and triggers it with the transport **stopped**, which
answers *is `play()` right?* — it separates a per-hit bug from a scheduling one in
a single take, and is how the sampler's own defects have actually been cornered.

To check a lane is contributing at all, **solo it** rather than muting it and
watching the total: the master compressor takes up the slack when a lane is
removed, so the summed RMS barely moves even when the lane is plainly audible on
its own.

**Anything about voice allocation needs `--stagger`.** A chord released all at once
sounds identical whether or not stealing is book-kept correctly — the difference only
appears when one key is let go while the others are still down. Hold more notes than
the eight voices and release them oldest-first:

```
npm run bench:audio -- --name steal --note 60,62,64,65,67,69,71,72,74 \
  --seconds 10 --stagger 0.7 --set amp.release=0.9
```

The early keys have already lost their voices to the late ones, so each release is a
test of which note stops (`voicing.md` REQ-9). Render the same command against the
commit before the change and compare: the regression sounds like letting go of one
key and hearing a *different* note cut out.

Output lands in `bench/` (gitignored), and the metrics summary prints straight
away so a take is never just an opaque file.

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
- **`audio-metrics` measures the MONO down-mix — so it sees stereo damage that a
  per-channel check cannot.** Any process that decides something *per channel*
  can drift the two apart, and two channels that have drifted cancel when summed.
  [time-stretch](../features/time-stretch.md) REQ-5 hit exactly this: each channel
  on its own measured −0.2 dB while the take measured **−5.7 dB**, because the
  phase vocoder was integrating each channel's phase separately. If the numbers
  here disagree with a per-channel unit test, the down-mix is usually right and
  the stereo image is the thing that broke. The matching trap in the unit test:
  **pure tones do not reproduce it** — both channels then carry the same phase in
  every bin, so per-channel processing happens to agree. Reach for broadband
  material with an independent per-channel component, and confirm the test fails
  against the bug before trusting it.
- **A browser is part of the graph.** `--browser firefox` renders the same take
  through Gecko instead of Blink. The two disagree on `AudioParam` automation in
  ways that are audible and that no unit test can reach: the mock `AudioParam`
  has a static `value` and no event list, so *no* behavioural test can observe
  cancel-then-ramp semantics at all. The DJ filter crackled on Firefox alone for
  two releases because of it — a `cancelScheduledValues` that pinned nothing,
  which Blink continues from and Gecko restarts from the constructed value
  ([performance](../features/performance.md) REQ-10). Render both when a change
  touches automation:

  ```bash
  npm run bench:audio -- --demo <a song that automates it> --name dj --browser chromium
  npm run bench:audio -- --demo <a song that automates it> --name dj --browser firefox
  # -> bench/dj.wav and bench/dj.firefox.wav
  ```

  Two deltas matter, not one: **firefox vs chromium** exposes the engine
  disagreement, and **after vs before** on *each* engine proves the fix did not
  quietly flatten the sound to get there. Needs the browser installed once:
  `npx playwright install firefox`. `tests/audio/no-unanchored-cancel.test.ts`
  is the standing guard for the specific defect; the render is how you find the
  next one.
- **A take that measures clean can still sound bad.** These metrics catch
  discontinuities and generated energy, not musicality — a process can be
  mathematically smooth and still be something nobody wants to play. That
  judgement is the listener's, which is why step 2 is not optional.
- Takes are **real time** — a 16-bar song is ~16 s. That is the cost of
  measuring the real graph, and it is worth it.
- **A later `npm ci` failing with `EPERM … unlink … rolldown-binding…node` means
  a Vite process is still holding `node_modules`.** The bench's server is killed
  on every exit path now, but a dev server or a hung Playwright run does the same
  thing — Windows locks a loaded native module for the lifetime of the process
  that loaded it, and the error names no culprit. Find it and kill it:
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select ProcessId, CommandLine`.

## Scenarios (BDD)

```gherkin
Scenario: A change that measures clean is still heard before it ships
  Given a DSP or routing change that alters the instrument's sound
  When a take is rendered through the real graph alongside a bypassed baseline
  Then the two are compared by ear, and the metrics only guard the regression
# pinned by: scripts/audio-bench.mjs, scripts/audio-metrics.mjs (manual loop)

Scenario: A discontinuity is caught as a rate, not a maximum
  Given an effect that steps a gain or splices at a cycle boundary
  When its take is measured against the same material rendered bypassed
  Then its discontinuity-burst rate stands far above that baseline
# pinned by: the delta between two `npm run bench:audio` takes
```

## Tests & verification

- `npm run bench:audio` / `npm run bench:metrics` — the loop itself. Manual by
  design, because the acceptance test is a person listening.
- Whatever regression a take exposes gets pinned in `tests/audio/` on synthetic
  material, so CI keeps it fixed.
- `npm run typecheck` is unaffected — `scripts/**` is outside `tsconfig`'s
  include, and both scripts are plain ESM with no build step.
