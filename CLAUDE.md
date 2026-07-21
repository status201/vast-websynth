# CLAUDE.md

Guidance for working in this repo. See `README.md` for the user-facing overview.

## Specs (Spec-Driven Development)

`specs/` holds the architectural source of truth as human- and AI-readable specs.
Start at `specs/README.md` (the SDD method, tailored to this repo) and
`specs/architecture.md` (system-wide overview: contracts, audio graph, conventions
with versions). Per-feature specs live in `specs/features/` and repeatable how-tos
in `specs/recipes/` (e.g. `specs/recipes/add-a-parameter.md`). For **new** features,
write/review the spec before generating code; copy `specs/features/_feature-template.md`
to start (a how-to copies `specs/recipes/_recipe-template.md`).
Specs are standalone, so they restate the conventions they rely on — this file
remains the canonical, exhaustive reference.

**SDD is enforced, not optional.** A change that edits production code (`src/**`,
`public/worklets/**`) must create/update a spec under `specs/` in the *same* change
— enforced by `scripts/sdd-guard.mjs` (Claude Code hooks in `.claude/settings.json`
+ the `sdd-check` CI job). A blocked `Edit`/`Write` or a blocked `Stop` is the gate
working: write the spec first (`/feature`, `/fix`, `/spec`). Exempt: paths outside
`src/`/`public/worklets/`, plus `*.md`, `*.css`/styles, `src/vendor/`, and
`src/state/demos/` (demo songs are data drop-ins). Genuinely
trivial production tweak? `touch .sdd-skip` (local) or `[skip-sdd]` in a commit / the
`skip-sdd` PR label (CI). See `specs/README.md` → "Procedure by change type".

## What this is

A Web Audio synthesizer in vanilla TypeScript. No framework, no runtime
dependencies. Build tooling is Vite + `tsc` only. The exceptions are three
*vendored* (not npm) libraries, each typed via a hand-written used-subset
`.d.ts` (ADR-003): the MIT `lamejs` MP3 encoder (`src/vendor/lamejs/`, for
audio export), the MIT `qrcode-generator` QR *encoder* (`src/vendor/qr/`, for
WiFi-sync pairing) and the Apache-2.0 `jsQR` QR *decoder* (`src/vendor/jsqr/`,
the WiFi-sync scan fallback where `BarcodeDetector` is absent — see
`specs/features/webrtc-sync.md`).

## Commands

