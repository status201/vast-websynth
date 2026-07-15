# Performance mode

```yaml
id: performance-mode
status: implemented
version: 5
owner: core
related:
  - architecture
  - voicing
  - effects
source:
  - src/state/perf-mode.ts
  - src/audio/engine.ts
  - src/main.ts
  - src/ui/components/scope.ts
  - src/ui/components/perf-settings.ts
  - src/ui/components/about.ts
  - src/ui/app.ts
```

A device-scoped audio-quality setting with **three tiers** (**weak / medium /
strong**, plus **Auto** to pick one by device) that scales latency, polyphony, and
visual fidelity to the machine the app is running on. Distinct from
[`performance.md`](performance.md) (the live DJ-FX module) — same word, unrelated
feature.

## Background / Why

The synth is fixed-cost: 8 voices each run a per-sample ladder-filter worklet, the FX
chains process even when "off" (the `BypassWrapper` gains down rather than
disconnects), and the `AudioContext` defaults to `latencyHint: 'interactive'` (the
smallest, most glitch-prone buffer). On weak hardware this overruns the audio thread
— crackle, distortion, white noise.

The original feature (v1) was a **2-state** toggle: perf "active" (buffer
`'playback'`, 5 voices, ~30 fps scope, no drop-shadow) or not. Its auto-detect flagged
**any** mobile/tablet UA as weak, so capable tablets were forced into the big-buffer
profile and suffered needless latency. v2 replaces the boolean with three tiers so a
capable-but-not-top device keeps low latency while only genuinely weak devices pay for
stability, and the scope cost scales (15 / 30 / 60 fps). It remains a runtime/device
preference, **not** a sound parameter — stored outside the `ParamBus`, never in a
preset or song.

v3 (the mobile-crackle work, with the worker clock / idle gating / ADR-012 true
bypass) teaches the weak tier to reach the remaining **fixed FX costs**: reverb
IR length, WaveShaper oversampling, and the transport look-ahead horizon. All
three are boot-time fields, and only **weak** deviates — medium and strong keep
sharing one audio profile, so the v2 "Medium↔Strong needs no reload" UX holds.

v4/v5 scale `analyserFftSize` per tier. The three scope analysers (mono + L/R,
[scope](scope.md)) sit permanently in the pulled master path and each runs an FFT
at `fftSize`; their per-draw `getByte*Data` copies also scale with it. The tiers
run **512 / 1024 / 2048** (weak / medium / strong) — weak still keeps enough
time-domain samples for a full bass cycle and enough spectrum bins for the bar
view, cutting the always-on analyser + copy cost. Unlike a buffer/voice change,
`AnalyserNode.fftSize` is settable at runtime, so `analyserFftSize` is applied
**live** (like scope `fps`, v5): changing tiers reallocates the scope's read
buffers immediately, no reload. It is therefore **not** part of the audio profile
(`sameAudioProfile`), so medium and strong still share one audio profile (they
differ only by live-applied scope fps + fftSize).

## Requirements

- **REQ-1** — A preference `auto | weak | medium | strong`, persisted under
  `localStorage['websynth.perf']` (default `auto`). It is **not** a `ParamBus` param
  and is never captured by presets/songs. Legacy values migrate on read: `on → weak`,
  `off → strong`, anything unrecognised → `auto`.
- **REQ-2** — `PERF_PROFILES: Record<PerfTier, PerfProfile>` is the single source of
  truth for every tier-dependent knob (v3 added three FX-cost fields; v4 added
  `analyserFftSize`):
  `weak = { latencyHint:'playback', voiceCount:5, fps:15, scheduleAheadS:0.2, reverbIrMaxS:1.5, fxOversample:false, analyserFftSize:512 }`,
  `medium = { 'interactive', 8, 30, 0.1, 4, true, 1024 }`,
  `strong = { 'interactive', 8, 60, 0.1, 4, true, 2048 }`.
  Strong and medium share the same **audio** profile; they differ only by the
  live-applied scope fps + analyser fftSize.
- **REQ-3** — `detectTier()` errs toward **medium** (the safe, normal-latency default).
  Weak only on a genuinely low signal: `hardwareConcurrency <= 2`, **or**
  `deviceMemory <= 2`, **or** a phone UA (`/Mobi|Android|iPhone|iPod/`, **not** `iPad`)
  with `cores <= 4` or `mem <= 4`. Strong only when clearly high-end and not a phone:
  `!mobile && cores >= 8 && (mem === undefined || mem >= 8)`. Everything else is medium.
  Detection is a hint (`deviceMemory` is Chrome-only, cores can be capped) — the user
  override is the real escape hatch.
