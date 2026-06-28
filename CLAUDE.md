# CLAUDE.md

Guidance for working in this repo. See `README.md` for the user-facing overview.

## Specs (Spec-Driven Development)

`specs/` holds the architectural source of truth as human- and AI-readable specs.
Start at `specs/README.md` (the SDD method, tailored to this repo) and
`specs/architecture.md` (system-wide overview: contracts, audio graph, conventions
with versions). Per-feature specs live in `specs/features/` and repeatable how-tos
in `specs/recipes/` (e.g. `specs/recipes/add-a-parameter.md`). For **new** features,
write/review the spec before generating code; copy `specs/_template.md` to start.
Specs are standalone, so they restate the conventions they rely on — this file
remains the canonical, exhaustive reference.

**SDD is enforced, not optional.** A change that edits production code (`src/**`,
`public/worklets/**`) must create/update a spec under `specs/` in the *same* change
— enforced by `scripts/sdd-guard.mjs` (Claude Code hooks in `.claude/settings.json`
+ the `sdd-check` CI job). A blocked `Edit`/`Write` or a blocked `Stop` is the gate
working: write the spec first (`/feature`, `/fix`, `/spec`). Exempt: paths outside
`src/`/`public/worklets/`, plus `*.md`, `*.css`/styles, and `src/vendor/`. Genuinely
trivial production tweak? `touch .sdd-skip` (local) or `[skip-sdd]` in a commit / the
`skip-sdd` PR label (CI). See `specs/README.md` → "Procedure by change type".

## What this is

A Web Audio synthesizer in vanilla TypeScript. No framework, no runtime
dependencies. Build tooling is Vite + `tsc` only. The one exception is the
MIT-licensed `lamejs` MP3 encoder, *vendored* (not an npm dependency) under
`src/vendor/lamejs/` for the audio-export feature — typed via a hand-written
`lame.min.d.ts`.

## Commands

```bash
npm run dev        # dev server (vite --host)
npm run typecheck  # tsc --noEmit — run this to verify changes
npm run build      # tsc --noEmit && vite build
npm test           # vitest run — pure-logic + component unit tests
npm run e2e        # playwright test — browser smoke + control-surface specs
npm run release    # bump version + CHANGELOG, build, zip dist/, print publish steps
```

`npm run release -- <version|major|minor|patch>` (`scripts/release.mjs`, zero
deps) bumps `package.json` + promotes the CHANGELOG, then builds and zips `dist/`
into `dist-v<version>.zip` (a GitHub-release asset) and **prints** the
`git` + `gh release create … <zip>` commands — it never touches git/GitHub
itself (attaching the zip needs the `gh` CLI authenticated). Flags: `--dry-run`
(preview, write/build nothing), `--yes`/`-y` (skip the confirm prompt),
`--skip-build` (bump files but skip the build+zip). The zip + a
`dist-v<version>.notes.md` are gitignored (`dist-v*`). See `DEPLOYMENT.md`.

`npm run typecheck` is still the primary check (TS is in `strict` mode with
`noUncheckedIndexedAccess`, so expect `arr[i]!` assertions throughout — match
that style). There is also a Vitest suite under `tests/` covering the
pure-logic units (`ParamBus`, `PatternStore`, `Song`, `Presets`, audio `encode`,
sample `buffer-dsp`), the transport modules (`Arpeggiator`, `Arrangement`,
`Sequencer`, `DrumMachine`, `SamplerMachine`, `Performance`) and the DOM
components (`createButton`, `Dropdown`, `Switch`, `Segmented`, `Tabs`,
`BankBar`, `ParamDropdown`, `Modal`, …); it runs in jsdom. Transport modules
that build an audio graph in their constructor are tested against a mock
`AudioContext` (`tests/audio/mock-audio-context.ts`) — chainable node stubs with
`vi.fn()` `AudioParam`s, so the wiring builds but no audio runs;
`localStorage`-backed suites install an in-memory `Storage`
(`tests/storage-mock.ts`), since jsdom's isn't reliably wired under Vitest.
Tests live **outside `src/`** so they stay invisible to `tsc` —
`typecheck`/`build` behaviour is unchanged. There is no linter.