```bash
npm run dev        # dev server (vite --host)
npm run typecheck  # tsc --noEmit — run this to verify changes
npm run build      # tsc --noEmit && vite build
npm test           # vitest run — pure-logic + component unit tests
npm run e2e        # playwright test — browser smoke + control-surface specs
npm run build:mcp  # bundle the pure song core for the MCP server (scripts/mcp/dist/)
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
sample `buffer-dsp`, the `zip` codec + `project` bundle build/parse, the
`song-author` dialect expander, `song-link` share payloads, the published
authoring docs' drift pins, the vendored QR encoder→jsQR decoder round-trip
under `tests/vendor/`, and the MCP server under `tests/mcp/`), the
transport modules (`Arpeggiator`, `Arrangement`,
`Sequencer`, `DrumMachine`, `SamplerMachine`, `MotionMachine` + the pure
`motion-curve`, `Performance`) and the DOM
components (`createButton`, `Dropdown`, `Switch`, `Segmented`, `Tabs`,
`BankBar`, `ParamDropdown`, `Modal`, `MotionStepPad`, …); it runs in jsdom. Transport modules
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
`drum-step-<t>-<s>`, `sampler-step-<slot>-<s>`, `motion-step-<s>` (mini XY
pads) + `motion-view(-x|-y)`/`motion-graph`/`motion-assign-<x|y|reset>`/
`motion-xypad` (the Motion tab),
`<seq|drum|sampler>-vel/-gate/-prob/-ratchet-<n>/-tie` (the shared
`StepSettingsEditor` per-step edit row), `sampler-load/name/edit/file-<slot>`,
`bank-<seq|drum|sampler|motion>-<i>`/`bank-…-copy` (the per-machine `BankBar`,
via its `testidPrefix` opt), the Song panel's live FX (`perf-fill`/`perf-stutter`/
`perf-drop`/`perf-tapestop`, `perf-stutter-size-<n>`), the Song panel's per-lane
DJ mixer (`song-lane-<seq|drum|sampler>` cards, each with `switch-<lane>.mute`/
`switch-<lane>.solo` + a `knob-<lane>.master` mirroring the per-machine volume;
`song-lane-motion` carries chain controls + `switch-motion.mute` only — no solo/volume;
each card's title is a button `song-lane-title-<seq|drum|sampler|motion>` that opens
that machine's tab — see `specs/features/machine-status.md`),
`song-save`/`song-load`/…, `transport-play`, `preset-select`,
`sync-mode-<off|master|slave>`/`sync-status` (the Song panel's MIDI clock-sync
section), `seq-import-slot`/`seq-import-render` (the Sequencer tab's
"Import into sampler" resample section), `export-modal`/`export-kind-<json|project>`/
`export-project-note`/`export-fmt-<wav|mp3>`/`export-confirm`/`export-cancel`/
`song-share-link` (the Export chooser opened by `song-export`; `song-share-link`
is its Copy Link action), `song-export-audio`/`song-export-fmt-<wav|mp3>`/
`song-record` (the Song panel's Audio section — render/record the master bus)).
Prefer testids
over labels — capitalised button text collides with lowercase siblings under
Playwright's case-insensitive matching (the header `Play` vs the Arpeggiator's
`play`; the `Sampler` tab vs the Song panel's `sampler` lane). For state
assertions, `main.ts` exposes a **dev-only** bridge `window.__synth =
{ engine, bus, patterns, session, xy, patternUndo }` (gated on
`import.meta.env.DEV`, absent in
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
`mic`
(the record-sound modal — record from the fake device, edit, load into a slot),
`sync` (the Song panel's MIDI clock-sync section — presence + mode
persistence only, since headless Chromium has no MIDI ports; the timing math is
unit-tested under `tests/audio/transport/sync/`), `export-project` (the
Export chooser — disabled Project row on a fresh boot, and a full project-zip
export → New → re-import round-trip via `download.path()`; WAV-only, since CI
Chromium can't decode MP3), and `song-link` (share URLs — `#song=` payloads,
author-dialect and canonical, applied at boot with the hash cleared on success
and left intact on failure; Copy Link verified via the clipboard with a
Node-side `inflateRawSync` decode), and `motion` (the Motion tab — anchor
input on the mini pads, live param automation + baseline restore on stop via
`__synth.bus.get`, the Y/X view toggle re-projecting the graph, a
save→new→load round-trip, and the chain + Mute Song-panel card), and
`session` + `pattern-undo` (the safety net — autosave restore across
`page.reload()`, the `song-undo-toast` Undo after demo/New, and the
per-machine `undo-<seq|drum|sampler|motion>` buttons + tab-scoped Ctrl+Z).
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
                drumBus → drumComp → drumPhaser → drumDelay → drumReverb ─┤
     samplerBus → samplerDist → samplerPhaser → samplerDelay → samplerReverb ─┤
                                                          preMaster → djFilter → masterComp → analyser → master → destination