- **REQ-4** — `resolveTier(pref)` returns the effective tier: a concrete tier passes
  through; `auto` → `detectTier()`. `sameAudioProfile(a, b)` is true iff two tiers share
  **every boot-time field**: `latencyHint`, `voiceCount`, `scheduleAheadS`,
  `reverbIrMaxS`, `fxOversample` (v3). `fps` and `analyserFftSize` are **excluded** —
  they are applied live, not at boot, so they never force a reload.
- **REQ-5** — The **audio** profile (buffer, voice count, and the v3 FX-cost fields)
  is tuned **at boot** only (chosen when the `AudioContext`/graph are built): boot
  reads `PERF_PROFILES[resolveTier()]` and passes all boot-time fields to the Engine.
  Changing the tier across an audio boundary therefore takes full effect only after a
  reload.
- **REQ-11** — (v3) Weak-tier FX-cost reductions, threaded via `EngineOptions`:
  - `scheduleAheadS` widens the transport look-ahead horizon
    ([transport](transport.md)): weak 0.2 s absorbs slow wakeups on throttled
    devices; the trade-off is coarser quantisation of live BPM/swing edits and
    Tape Stop ramps.
  - `reverbIrMaxS` caps the reverb IR bank by **capping durations, not
    shrinking the bank**: weak renders `[0.4, 0.8, 1.5, 1.5, 1.5]` s so
    `setSize`'s 0..1→index mapping and every preset value stay valid —
    big-room presets simply sound tighter on weak.
  - `fxOversample: false` builds the synth/sampler distortion WaveShapers at
    `'none'` instead of `'4x'`, and pins the 8 drum-track shapers to `'none'`.
  - **Universal (all tiers):** a drum-track shaper runs `oversample = 'none'`
    while its curve is the identity (drive 0, the default) and only steps up to
    `'2x'` when drive > 0 — oversampling an identity curve is pure waste.
  Presets/songs are untouched by construction: none of these are `ParamBus`
  params, and every param's range/default is unchanged.
- **REQ-12** — (v4/v5) `analyserFftSize` sets the `fftSize` of all three scope
  analysers (mono `analyser` + `analyserL`/`analyserR`). Tiers run **512 / 1024 /
  2048** (weak / medium / strong; 2048 is the `EngineOptions` default when the
  field is absent). Boot seeds the analysers with the resolved tier's value
  (threaded via `EngineOptions`); thereafter it is applied **live** (v5) via
  `Scope.setFftSize(n)`, which sets `analyser.fftSize` on all three and reallocates
  each channel's time-domain + frequency read buffers to match ([scope](scope.md)
  REQ-2). Because it applies live, it is **not** a boot-time field and is
  **excluded** from `sameAudioProfile` (so Medium↔Strong needs no reload).
- **REQ-6** — Scope **fps** and **analyserFftSize** are applied **live**: `Scope`
  takes `{ fps }` and exposes `setFps(fps)` + `setFftSize(n)`. Changing tiers updates
  the scope frame rate and FFT size immediately (no reload). fps throttling is
  timestamp-based (`now - lastDrawTs >= 1000/fps`; `fps >= 60` means draw every
  frame), correct on high-refresh displays. The scope always pauses its redraw loop
  while the tab is hidden (`visibilitychange`). Note: the
  [motion sequencer](motion-sequencer.md)'s write loop also throttles to the
  profile `fps`, but it reads it **once at boot** (`EngineOptions.motionFps`) —
  a tier change updates it on reload only (accepted: it is a cost cap, not a
  visual).
- **REQ-7** — The canvas **drop-shadow is removed for all tiers** (it was the v1
  perf-only "lightening"; now a baseline cost cut everywhere). Wave and Spectrum draw
  with no `shadowBlur`/`shadowColor`.
- **REQ-8** — A header "Perf" button opens a modal with an **Auto / Weak / Medium /
  Strong** control; changing it persists immediately, applies fps live, and shows a
  "reload to apply" hint + button only when the new choice crosses an **audio**
  boundary (`!sameAudioProfile(resolveTier(pref), bootTier)`) — so Medium↔Strong never
  asks for a reload. A status line states the resolved tier on this device. The button
  itself carries an at-a-glance **tier colour** (`data-perf-tier`): **weak = red**,
  **medium = amber**, **strong = green** (shown even under Auto, reflecting the resolved
  tier), and **pulses** (`data-perf-pending`, respecting `prefers-reduced-motion`) while
  a chosen tier is pending a reload.
- **REQ-9** — The About → Debug panel surfaces device diagnostics from a single
  `perfDiagnostics()` helper (so it never re-reads `navigator` itself): the resolved
  Perf tier (with `(auto)`/`(forced)` suffix; testid `debug-perf-tier`), CPU cores,
  device memory (`unknown` when unavailable), mobile-UA flag, and the active audio
  profile — since v3 including the FX-cost fields:
  `latencyHint · voices · fps · lookahead <ms>ms · IR ≤<s>s · oversample on|off`.