**E2E (Playwright)** lives in `e2e/` (also outside `src/`, so `tsc` ignores
it), config in `playwright.config.ts`. It drives the **dev server** in headless
Chromium — Playwright clicks are trusted gestures, so they unlock the
`AudioContext` behind "Tap to start". CSS Modules hash every class name, so
specs select by **text/role** or by `data-testid`. Interactive components carry
stable testids minted at the factory level: `knob-<paramId>`,
`switch-<paramId>`, `seg-<paramId>`(+`-<idx>`), `strip-<paramId>`,
`tab-<id>`/`panel-<id>`, plus per-instance ones in the panels (`seq-step-<i>`,
`drum-step-<t>-<s>`, `sampler-step-<slot>-<s>`,
`<seq|drum|sampler>-vel/-gate/-prob/-ratchet-<n>/-tie` (the shared
`StepSettingsEditor` per-step edit row), `sampler-load/name/edit/file-<slot>`,
`bank-<seq|drum|sampler>-<i>`/`bank-…-copy` (the per-machine `BankBar`, via its
`testidPrefix` opt), the Song panel's live FX (`perf-fill`/`perf-stutter`/
`perf-drop`/`perf-tapestop`, `perf-stutter-size-<n>`), the Song panel's per-lane
DJ mixer (`song-lane-<seq|drum|sampler>` cards, each with `switch-<lane>.mute`/
`switch-<lane>.solo` + a `knob-<lane>.master` mirroring the per-machine volume),
`song-save`/`song-load`/…, `transport-play`, `preset-select`). Prefer testids
over labels — capitalised button text collides with lowercase siblings under
Playwright's case-insensitive matching (the header `Play` vs the Arpeggiator's
`play`; the `Sampler` tab vs the Song panel's `sampler` lane). For state
assertions, `main.ts` exposes a **dev-only** bridge `window.__synth =
{ engine, bus, patterns, session }` (gated on `import.meta.env.DEV`, absent in
production) — e.g. `window.__synth.bus.get('filter.cutoff')`. Specs cover boot
(`smoke`), the control surface (`controls`), and the deeper flows — `presets`
(select/save + localStorage), `patterns` (seq/drum/sampler grid edits,
per-step settings viz + clock advance),
`banks` (A/B/C/D edit/switch/copy), `sampler` (WAV load via `setInputFiles` + a
Node-built fixture in `helpers.makeWavBuffer`), `song` (save→new→load round-trip
+ a WAV Export Song download verified by its RIFF/WAVE header), `arp` (held-note
transport auto-start/stop + ownership), `song-fx` (the Song panel's live DJ FX —
DJ-filter sweep, Filter Drop, Tape Stop pitch-bend, Stutter/Fill), `compressor`
(the drum/master bus compressors — switch, knobs, `grmeter-<prefix>` presence,
help badges),
and `mic`
(the record-sound modal — record from the fake device, edit, load into a slot).
`prompt`/`confirm`
are handled with `page.once('dialog', …)`; blob downloads via
`page.waitForEvent('download')`. The mic spec relies on the
`--use-fake-device/ui-for-media-stream` Chromium flags (in `playwright.config.ts`)
plus `context.grantPermissions(['microphone'])`, so `getUserMedia` resolves with
a synthetic stream — and on a secure context, which `localhost` satisfies.

## Architecture

Two long-lived objects are created once in `main.ts` and threaded everywhere:

