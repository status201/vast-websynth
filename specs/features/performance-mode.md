# Performance mode

```yaml
id: performance-mode
status: implemented
version: 2
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

## Requirements

- **REQ-1** — A preference `auto | weak | medium | strong`, persisted under
  `localStorage['websynth.perf']` (default `auto`). It is **not** a `ParamBus` param
  and is never captured by presets/songs. Legacy values migrate on read: `on → weak`,
  `off → strong`, anything unrecognised → `auto`.
- **REQ-2** — `PERF_PROFILES: Record<PerfTier, PerfProfile>` is the single source of
  truth for every tier-dependent knob:
  `weak = { latencyHint:'playback', voiceCount:5, fps:15 }`,
  `medium = { 'interactive', 8, 30 }`, `strong = { 'interactive', 8, 60 }`.
  Strong and medium share the same **audio** profile (latency + voices); they differ
  only by scope fps.
- **REQ-3** — `detectTier()` errs toward **medium** (the safe, normal-latency default).
  Weak only on a genuinely low signal: `hardwareConcurrency <= 2`, **or**
  `deviceMemory <= 2`, **or** a phone UA (`/Mobi|Android|iPhone|iPod/`, **not** `iPad`)
  with `cores <= 4` or `mem <= 4`. Strong only when clearly high-end and not a phone:
  `!mobile && cores >= 8 && (mem === undefined || mem >= 8)`. Everything else is medium.
  Detection is a hint (`deviceMemory` is Chrome-only, cores can be capped) — the user
  override is the real escape hatch.
- **REQ-4** — `resolveTier(pref)` returns the effective tier: a concrete tier passes
  through; `auto` → `detectTier()`. `sameAudioProfile(a, b)` is true iff two tiers share
  `latencyHint` + `voiceCount`.
- **REQ-5** — The **audio** profile (buffer + voice count) is tuned **at boot** only
  (it can only be chosen when the `AudioContext`/voice pool are built): boot reads
  `PERF_PROFILES[resolveTier()]` and passes `{ latencyHint, voiceCount }` to the Engine.
  Changing the tier across an audio boundary therefore takes full effect only after a
  reload.
- **REQ-6** — Scope **fps** is applied **live**: `Scope` takes `{ fps }` and exposes
  `setFps(fps)`. Changing tiers updates the scope frame rate immediately (no reload).
  Throttling is timestamp-based (`now - lastDrawTs >= 1000/fps`; `fps >= 60` means draw
  every frame), correct on high-refresh displays. The scope always pauses its redraw
  loop while the tab is hidden (`visibilitychange`).
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
  profile (`latencyHint · voices · fps`).
- **REQ-10** — No-op for capable devices on default `auto`: a strong/medium device
  builds the engine with `latencyHint: 'interactive'` and 8 voices, exactly as before.

## Technical design

### Contract / public interface

```yaml
# src/state/perf-mode.ts
PerfTier: 'weak' | 'medium' | 'strong'
PerfPref: 'auto' | PerfTier
PerfProfile: { latencyHint: AudioContextLatencyCategory; voiceCount: number; fps: number }
PERF_PROFILES: Record<PerfTier, PerfProfile>   # single source of truth
readPerfPref(): PerfPref                        # validates + migrates legacy on/off
writePerfPref(pref: PerfPref): void
detectTier(): PerfTier
resolveTier(pref?: PerfPref): PerfTier          # pref defaults to readPerfPref()
sameAudioProfile(a: PerfTier, b: PerfTier): boolean
PerfDiagnostics: { cores; memoryGb; mobile; pref; detected; tier; profile }
perfDiagnostics(): PerfDiagnostics

# src/audio/engine.ts
EngineOptions: { latencyHint?: AudioContextLatencyCategory; voiceCount?: number }
new Engine(bus, opts?: EngineOptions)           # latencyHint→AudioContext, voiceCount→pool

# src/ui/components/scope.ts
new Scope(analysers, opts?: { fps?: number })   # default 60
scope.setFps(fps: number): void                 # live frame-rate change

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
  { latencyHint, voiceCount } = PERF_PROFILES[resolveTier()]
  new Engine(bus, { latencyHint, voiceCount })   # read once — buffer + pool fixed thereafter
engine: opts.latencyHint -> new AudioContext({ latencyHint }); opts.voiceCount -> init() voice loop
ui (app.ts):
  buildHeader mounts createPerfSettingsButton({ onTierPreview: t -> setScopeFps(PERF_PROFILES[t].fps) })
  buildBottom builds Scope({ fps: PERF_PROFILES[resolveTier()].fps }) and returns it; mountApp
    binds the late `setScopeFps` hook to scope.setFps (same pattern as fxExpand)
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

Scenario: Changing fps applies live; only audio boundaries need a reload
  Given the engine booted as strong
  When the user picks 'medium'
  Then onTierPreview fires (scope fps changes) and no reload hint shows
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
```

## Tests & verification

- Unit: `tests/state/perf-mode.test.ts` (tier detection/resolution, `sameAudioProfile`,
  storage + legacy migration, `perfDiagnostics`), `tests/ui/perf-settings.test.ts`
  (4-way control, tier colour, live-fps callback, reload hint only across audio
  boundaries) — `npm test`
- Typecheck: `npm run typecheck`
- Manual: force **Weak**, reload, check `window.__synth.engine.voices.length === 5` and
  a larger `ctx.baseLatency`; switch **Medium↔Strong** and confirm the scope fps changes
  with no reload prompt; open **About → Debug** and confirm the tier/cores/memory rows;
  background the tab and confirm the scope stops redrawing.

## Open questions / future

- Audio (buffer/voice) changes still need a reload (construction-time). A live rebuild
  is possible but heavy and rarely flipped.
- Strong could request **sub-`interactive`** latency via a numeric `latencyHint`; left
  out for now (glitch-prone, platform-dependent).
- A future adaptive mode could *measure* underruns and step the tier automatically;
  today detection is static.
```