```

The analyser taps **pre-master** so the scope is independent of the volume
knob. The drum bus **and** the sampler bus join at `preMaster`, bypassing the
synth FX chain.

The three insert chains are built as units by `audio/effects/fx-chain.ts`
(`createSynthChain`/`createDrumChain`/`createSamplerChain`), held on Engine as
`synthFx`/`drumFx`/`samplerFx`. Each `FxChain` owns its effect order, its param
prefixes and (drum) the comp ratio table, exposing `fx` (named members —
`drumFx.fx.comp`), `tail` (last output; the bank-render tap), `wire(in, out)`
and `bind(bus)`. Three explicit factories, not one generic spec: only the synth
has a wah, only the drum bus heads with a compressor. `masterComp` stays a flat
Engine field (a master-bus insert, not a chain member), and `engine.drumComp` is
a getter onto `drumFx.fx.comp` — what `StudioApi` and the drum GR meter read.
Adding an effect means editing the chain factory, not Engine (see
`specs/recipes/add-an-effect.md`).

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
lamejs is 153 kB of pre-minified JS, so `encodeMp3` pulls it in with a
**dynamic `import()`** — it is `async` (`encodeWav` stays sync), ships as its
own `lamejs` chunk, and `main.ts` warms that chunk on `requestIdleCallback`
after boot so offline MP3 export still works under the precache-manifest-less
service worker. Any new statically-imported heavyweight belongs behind the same
pattern; see `specs/features/audio-export.md` REQ-7.
Each worklet chunk carries `f = currentFrame` (the absolute sample index);
`RecorderNode.firstFrame` records the capture's first tag, letting consumers
map a scheduled audio time to an exact offset in the captured stream.

**Render bank → sampler** ("Import into sampler", Sequencer tab) — resamples
the seq **edit bank** through the live synth + FX into a **bar-exact** buffer
and loads it into a sampler slot (layering without a second synth instance).
`BankRenderController` (`audio/recorder/bank-render.ts`) taps a second
`RecorderNode` off `reverb.output` (synth-only; drums/sampler keep playing but
are never captured), plays the bank **twice** and keeps bar 2 (tails bake into
the loop start), then crops by frame arithmetic — exact start via
`firstFrame`, exact length `round(16·sixteenthS·sampleRate)` (swing never
moves bar boundaries). Engine's `prepareBankRender()` closure forces seq
enabled/audible + the seq chain lane disabled (an enabled chain would switch
banks on pass 2) and restores from bus state after. Refused while the song
recorder captures or (in the UI) when the bank is empty / sync mode is
`slave`. See `specs/features/render-to-sampler.md`.

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

**Shared helpers** — pure, dependency-free, importable from any layer (they must
never import `audio/`, `state/` or `ui/`, so the audio layer can use them without
dragging in UI code): `utils/math.ts` (`clamp`/`clamp01`/`midiToHz`),
`utils/taper.ts` (`toNorm`/`fromNorm`), `utils/base64url.ts`
(`toBase64Url`/`fromBase64Url` — share links + WebRTC blobs),
`utils/listeners.ts` (`ListenerSet<Args>`: `add(fn) -> disposer` / `emit(...)`,
behind every `onStep`/`onNote`/`onFollowChange` hook), plus `utils/array.ts`,
`utils/compression.ts`, `utils/zip.ts`, `utils/wake-lock.ts`. Layer-specific
siblings: `bindBypassMix` (`audio/effects/effect.ts`), `forEachActiveHit`
(`audio/transport/step-hits.ts` — the drum/sampler lane sweep) and
`Performance.stepIndex` (`mapStep(step) % SEQ_LENGTH`; the **motion** machine
deliberately uses the raw `step % SEQ_LENGTH` so automation never follows
stutter remaps). Named localStorage slots (presets, songs) share
`state/slot-store.ts` (`SlotStore`); blank grids come from
`emptyPatternBanks()` (`state/patterns.ts`), which shares PatternStore's own
`make*Bank` builders. The four machine tabs share their chrome via
`ui/panels/step-panel-scaffold.ts` (`bankBarFor`, `wrapGridWithRestOverlay`,
`wirePlayhead`, `GridCursor`) plus `paintTriggerCell`
(`ui/components/step-settings.ts`); the seq panel keeps its own painter because
it also writes the note name as the label.

### Song mode

- **`PatternStore`** holds 4 banks per machine (seq / drum / sampler /
  motion). The UI edits the *edit bank* (`seq`/`drum`/… getters;
  `setSeqEditBank`/… re-emit every step so panels repaint). The transport
  reads the *play bank* (`seqBank(i)`/`drumBank(i)`/…) chosen by the
  Arrangement — which may differ.
- **Per-step settings** — every machine's step carries velocity/gate/prob/
  ratchet/tie (`StepSettings` in `state/patterns.ts`; `SeqStep` adds `note`,
  `DrumCell`/`SamplerStep` are the shared `TriggerCell`). The pure hit math
  (probability roll + ratchet sub-hit timing) is
  `audio/transport/step-hits.ts`, consumed by the seq/drum/sampler machines. The seq
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
- **`Arrangement`** (`audio/transport/arrangement.ts`) — four independent
  chain lanes (seq / drum / sampler / motion), each an ordered list of bank
  indices. Advances one slot per bar (`step % SEQ_LENGTH === 0`); a disabled
  lane's play bank tracks that machine's edit bank. Constructed **before** the
  machines so its `clock.onTick` runs first and play banks are settled before
  the machines read them on the same tick. Resets on `Clock.onStart`.
- **`Performance`** (`audio/transport/performance.ts`) — live DJ FX, owned by
  Engine. `mapStep()` (stutter) is consulted by both machines each tick;
  `fillActive` makes the drum machine play a roll; Filter Drop / manual DJ
  Filter drive `engine.djFilter` (a BiquadFilter inserted `preMaster →
  djFilter → analyser`); Tape Stop ramps `Clock` BPM + pitch-bend via rAF.
- **MIDI clock sync** (`audio/transport/sync/`) — master/slave transport sync
  between two instances (or hardware) over Web MIDI real-time messages
  (0xFA/0xFB/0xFC/0xF8 @ 24 PPQN). `SyncController` (on `Engine.sync` +
  `StudioApi`) owns the mode — `off|master|slave`, device-scoped under
  `localStorage['websynth.midisync']` (perf-mode precedent, **not** a bus
  param) — and gates everything. The core is transport-agnostic
  (`SyncTransport` interface; `MidiSyncTransport` is the Web MIDI impl, fed
  real-time bytes by `midi.ts`, which stays sole owner of `MIDIAccess`).
  Master hooks `clock.onStart/onStop/onTick` and schedules 12 timestamped
  pulses per *even* 16th (unswung grid — MIDI clock is straight). Slave
  estimates BPM (`PulseBpmEstimator`, 24-interval window + EMA), writes
  `clock.setBpm` directly (never the bus; engine's `transport.bpm`
  subscription is gated while slaved), and phase-corrects via `Clock.nudge`
  (≤±10 ms, ≤1/beat). UI: the Song panel's Sync section
  (`ui/components/sync-section.ts`). See `specs/features/midi-clock-sync.md`.
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
  live in `SamplerMachine`; only filenames (`patterns.sampleNames`) persist in a
  song — after a `.json` import the user re-loads the files (`.needs-reload`
  label hint), while a **project-zip** import repopulates the buffers directly
  (see *Project export*). Slots are filled by **Load** (WAV/MP3 file) or the
  record-sound modal (mic-record or re-edit a loaded buffer; see *Sample
  recorder/editor*).
- **Motion sequencer** (`specs/features/motion-sequencer.md`) — the 4th
  machine (tab between Sampler and Song): 4 banks × 16 steps of optional XY
  anchors (`MotionStep {on,x,y}`, normalized taper space) that drive the XY
  Pad's two assigned params during playback. `MotionMachine`
  (`audio/transport/motion-machine.ts`) evaluates the pure curve math
  (`motion-curve.ts` — slide = linear breakpoints across gaps + last→first
  wrap; step = jump-and-hold) on a perf-fps-throttled rAF loop against the
  audio clock's *now* (tick `when`s are scheduled ahead), writing via
  `bus.set` with taper-correct `fromNorm` (`utils/taper.ts` — shared by the UI
  knob/XY-pad and the audio layer). Baseline discipline: first
  write per param records its prior value; stop / `motion.on→0` /
  `motion.mute→1` restores all.
  Per-bank axis override `motionAssigns` falls back per-axis to `XyPadStore`.
  Not an audio lane: no LaneMixer/audibleLanes entry; its Song-panel card is
  chain + Mute (`buildChainLane` `{mixer:'mute'}` — no solo/volume). The panel
  graph is mode-aware (`ui/components/motion-graph.ts`: slide = anchor
  polyline, step = wrap-aware staircase). Params: `motion.on`, `motion.mute`,
  `motion.slide` (0=step 1=slide).
- **`Song`** (`state/song.ts`) — `capture`/`apply` a full song (`bus.snapshot`
  + all banks + all four chains). `SongFile` is now `version: 1 | 2 | 3 | 4`;
  v2 adds optional `samplerBanks`/`samplerChain`/`sampleNames`, v3 the optional
  `xy` axis assignment (XY Pad), v4 the optional
  `motionBanks`/`motionAssigns`/`motionChain` (motion sequencer). `fromJSON` is
  unchanged and accepts all versions; v1 files (incl. `DEMO_SONGS`) load with
  empty sampler state and default XY axes. JSON file export/import **and** localStorage slots under
  `websynth.song.*`. Demos (`DEMO_SONGS`) are the two hand-authored `SongFile`
  literals (Zombie Nation, I Feel Love) **plus** any `*.json` SongFile dropped
  into `src/state/demos/` (14 today), auto-registered at build time
  via an `import.meta.glob` (keyed by the file's `name`). Drop-ins are spread
  *before* the built-ins, so they lead the demo button row (`Object.keys` order).
  A `*.websynth.zip` project in `src/state/demos/` registers too (`ZIP_DEMOS`,
  a `?url` glob — fetched on click, not bundled; 1 today); `Song.list()`/`loadSlot()`
  stay sync + JSON-only, and `loadDemo` delegates zip demos fire-and-forget.
- **Project export** (`state/project.ts` + `utils/zip.ts`/`utils/compression.ts`,
  see `specs/features/project-export.md`) — Export opens a modal
  (`ui/components/export-song-modal.ts`): **Song (.json)** (default, unchanged)
  or **Project (.zip)** — `<name>.websynth.zip` containing the canonical compact
  `song.json` (format untouched — the current canonical version; the zip is
  just a container) plus one `samples/<slot>-<name>.<ext>`
  clip per loaded sampler slot (WAV default / MP3; the extension derives from
  the encoded blob's MIME type — `encodeMp3` falls back to WAV at unsupported
  rates). `encodeClip` is `async` because `encodeMp3` is.
  The zip codec is hand-written and dependency-free (ADR-003): writes
  stored audio + deflated json, reads methods 0+8 with EOCD backward scan and
  CRC checks, and tolerates hand-re-zipped archives (folder nesting, PowerShell's
  backslash separators). Import sniffs PK magic bytes (extension fallback) on
  the one `song-import` button; clips decode **sequentially** and a failed clip
  never aborts the apply (the slot just keeps `.needs-reload`). Gotcha:
  `decodeAudioData` **detaches** its buffer and clip bytes are subarray views of
  the whole zip — always pass `clip.data.slice().buffer`. Save slots stay
  JSON-only (a zip can't live in localStorage).
- **Authoring dialect** (`state/song-author.ts`, ADR-013,
  `specs/features/song-authoring-dialect.md`) — a compact **input-only** song
  format (`format: "websynth-song-author"`) any LLM can emit in ~40 lines:
  positional note lists (`"A2"`, `null` = rest, C4 = 60), drum/sampler hit
  lists keyed by track name (`kick`/`chat`/`s1`…), chain strings (`"AABA"`,
  `.`/`-` = rest). `Song.parse` detects it (`isAuthorSong`) and expands it
  (`expandAuthorSong`) into a canonical file (v3; v4 with motion content)
  before `validateSongFile`, so
  **every** import surface accepts it; nothing ever exports it. The module is
  pure and must never import `song.ts` (its `import.meta.glob` would poison the
  MCP bundle) — same rule for `state/authoring-guide.ts`, which builds the ✨
  AI Prompt text (`buildSongPrompt`, re-exported by `ui/components/ai-prompt.ts`)
  and the MCP `get_song_format` guide (`buildAuthoringGuide`). Both schemas are
  published under `public/schema/` (`websynth-song.schema.json` +
  `websynth-song-author.schema.json`); `public/llms.txt` points crawling agents
  at them. Format changes must touch dialect + author schema + guide (see
  `specs/recipes/evolve-the-song-format.md`).
- **Share links** (`state/song-link.ts`, `specs/features/song-share-link.md`) —
  `#song=<deflate-raw+base64url>` (or `'j:'+base64url` where Compression
  Streams are missing) embeds a song in the URL hash; `#songUrl=<https url>`
  fetches one. A boot hook in `main.ts` (next to launchQueue) funnels both
  through `UiBridge.importSongBytes` → `SongPanel.importBytes` (which resolves
  to a success boolean); the hash is cleared via `history.replaceState` **only
  on success**. The export modal's **Copy Link** (testid `song-share-link`)
  builds the URL via `Song.capture` → `encodeSongPayload` → `buildShareUrl`.