- **`ParamBus`** (`state/params.ts`) — the single source of truth for every
  scalar parameter. Every param is registered in `registerDefaults()` with
  `min/max/default/taper/format`. Setting a value clamps it and notifies
  subscribers. **UI and audio never talk directly** — a knob calls
  `bus.set(...)`; the `Engine` does `bus.subscribe(...)` to apply it to the
  audio graph. To add a parameter: add a `ParamDef`, wire it (per-voice +
  one-off in `Engine.subscribeParams()`; an insert-effect param goes in that
  effect's own `bind(bus, prefix)` — ADR-008), add a UI control in `ui/app.ts`.
- **`Engine`** (`audio/engine.ts`) — owns the `AudioContext`, the voice pool
  (8 `Voice`s), the FX chain, and transport modules; it *coordinates* rather
  than knows-all (ADR-008). Voice allocation + unison/glide/drift live in
  **`Polyphony`** (`audio/polyphony.ts`); the Song-tab mute/solo/volume mixer in
  **`LaneMixer`** (`audio/lane-mixer.ts`). Note events flow through `bus.onNote`
  → `playNote` / `releaseNote` (thin delegators to `Polyphony`) unless
  `passthroughSuppressed` is set (arpeggiator/sequencer take over triggering then).

Audio graph:

```
voices → voiceBus → distortion → wah → phaser → delay → reverb ─┐
                drumBus → drumComp → drumPhaser → drumDelay ─────┤
                                                          preMaster → djFilter → masterComp → analyser → master → destination
```

The analyser taps **pre-master** so the scope is independent of the volume
knob. The drum bus **and** the sampler bus join at `preMaster`, bypassing the
synth FX chain.

**Compressors** — a single `hardware-compressor` AudioWorklet
(`public/worklets/compressor.js`, wrapped by `audio/compressor/node.ts`)
with two character modes fixed per instance via `processorOptions.mode`:
`'fet'` (1176-style: feedback detector, program-dependent release, FET
saturation) heads the drum chain (`engine.drumComp`), and `'vca'` (SSL
G-bus-style: 6 dB soft knee, auto-release glue) sits `djFilter → masterComp →
analyser` (`engine.masterComp`). The `Compressor` Effect
(`audio/effects/compressor.ts`) builds its `BypassWrapper` synchronously so
Engine's constructor can wire chains, then `attachWorklet()` (from
`Engine.init()`, after `loadModule`) splices the node in and replays cached
setter values. Discrete ratio/release params carry an *index*; the compressor's
`bind(bus, prefix, ratios, releases?)` maps it to real values (fet ratio 100 =
"all buttons in"; an SSL release index past the table = auto). The worklet posts gain
reduction (dB, ~31 Hz) on its port for the `GrMeter` UI; its DSP is
unit-tested directly under Vitest (`tests/audio/compressor-worklet.test.ts`)
by stubbing the worklet globals and importing the file.

**Audio export** — a zero-output `recorder` AudioWorklet
(`public/worklets/recorder.js`, wrapped by `audio/recorder/node.ts`) is tapped
off `master` (post master-volume) as a pure sink. `RecorderController`
(`audio/recorder/recorder-controller.ts`) drives capture: `exportSong()` plays
one full pass of the longest enabled arrangement chain then auto-stops;
`toggleManual()` is a free-form record toggle. Encoding is **pure** and
AudioContext-free (`audio/recorder/encode.ts` — `encodeWav` is dependency-free;
`encodeMp3` uses the vendored lamejs) so it is unit-testable under jsdom.

**Sample recorder/editor** — the Sampler's "Record a sound" modal
(`ui/components/record-sound-modal.ts`, built on the reusable `Modal`,
`ui/components/modal.ts`) records the mic via `audio/recorder/mic-capture.ts`
(getUserMedia → a *fresh* `RecorderNode` + a muted-gain tap to `destination`
so the 0-output sink stays pulled), edits in `CapturedAudio` space, then saves
(reusing `encode.ts`) or fills a slot. Pure DSP
(`audio/recorder/buffer-dsp.ts` — crop/reverse/normalize/gain/fade/
`computePeaks`/`peakDb`) is AudioContext-free and unit-tested like
`encode.ts`; filter + octave go through an `OfflineAudioContext`
(`audio/recorder/offline-render.ts`); `audio/recorder/audio-buffer.ts` is the
**only** `CapturedAudio`↔`AudioBuffer` bridge (keeps `buffer-dsp` testable).
A loaded slot exposes an ✎ button that reopens its buffer in the same editor.