- **REQ-10** — No-op for capable devices on default `auto`: a strong/medium device
  builds the engine with `latencyHint: 'interactive'` and 8 voices, exactly as before.

## Technical design

### Contract / public interface

```yaml
# src/state/perf-mode.ts
PerfTier: 'weak' | 'medium' | 'strong'
PerfPref: 'auto' | PerfTier
PerfProfile: { latencyHint: AudioContextLatencyCategory; voiceCount: number; fps: number;
               scheduleAheadS: number; reverbIrMaxS: number; fxOversample: boolean;  # v3
               analyserFftSize: number }                                             # v4 (applied live, v5)
PERF_PROFILES: Record<PerfTier, PerfProfile>   # single source of truth
readPerfPref(): PerfPref                        # validates + migrates legacy on/off
writePerfPref(pref: PerfPref): void
detectTier(): PerfTier
resolveTier(pref?: PerfPref): PerfTier          # pref defaults to readPerfPref()
sameAudioProfile(a: PerfTier, b: PerfTier): boolean
PerfDiagnostics: { cores; memoryGb; mobile; pref; detected; tier; profile }
perfDiagnostics(): PerfDiagnostics

# src/audio/engine.ts
EngineOptions: { latencyHint?; voiceCount?; scheduleAheadS?; reverbIrMaxS?; fxOversample?; analyserFftSize? }
new Engine(bus, opts?: EngineOptions)
  # latencyHint→AudioContext, voiceCount→pool, scheduleAheadS→Clock,
  # reverbIrMaxS→the 3 Reverbs, fxOversample→the 2 Distortions + DrumMachine (v3),
  # analyserFftSize→initial fftSize of the 3 scope analysers (default 2048) (v4)

# src/ui/components/scope.ts
new Scope(analysers, opts?: { fps?: number })   # default 60
scope.setFps(fps: number): void                 # live frame-rate change
scope.setFftSize(fftSize: number): void         # live analyser fftSize change (reallocates read buffers) (v5)

# src/ui/components/perf-settings.ts  (styles: ui/styles/perf-settings.module.css)
createPerfSettingsButton(opts?: { onTierPreview?: (t: PerfTier) => void }): HTMLButtonElement
  # modal testids: perf-mode[-auto|weak|medium|strong], perf-status,
  # perf-reload-hint, perf-reload; button: data-perf-tier, data-perf-pref, data-perf-pending

# src/ui/components/about.ts
buildDebugSection(...)                           # adds debug-perf-tier + cores/mem/mobile/profile rows
```

### Layer touchpoints & ordering

```yaml
boot (main.ts):
  profile = PERF_PROFILES[resolveTier()]
  new Engine(bus, profile-fields)                # read once — all boot-time knobs fixed thereafter
engine: opts.latencyHint -> new AudioContext({ latencyHint }); opts.voiceCount -> init() voice loop;
  opts.scheduleAheadS -> new Clock(ctx, { scheduleAheadS }); opts.reverbIrMaxS -> new Reverb(ctx, { maxIrS });
  opts.fxOversample -> new Distortion(ctx, { oversample }) + DrumMachine's per-track shapers;
  opts.analyserFftSize -> initial analyser.fftSize on analyser / analyserL / analyserR (v4)
ui (app.ts):
  buildHeader mounts createPerfSettingsButton({ onTierPreview: t -> previewScopeTier(t) }), which
    applies BOTH live scope knobs: setScopeFps(PERF_PROFILES[t].fps) + setScopeFft(PERF_PROFILES[t].analyserFftSize)
  buildBottom builds Scope({ fps: PERF_PROFILES[resolveTier()].fps }) and returns it; mountApp
    binds the late `setScopeFps`/`setScopeFft` hooks to scope.setFps/scope.setFftSize (same pattern as fxExpand)
scope: visibilitychange pause (always) + timestamp fps throttle + setFps (live); no drop-shadow
about: Debug rows from perfDiagnostics()
```

### Persistence

`localStorage['websynth.perf']` = `auto | weak | medium | strong` (default `auto`;
legacy `on`/`off` migrate on read). **Deliberately not persisted into presets or
songs** — it describes the device, not the sound. Same `websynth.*` + try/catch
convention as `ui/components/collapse-toggle.ts`.

## Scenarios (BDD)