- **MCP server** (`scripts/mcp/`, `specs/features/mcp-server.md`) — zero-dep
  stdio JSON-RPC 2.0 server (newline-delimited frames; stdout is protocol-pure,
  logs on stderr). Registered by the committed `.mcp.json`. Self-builds a Vite
  lib bundle of the pure song core (`song-core-entry.ts` →
  `scripts/mcp/dist/song-core.mjs`, gitignored) when missing/stale. Tools:
  `get_song_format`, `validate_song` (a failed validation is a *successful*
  call returning `{ok:false, errors}`), `expand_song`, `save_song`,
  `make_share_link` (`WEBSYNTH_BASE_URL`, default `http://localhost:5173`).
  `rpc.mjs`/`tools.mjs` are pure (core injected) and unit-tested under
  `tests/mcp/` alongside a spawn-the-server stdio integration test.
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
  voices are created. The node is **mono** (the voice path is mono until the
  FX/panners) and **idle-gated**: an active flag posted over the worklet port
  sleeps the per-sample DSP while the voice is silent — voices boot inactive,
  `noteOn` activates unconditionally (a lost deactivate can only cost CPU,
  never a note), release-completion/`kill` deactivate. Any step is masked by
  the closed downstream amp VCA. See `specs/features/ladder-filter.md`
  REQ-9/REQ-10.