Non-scalar state (step grids) lives in **`PatternStore`** (`state/patterns.ts`),
not in `ParamBus`, because the shapes are arrays of objects. It has its own
listener mechanism.

### Song mode

- **`PatternStore`** holds 4 sequencer banks + 4 drum banks. The UI edits the
  *edit bank* (`seq`/`drum` getters; `setSeqEditBank`/`setDrumEditBank`
  re-emit every step so panels repaint). The transport reads the *play bank*
  (`seqBank(i)`/`drumBank(i)`) chosen by the Arrangement — which may differ.
- **Per-step settings** — every machine's step carries velocity/gate/prob/
  ratchet/tie (`StepSettings` in `state/patterns.ts`; `SeqStep` adds `note`,
  `DrumCell`/`SamplerStep` are the shared `TriggerCell`). The pure hit math
  (probability roll + ratchet sub-hit timing) is
  `audio/transport/step-hits.ts`, consumed by all three machines. The seq
  releases its voice at `gateEnd`; the one-shot machines use the **choke
  model**: gate < 1 cuts the hit early via a per-hit downstream gain
  (`chokeRoute` in `drums/drum-synths.ts`; the sampler chokes its per-hit
  velocity gain), gate 1 — their default — is the natural decay, and tie
  lets the last ratchet sub-hit ring into the next step. The shared edit-row
  UI is `StepSettingsEditor` (`ui/components/step-settings.ts`, styles in
  `step-settings.module.css`); each panel owns its selection cursor.
  `PatternStore.restore` spreads defaults under incoming cells, so legacy
  v1/v2 song files (plain `{on, velocity}` drum/sampler cells) load with
  gate 1 etc. and sound unchanged.
- **`Arrangement`** (`audio/transport/arrangement.ts`) — two independent
  chain lanes (seq + drum), each an ordered list of bank indices. Advances
  one slot per bar (`step % SEQ_LENGTH === 0`); a disabled lane's play bank
  tracks that machine's edit bank. Constructed **before** the sequencer/drum
  machine so its `clock.onTick` runs first and play banks are settled before
  the machines read them on the same tick. Resets on `Clock.onStart`.
- **`Performance`** (`audio/transport/performance.ts`) — live DJ FX, owned by
  Engine. `mapStep()` (stutter) is consulted by both machines each tick;
  `fillActive` makes the drum machine play a roll; Filter Drop / manual DJ
  Filter drive `engine.djFilter` (a BiquadFilter inserted `preMaster →
  djFilter → analyser`); Tape Stop ramps `Clock` BPM + pitch-bend via rAF.
- **Lane mixer** — Song-tab mute/solo/volume per lane (`<lane>.mute`/
  `.solo`/`.master` params). The audibility rule is the pure `audibleLanes`
  (`audio/transport/lane-mix.ts`, solo wins over mute), shared by
  `LaneMixer` (`audio/lane-mixer.ts`) and the Song panel's dim-when-silenced visual.
  Drums/sampler mute by cutting their bus gain; the sequencer mutes via
  `StepSequencer.setMuted` (stops triggering, leaving live-keyboard play and the
  voice bus untouched). `seq.master` is the synth voice-bus volume (default 1,
  a no-op for existing presets).
- **Sampler** — `PatternStore` also holds 4 **sampler** banks (8 slots × 16
  steps, `SamplerStep`). `SamplerMachine` (`audio/transport/sampler-machine.ts`)
  mirrors `DrumMachine` but each slot plays a user-loaded `AudioBuffer`
  one-shot; the `Arrangement` has a third `sampler` chain lane. Decoded buffers
  live in `SamplerMachine`; only filenames (`patterns.sampleNames`) persist —
  after a song import the user re-loads the files (`.needs-reload` label hint).
  Slots are filled by **Load** (WAV/MP3 file) or the record-sound modal
  (mic-record or re-edit a loaded buffer; see *Sample recorder/editor*).