```gherkin
Scenario: Auto picks weak on a genuinely weak device
  Given the pref is 'auto'
  And the device reports 2 logical cores
  When resolveTier runs
  Then it returns 'weak'
# pinned by: tests/state/perf-mode.test.ts

Scenario: A capable tablet is not forced weak (the v1 regression)
  Given the pref is 'auto'
  And a desktop-class UA (no phone token) with 8 cores
  When resolveTier runs
  Then it returns 'medium' or 'strong' (never 'weak')
# pinned by: tests/state/perf-mode.test.ts

Scenario: Explicit tier overrides detection
  Given a capable desktop
  When the pref is 'weak'
  Then resolveTier returns 'weak' regardless of the device
# pinned by: tests/state/perf-mode.test.ts

Scenario: Medium and strong share an audio profile
  Then sameAudioProfile('medium','strong') is true
  And sameAudioProfile('weak','medium') is false
# pinned by: tests/state/perf-mode.test.ts

Scenario: Each tier scales the analyser fftSize (v4/v5)
  Then PERF_PROFILES analyserFftSize is 512 / 1024 / 2048 for weak / medium / strong
  And analyserFftSize is excluded from sameAudioProfile (applied live)
  And sameAudioProfile('medium','strong') stays true
# pinned by: tests/state/perf-mode.test.ts

Scenario: setFftSize applies the new fftSize to every scope analyser live (v5)
  Given a Scope over mono + L + R analysers
  When setFftSize(512) is called
  Then all three analysers report fftSize 512 (read buffers reallocated)
# pinned by: tests/ui/scope-regions.test.ts

Scenario: Changing fps + fftSize applies live; only audio boundaries need a reload
  Given the engine booted as strong
  When the user picks 'medium'
  Then onTierPreview fires (scope fps + fftSize change live) and no reload hint shows
  When the user picks 'weak'
  Then the reload hint and Reload button show
# pinned by: tests/ui/perf-settings.test.ts

Scenario: The pref is not a sound parameter
  Given the pref is changed
  Then no ParamBus param changes and no preset/song captures it
  And it persists under websynth.perf (legacy on/off migrate to weak/strong)

Scenario: Debug panel reports the detected tier and raw signals
  Given the About modal is open
  Then the Debug section shows the resolved tier, CPU cores, device memory, and mobile flag
# pinned by: tests/state/perf-mode.test.ts (perfDiagnostics)

Scenario: Weak caps the reverb IR bank without changing its shape (v3)
  Given a Reverb built with maxIrS 1.5
  Then it renders 5 IRs of [0.4, 0.8, 1.5, 1.5, 1.5] s
  And setSize's index mapping is unchanged (presets keep their meaning)
# pinned by: tests/audio/effects/fx-cost.test.ts

Scenario: Weak builds distortion without oversampling (v3)
  Given a Distortion built with oversample false
  Then its WaveShaper runs at 'none' (default '4x')
# pinned by: tests/audio/effects/fx-cost.test.ts

Scenario: Drum-track shapers only oversample when driven (all tiers, v3)
  Given a drum track at drive 0 (the default identity curve)
  Then its shaper's oversample is 'none'
  When drive is raised above 0
  Then it becomes '2x' (unless the tier disallows oversampling)
  And back at drive 0 it returns to 'none'
# pinned by: tests/audio/transport/drum-machine.test.ts
```

## Tests & verification

- Unit: `tests/state/perf-mode.test.ts` (tier detection/resolution, `sameAudioProfile`,
  storage + legacy migration, `perfDiagnostics`), `tests/ui/perf-settings.test.ts`
  (4-way control, tier colour, live-fps callback, reload hint only across audio
  boundaries) — `npm test`
- Typecheck: `npm run typecheck`
- Manual: force **Weak**, reload, check `window.__synth.engine.voices.length === 5`,
  `window.__synth.engine.analyser.fftSize === 512` (v4/v5), and a larger `ctx.baseLatency`;
  switch **Medium↔Strong** and confirm the scope fps changes with no reload prompt; open
  **About → Debug** and confirm the tier/cores/memory rows; background the tab and confirm
  the scope stops redrawing.

## Open questions / future

- Audio (buffer/voice) changes still need a reload (construction-time). A live rebuild
  is possible but heavy and rarely flipped.
- Strong could request **sub-`interactive`** latency via a numeric `latencyHint`; left
  out for now (glitch-prone, platform-dependent).
- A future adaptive mode could *measure* underruns and step the tier automatically;
  today detection is static.
- Phone detection thresholds: a Pixel-8a-class phone (9 cores, `deviceMemory` 8)
  resolves to **medium** and struggled before the v3 work. Decision (2026-07-02):
  keep detection as-is and revisit the thresholds once the worker clock / idle
  gating / true bypass have been validated on device — medium may now be viable
  on such phones; if not, tighten the phone rule rather than forcing all phones
  weak.