- **The transport clock's wakeup timer runs in a Worker**
  (`audio/transport/tick-timer.ts` + `clock-timer-worker.ts`, Vite-bundled via
  `new URL`) so the look-ahead survives main-thread jank and background-tab
  timer throttling; the scheduling logic itself stays on the main thread.
  `TimeoutTimer` is the no-`Worker` fallback and the unit-test double (jsdom
  has no `Worker`). `Clock` takes `{ timer?, scheduleAheadS? }` opts.
- **Bypassed effects are truly disconnected** (ADR-012): `BypassWrapper` keeps
  the click-free dry/wet crossfade but, 150 ms after bypassing, disconnects
  its own two edges (`input → processedIn`, `processedOut → wet`) so the
  processed subgraph (convolver/shaper/worklet…) stops being rendered;
  un-bypass reconnects *before* ramping. Effects must wire their DSP
  `processedIn → … → processedOut` (they all do) — never straight into `wet`.
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
- **Performance mode** (`state/perf-mode.ts`) — a device-scoped quality setting in
  three tiers (`weak`/`medium`/`strong`, plus `auto`), persisted under `websynth.perf`,
  **not** a `ParamBus` param (so it never enters presets/songs). `PERF_PROFILES` is the
  single source of truth mapping each tier to
  `{ latencyHint, voiceCount, fps, scheduleAheadS, reverbIrMaxS, fxOversample,
  analyserFftSize }`:
  weak = `'playback'`/5/15 + 0.2 s look-ahead, 1.5 s IR cap, no oversampling;
  medium = `'interactive'`/8/30, strong = `'interactive'`/8/60 (both full-cost:
  0.1 s look-ahead, 4 s IRs, oversampling on — so they still share one audio profile).
  `detectTier()` errs toward `medium` (only genuinely low signals → weak, clearly
  high-end non-phones → strong); `resolveTier(pref)` resolves `auto` via detection.
  `main.ts` reads `PERF_PROFILES[resolveTier()]` at boot for the audio fields
  (all boot-time knobs — buffer, voices, look-ahead, IR cap, oversampling — are fixed
  when the `AudioContext`/graph are built → a change across an *audio* boundary
  applies on **reload**); the two scope knobs — **`fps` and `analyserFftSize` — are
  applied live** (`Scope({ fps })` + `setFps`/`setFftSize`, wired through a
  late-bound hook in `app.ts`), so both are excluded from `sameAudioProfile`. The canvas drop-shadow is dropped for all
  tiers. The header "Perf" button is colour-coded by resolved tier (red/amber/green) and
  its modal shows a reload nudge only when the choice crosses an audio boundary
  (`sameAudioProfile`, which compares every boot-time field). The About → Debug panel
  surfaces `perfDiagnostics()` (tier, cores, memory, mobile, and the full profile incl.
  lookahead/IR cap/oversample). See `specs/features/performance-mode.md`.