- **`Song`** (`state/song.ts`) — `capture`/`apply` a full song (`bus.snapshot`
  + all banks + all three chains). `SongFile` is now `version: 1 | 2`; v2 adds
  optional `samplerBanks`/`samplerChain`/`sampleNames`. `fromJSON` is unchanged
  and accepts both; v1 files (incl. `DEMO_SONGS`) load with empty sampler
  state. JSON file export/import **and** localStorage slots under
  `websynth.song.*`. `DEMO_SONGS` (Apex Twin, Zombie Nation, I Feel Love, plus
  any drop-ins). Demos are the two hand-authored `SongFile` literals **plus**
  any `*.json` SongFile in `src/state/demos/`, auto-registered at build time via
  an `import.meta.glob` (keyed by the file's `name`). Drop-ins are spread
  *before* the built-ins, so they lead the demo button row (`Object.keys` order).
- **Song/preset serialization** (`state/serialize.ts`) — `Song.toJSON` and
  `Presets.save` optimize **only at the boundary** (live state stays full-precision):
  `compactSongForExport`/`roundParams` round every number to 4 sig-figs and write
  **default-sparse** step cells (a dead cell is `{on:false}`; seq keeps
  on/note/velocity/gate). Output is the *canonical compact* form —
  `fromJSON(toJSON(x))` equals `compactSongForExport(x)`, not `x`; `apply`/`restore`
  re-expand defaults (sound unchanged). Re-canonicalize committed demos with
  `npm run clean:demos`. See ADR-011.

## Conventions & gotchas

- **Filter cutoff is a MIDI note number**, not Hz. The ladder filter worklet
  takes `cutoffNote` so envelope/LFO modulators sum in semitones via Web
  Audio's native `AudioParam` input summation. Keep modulation additive in
  semitone space.
- The ladder filter is an **AudioWorklet**; its processor lives in
  `public/worklets/ladder-filter.js` (plain JS, runs on the audio thread —
  no TS, no imports). `LadderFilterNode.loadModule()` must be awaited before
  voices are created.
- **DSP worklets are _musical, stable, cheap_** (in that priority order):
  perceived behaviour over circuit accuracy, bounded/no-NaN output always,
  minimal per-sample cost (8-voice poly × 2ch). Governs the ladder filter +
  compressors; tuning constants (e.g. `RES_MAKEUP`, resonance `curve`) are dialled
  by ear. Don't add "academically correct" DSP (ZDF, oversampling, thermal models)
  unless it's also cheap and stable. See `specs/decisions/adr-010-musical-stable-cheap-dsp.md`.
- `Engine.init()` is async (loads the worklet, creates voices, builds
  transport modules). Transport modules are created **after** voices so they
  can call back into the engine.
- Presets persist to `localStorage` under `websynth.preset.*`. Factory
  presets are seeded by `ensureFactoryPresets()` on boot.
- Audio cannot start without a user gesture — everything is wired inside the
  "Tap to start" handler in `main.ts`.
- **Performance mode** (`state/perf-mode.ts`) — a device-scoped `auto`/`on`/`off`
  quality setting persisted under `websynth.perf`, **not** a `ParamBus` param (so
  it never enters presets/songs). `main.ts` resolves it at boot via
  `resolvePerfActive()`; when active (auto-detects a weak device by
  `hardwareConcurrency`/`deviceMemory`/mobile-UA, or forced on) the `Engine` is
  built with a larger `latencyHint` (`'playback'`) + fewer voices
  (`PERF_VOICE_COUNT`) through `EngineOptions`, and the scope renders lighter +
  pauses while the tab is hidden. Buffer/voice count are fixed at `AudioContext`
  build, so a change applies on **reload** — the header "Perf" modal shows the
  effective state and a reload nudge. See `specs/features/performance-mode.md`.
- Dialogs use the shared **`Modal`** (`ui/components/modal.ts`), extracted
  from the previously-duplicated about/start-modal pattern (`.about-backdrop`/
  `.about` CSS, Escape captured to beat the panic handler, backdrop-click +
  fade close). `about.ts` and the start modal were intentionally left as-is.
- Mic capture needs a **secure context**. `npm run dev` (`vite --host`)
  serves the LAN over plain HTTP, so recording from a phone/other device is
  blocked by the browser — the modal shows a clear message; it works from
  `http://localhost`.
- UI is hand-built DOM (`document.createElement`), no virtual DOM. Components
  in `ui/components/`, larger sections in `ui/panels/`. Panels/components that
  need transport/pattern/recorder/meter access take a **`StudioApi`**
  (`ui/studio-api.ts`) — the UI's narrow, structural view of the `Engine`, not the
  whole object (ADR-009); `main.ts` passes the concrete `Engine`. The on-screen keyboard
  and transport toggle are driven through a shared **`UiBridge`**
  (`ui/ui-bridge.ts`): `app.ts` wires its `pressKey`/`releaseKey`/
  `toggleTransport` callbacks to the keyboard component and the header Play
  button, and `shortcuts.ts` is handed the bridge so it can drive them
  (`toggleTransport` clicks the real Play button, keeping its visuals in sync).
  The only dev-only `window` global is `__synth` (gated on `import.meta.env.DEV`);
  there is no `window.__synthKeyboard`/`__transportToggle`.
- `glide.mode` defaults to **`always`** (1), not `off`, because `always`
  with glide time 0 reproduces the pre-song-mode behaviour — keeps existing
  presets that set `mixer.glide` sounding the same.
- New analogue/song params default to a **no-op** (sub level 0, unison 1
  voice, drift 0, djfilter 0) so existing presets are unaffected.
- **CSS Modules** — all component/panel styling is in `src/ui/styles/*.module.css`. Global CSS is now only `src/styles/base.css` (reset), `src/styles/theme.css` (custom properties), and `src/styles/layout.css` (`.app` grid + responsive).
  - State classes (`.on`, `.active`, `.hidden`, `.playing`, `.collapsed`) are global — match them with `:global(.on)` in module selectors.
  - Bridge global classes (e.g. `switch-label`) are kept alongside module classes where global descendant selectors still target children: `className: 'switch-label ' + styles.label!`.
  - Use `:global()` when a module selector targets an element with only a global class: `.icons button :global(svg.wave-icon)`.
  - Step buttons: `.root` is `min-width: 0; width: 100%; height: 32px`. `.drum-cell` overrides height to 22px and font-size to 8px but does NOT set width — parent grid controls sizing.
  - Step buttons (all three machines) visualize per-step settings via `StepButton.setViz()`: a lazily-created `.fill` layer driven by inline custom props (`--sb-gate` width, `--sb-vel` brightness, `--sb-ratchet` top ticks) plus `tie`/`prob`/`ratchet` classes; the label lives in a `.label` span so `setLabel` can't wipe the layer. `.red .fill` keeps the drum/sampler beat columns red when lit; `.drum-cell.tie .fill` shortens the tie bridge to the drum grid's 3px gap.
  - The drum module's `.cells` uses `display: grid; grid-template-columns: repeat(16, 1fr); gap: 3px` — both `drum-panel.ts` and `sampler-panel.ts` import this via `drumStyles.cells`.
  - Sampler action buttons (`.load`, `.edit`, `.rec`) need full base button styling (background, border, border-radius, cursor, font-family, box-shadow, transition) in their module class — they are standalone classes with no shared base class to inherit from.
  - Panel builder functions must explicitly `appendChild` every sub-container to the root element. Orphaned DOM subtrees (built but never appended) are a common source of blank panels — previously tripped on `drum-panel.ts` where the grid was constructed but `root.appendChild(grid)` was missing.
- Demo-song riffs aim to be *recognisable*, not note-perfect transcriptions.

## Branding

The product is presented in-app as **"VAST G1-J5"**; the package/repo name is
`websynth`. Both refer to the same thing.
