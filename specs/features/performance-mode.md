# Performance mode

```yaml
id: performance-mode
status: implemented
version: 1
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
  - src/ui/app.ts
```

A device-scoped audio-quality setting (**Auto / On / Off**) that trades a little
latency, polyphony, and visual fidelity for stable, glitch-free audio on weak
hardware. Distinct from [`performance.md`](performance.md) (the live DJ-FX
module) — same word, unrelated feature.

## Background / Why

The synth is fixed-cost: 8 voices each run a per-sample ladder-filter worklet,
the FX chains process even when "off" (the `BypassWrapper` gains down rather than
disconnects), and the `AudioContext` is built with `latencyHint: 'interactive'`
(the smallest, most glitch-prone buffer). On phones and busy desktops this
overruns the audio thread — crackle, distortion, white noise. There was no knob
to reduce load. Performance mode adds one: on weak devices (auto-detected, or
forced on) it enlarges the audio buffer, caps polyphony, and lightens the scope.
It is a runtime/device preference, **not** a sound parameter, so it is stored
outside the `ParamBus` and never enters a preset or song.

This is the resilience layer on top of the separate drum-voice node-leak fix
(see [`drum-machine.md`](drum-machine.md) REQ-9), which removed the unbounded
node growth that caused audio to degrade *over time*.

## Requirements

- **REQ-1** — A tri-state preference `auto | on | off`, persisted under
  `localStorage['websynth.perf']` (default `auto`). It is **not** a `ParamBus`
  param and is never captured by presets/songs.
- **REQ-2** — `detectWeakDevice()` heuristic: `navigator.hardwareConcurrency <= 4`,
  **or** `navigator.deviceMemory <= 4`, **or** a mobile user-agent. Conservative
  by design — a false positive only costs latency/voices, which the user can
  override to `off`.
- **REQ-3** — `resolvePerfActive(pref)` returns the effective boolean: `on`→true,
  `off`→false, `auto`→`detectWeakDevice()`.
- **REQ-4** — When active, the buffer + voice count are tuned **at boot**
  (they can only be chosen when the `AudioContext`/voice pool are built):
  `latencyHint: 'playback'` and `voiceCount = PERF_VOICE_COUNT` (5). Changing the
  preference therefore takes full effect only after a reload.
- **REQ-5** — The scope (`ui/components/scope.ts`) always pauses its redraw loop
  while the tab is hidden (`visibilitychange`); when `lightweight` (perf active)
  it also skips the canvas drop-shadow and halves the redraw rate (~30fps).
- **REQ-6** — A header "Perf" button opens a modal with an Auto/On/Off control;
  changing it persists immediately and shows a "reload to apply" hint + button
  whenever the new choice's resolved active state differs from the booted one.
  The body copy is readable sentence case (not the uppercase tagline style), and
  a **status line** states what the selected preference *resolves to on this
  device* (e.g. "on — slower hardware detected" / "off — this device looks
  capable" / "forced on/off"). This separates the *preference* (the segmented:
  what decides) from whether Performance mode is actually *engaged* — so "Auto"
  is not mistaken for "currently on". The header "Perf" button itself carries an
  at-a-glance state (`data-perf-state`): **orange** when engaged (forced on or
  auto-detected on), **green** when forced off, and **no active state** when set
  to auto and not engaged — mirroring the Help button's active-state pattern.
  While a chosen mode is **pending a reload** (its resolved engaged state differs
  from what the engine booted with), the button **pulses** (`data-perf-pending`)
  as a "reload to apply" nudge, respecting `prefers-reduced-motion`.
- **REQ-7** — No-op for capable devices on the default `auto`: the engine builds
  exactly as before (`latencyHint: 'interactive'`, 8 voices, full-fidelity scope).

## Technical design

### Contract / public interface

```yaml
# src/state/perf-mode.ts
PerfPref: 'auto' | 'on' | 'off'
readPerfPref(): PerfPref
writePerfPref(pref: PerfPref): void
detectWeakDevice(): boolean
resolvePerfActive(pref?: PerfPref): boolean      # pref defaults to readPerfPref()

# src/audio/engine.ts
EngineOptions: { latencyHint?: AudioContextLatencyCategory; voiceCount?: number }
new Engine(bus, opts?: EngineOptions)            # latencyHint→AudioContext, voiceCount→pool
PERF_VOICE_COUNT = 5                             # exported

# src/ui/components/scope.ts
new Scope(analyser, opts?: { lightweight?: boolean })

# src/ui/components/perf-settings.ts  (styles: ui/styles/perf-settings.module.css)
createPerfSettingsButton(): HTMLButtonElement   # modal testids: perf-mode[-auto|on|off],
                                                # perf-status, perf-reload-hint, perf-reload
```

### Layer touchpoints & ordering

```yaml
boot (main.ts):
  perf = resolvePerfActive()
  new Engine(bus, perf ? { latencyHint: 'playback', voiceCount: PERF_VOICE_COUNT } : {})
  # read once, before Engine construction — buffer + pool are fixed thereafter
engine: opts.latencyHint -> new AudioContext({ latencyHint }); opts.voiceCount -> init() voice loop
ui (app.ts): header mounts createPerfSettingsButton(); Scope built with { lightweight: resolvePerfActive() }
scope: visibilitychange listener (always) + lightweight flag (perf)
```

### Persistence

`localStorage['websynth.perf']` = `auto | on | off` (default `auto`).
**Deliberately not persisted into presets or songs** — it describes the device,
not the sound. No `SongFile`/preset field. Same `websynth.*` + try/catch
convention as `ui/components/collapse-toggle.ts`.

## Scenarios (BDD)

```gherkin
Scenario: Auto activates on a weak device
  Given the pref is 'auto'
  And the device reports 2 logical cores
  When resolvePerfActive runs
  Then it returns true
# pinned by: tests/state/perf-mode.test.ts

Scenario: Explicit On/Off overrides detection
  Given a capable desktop
  When the pref is 'on'
  Then resolvePerfActive returns true regardless of the device
# pinned by: tests/state/perf-mode.test.ts

Scenario: The pref is not a sound parameter
  Given the pref is changed
  Then no ParamBus param changes and no preset/song captures it
  And it persists under websynth.perf

Scenario: Changing the mode prompts a reload when it changes the active state
  Given the engine booted with perf inactive
  When the user picks a choice that resolves to active
  Then the modal shows the reload hint and a Reload button
# pinned by: tests/ui/perf-settings.test.ts

Scenario: Capable device on default auto is unaffected (REQ-7)
  Given a capable desktop and pref 'auto'
  When the engine boots
  Then latencyHint is 'interactive' and the voice pool is 8
# pinned by: tests/state/perf-mode.test.ts (resolvePerfActive=false → no EngineOptions)
```

## Tests & verification

- Unit: `tests/state/perf-mode.test.ts` (detection + resolution + storage),
  `tests/ui/perf-settings.test.ts` (modal + persistence + reload hint) — `npm test`
- Typecheck: `npm run typecheck`
- Manual: with perf On, reload and check `window.__synth.engine.voices.length === 5`
  and a larger `ctx.baseLatency`; background the tab and confirm the scope stops
  redrawing.

## Open questions / future

- Buffer/voice changes need a reload (they are construction-time). A live path
  (rebuild the voice pool, recreate the context) is possible but heavy and not
  worth it for a setting users rarely flip.
- A future adaptive mode could *measure* glitches/underruns and step the level
  automatically; today the heuristic is static.
- Truly disconnecting bypassed FX DSP (vs. the current gain-to-zero
  `BypassWrapper`) would cut more steady-state cost but risks reconnect clicks —
  out of scope here.
```