- Dialogs use the shared **`Modal`** (`ui/components/modal.ts`), extracted
  from the previously-duplicated about/start-modal pattern (`.about-backdrop`/
  `.about` CSS, Escape captured to beat the panic handler, backdrop-click +
  fade close). `about.ts` and the start modal were intentionally left as-is.
- Mic capture needs a **secure context**. `npm run dev` (`vite --host`)
  serves the LAN over plain HTTP, so recording from a phone/other device is
  blocked by the browser — the modal shows a clear message; it works from
  `http://localhost`.
- **PWA / installed app** (`specs/features/pwa-install.md`) — the service
  worker (`public/sw.js`, hand-written, no workbox) is registered
  **production-only** as `/sw.js?v=<version>`; never register it on the dev
  server (it poisons HMR — unregister via DevTools if you did). Cache-first
  for hashed `/assets/*`, network-first elsewhere; offline works after the
  first revisit. The screen wake lock (`utils/wake-lock.ts`) follows
  `engine.ctx` state (running ⇒ held), wired in `main.ts`. The header
  fullscreen button renders only where `document.fullscreenEnabled` (not on
  iPhone). OS-launched song files (`file_handlers` + `window.launchQueue`)
  flow through `UiBridge.importSongBytes` → `SongPanel.importBytes` →
  `parseSongOrProject` (the same path as the Import button). PNG icons are
  generated by `node scripts/generate-icons.mjs` (Playwright Chromium
  rasterizes `favicon.svg`) and committed. `IosAudioSession.unlock()` also
  sets `navigator.audioSession.type = 'playback'` (Safari 17+, mute-switch
  fix — additive to the silent loop).
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
  - Step buttons (seq/drum/sampler) visualize per-step settings via `StepButton.setViz()`: a lazily-created `.fill` layer driven by inline custom props (`--sb-gate` width, `--sb-vel` brightness, `--sb-ratchet` top ticks) plus `tie`/`prob`/`ratchet` classes; the label lives in a `.label` span so `setLabel` can't wipe the layer. `.red .fill` keeps the drum/sampler beat columns red when lit; `.drum-cell.tie .fill` shortens the tie bridge to the drum grid's 3px gap.
  - The drum module's `.cells` uses `display: grid; grid-template-columns: repeat(16, 1fr); gap: 3px` — both `drum-panel.ts` and `sampler-panel.ts` import this via `drumStyles.cells`.
  - Sampler action buttons (`.load`, `.edit`, `.rec`) need full base button styling (background, border, border-radius, cursor, font-family, box-shadow, transition) in their module class — they are standalone classes with no shared base class to inherit from.
  - Panel builder functions must explicitly `appendChild` every sub-container to the root element. Orphaned DOM subtrees (built but never appended) are a common source of blank panels — previously tripped on `drum-panel.ts` where the grid was constructed but `root.appendChild(grid)` was missing.
- Demo-song riffs aim to be *recognisable*, not note-perfect transcriptions.

## Branding

The product is presented in-app as **"VAST G1-J5"**; the package/repo name is
`websynth`. Both refer to the same thing.
