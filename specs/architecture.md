# Architecture — VAST G1-J8

```yaml
id: architecture
status: implemented
version: 6   # v6: the audio graph gains a duck stage on the synth and sampler
             #     chains, keyed by drum hits (sidechain-ducking.md)
             # v5: websynth.ui.scope.height joins the persistence keys (scope.md REQ-20)
             # v4: UiBridge in the layer contracts; testids/write-a-test delegation
owner: core
related: []
source:
  - src/main.ts
  - src/state/params.ts
  - src/audio/engine.ts
  - src/state/patterns.ts
  - src/state/song.ts
```

The system-wide source of truth. Read this before any feature spec — the feature
specs assume the contracts and conventions defined here.

## Background / Why

VAST G1-J8 is a polyphonic Web Audio synthesizer (+ drum machine + sampler +
motion sequencer for param automation) in **vanilla TypeScript**. There is **no UI framework and zero runtime
dependencies**; build tooling is Vite + `tsc` only. The only third-party
runtime code is three **vendored** (not npm) libraries under `src/vendor/` —
the MIT `lamejs` MP3 encoder (`lamejs/`), the MIT `qrcode-generator` QR
*encoder* (`qr/`, WiFi-sync pairing) and the Apache-2.0 `jsQR` QR *decoder*
(`jsqr/`, WiFi-sync scan fallback) — see
[ADR-003](decisions/adr-003-no-runtime-dependencies.md).

The defining design choice is a hard separation between UI and audio: **they never
call each other directly.** All scalar state flows through one bus (`ParamBus`),
which both the UI (writers) and the `Engine` (readers/appliers) talk to. This keeps
the audio graph testable, makes presets/songs a trivial snapshot of the bus, and
means a UI control and its audio effect can be reasoned about independently.

## Requirements (system invariants)

- **REQ-1** — UI components write parameters via `bus.set(...)`; the `Engine`
  reads them via `bus.subscribe(...)`. No direct UI↔audio calls.
- **REQ-2** — Every scalar parameter is registered exactly once in
  `registerDefaults()` with `min/max/default` (and optional `taper`/`format`).
- **REQ-3** — Audio cannot start without a user gesture. The graph *is* built at
  boot — `boot()` runs `new Engine(bus, …)` + `await engine.init()` before any
  input — but on an `AudioContext` created **suspended**, so nothing sounds. Only
  `await engine.resume()` runs inside the "Tap to start" handler in `main.ts`;
  that call is what the gesture unlocks (see `features/audio-lifecycle.md`).
- **REQ-4** — New parameters default to a **no-op** value, so existing
  presets/songs are unaffected (see Conventions).
- **REQ-5** — Non-scalar state (step grids) lives in `PatternStore`, not the bus.

## Tech stack

```yaml
language: TypeScript            # ^7.0.2, strict + noUncheckedIndexedAccess
build:      Vite                # ^8.2.1   (vite build) + tsc --noEmit
unit_tests: Vitest              # ^4.1.10  (jsdom env)
e2e_tests:  "@playwright/test"  # ^1.62.1  (headless Chromium)
dom_env:    jsdom               # ^30.0.1  (unit-test DOM)
runtime_deps: none              # zero — no `dependencies` block in package.json
vendored:                       # NOT npm dependencies — see ADR-003
  lamejs: src/vendor/lamejs/    # MIT MP3 encoder (audio export)
  qr:     src/vendor/qr/        # MIT qrcode-generator, QR encoder (WiFi-sync pairing)
  jsqr:   src/vendor/jsqr/      # Apache-2.0 jsQR, QR decoder (WiFi-sync scan fallback)
release: scripts/release.mjs    # zero-dep bump+build+zip; see DEPLOYMENT.md
commands:
  dev: vite --host
  build: tsc --noEmit && vite build
  typecheck: tsc --noEmit       # primary check
  test: vitest run
  e2e: playwright test
```

## Technical design

### The two long-lived objects

Created once in `main.ts` and threaded everywhere:

- **`ParamBus`** (`src/state/params.ts`) — single source of truth for every scalar
  parameter.
- **`Engine`** (`src/audio/engine.ts`) — owns the `AudioContext`, the 8-voice pool,
  the FX chain, and the transport modules.

Non-scalar state lives in **`PatternStore`** (`src/state/patterns.ts`).

### Module dependency graph

*Who owns and depends on whom* — module ownership + data-flow direction (distinct
from the signal-flow **audio graph** below, which is audio routing). The spine is
the UI/audio separation (REQ-1): the UI writes state, the `Engine` reads it; they
never call each other directly.

```
   UI  (ui/app.ts · panels · components)
    │
    │  writes: bus.set(id, v) · patterns.*       (UI writes params via the bus, not the Engine)
    ▼
   ParamBus (scalars) ◄─── Song.capture/restore ───► PatternStore (step grids)
    │
    │  Engine.subscribe(...) · bus.onNote      (+ Transport reads PatternStore grids)
    ▼
   Engine  (owns the AudioContext)
    ├─ Voices      — 8-voice pool
    ├─ FX          — insert chain + drum/master compressors
    ├─ Transport   — Clock, Arrangement, Performance, Sequencer,
    │                DrumMachine, SamplerMachine, MotionMachine, Arpeggiator
    ├─ Sync        — SyncController (+ MidiSyncTransport / WebRtcSyncTransport)
    └─ Recorder    — RecorderController (audio export), taps master
```

`main.ts` constructs `ParamBus` then `Engine(bus)` and threads both everywhere;
`Song` is the only thing that snapshots `ParamBus` **and** `PatternStore` together.

For **non-param** interactions (transport, pattern grids, recorder, GR meters,
sample decode) the UI does not get the whole `Engine` — it depends on the narrow
**`StudioApi`** facade (`src/ui/studio-api.ts`), which exposes only the curated
collaborators and hides Engine's internals (voices, LFO, `Polyphony`, `LaneMixer`,
the bus nodes, `subscribeParams`). `Engine` satisfies it **structurally**; see
[ADR-009](decisions/adr-009-ui-depends-on-studio-api-facade.md).

### Layer contracts (public surfaces)

```yaml
ParamBus:        # src/state/params.ts
  set(id, value, silent?)        # clamps to [min,max]; notifies subscribers
  get(id)                        # current value (or default)
  def(id)                        # the ParamDef
  subscribe(id, fn) -> unsub     # fires immediately with current value
  onChange(fn)                   # global "an edit happened" signal
  withoutChangeSignal(fn)        # run fn with onChange suppressed — the machine is
                                 #   writing, not the user (motion automation, tape
                                 #   stop). Per-param listeners still fire.
  snapshot() / restore(snap)     # bulk save/load (restore suppresses onChange)
  resetDefaults()                # every param back to default
  onNote / noteOn / noteOff      # note event path

Engine:          # src/audio/engine.ts
  init()                         # async: loads worklets, builds voices + transport
  subscribeParams()              # wires params to the audio graph (once); FX/comps
                                 #   self-wire via Effect.bind(bus, prefix) — ADR-008
  playNote / releaseNote         # thin delegators to Polyphony (SynthOutput surface)
  # owns: AudioContext, voices[8], FX chain, arrangement, perf, seq, drums, sampler, motion
  # delegates: Polyphony (voice alloc + unison/glide/drift), LaneMixer (mute/solo/vol)

StudioApi:       # src/ui/studio-api.ts  (the UI's narrow view of Engine — ADR-009)
  # patterns, arrangement, clock, perf, seq, drums, sampler, motion, recorder,
  # bankRender, sync, rtcSync, analyser, analyserL, analyserR, ctx, drumComp,
  # masterComp, iosAudio + panic()/resume().
  # Engine satisfies it structurally;
  # UI signatures take StudioApi so Engine internals stay invisible to the UI.

UiBridge:        # src/ui/ui-bridge.ts  (the UI's *internal* seam — see features/input-control.md)
  # A bag of late-bound no-op callbacks, created in main.ts and threaded through
  # the UI. Whoever owns a surface assigns the callback when it builds that
  # surface; whoever needs to drive it calls through the bridge. This is how one
  # UI region reaches another WITHOUT importing it (shortcuts.ts never imports
  # onboarding; the Song panel never imports the header's TabContainer).
  pressKey / releaseKey          # visual-only keyboard highlight (no bus call)
  toggleTransport                # clicks the real header Play button, keeping its visuals in sync
  showTab(id)                    # reveal a pattern-row tab   (machine-status.md)
  toggleInfoBadges / cuePlay     # onboarding.md · play-button-blink.md
  toggleRecordWindow             # Shift+R                    (record-window.md)
  undoActiveMachine / clearSelectedStep -> boolean  # tab-scoped keys; false ⇒ key falls through
  importSongBytes(bytes, name) -> Promise<boolean>  # OS file launch + share link -> SongPanel.importBytes
  openPresetImport(parse)        # paste door -> the header-owned preset wizard

PatternStore:    # src/state/patterns.ts
  # 4 seq + 4 drum + 4 sampler + 4 motion banks; edit-bank (UI) vs play-bank (transport)
  snapshot() / restore(...)

Song:            # src/state/song.ts
  capture / apply / toJSON / fromJSON / download / readFile
  list / saveSlot / loadSlot / deleteSlot

Arrangement / Performance:  # src/audio/transport/
  # chain lanes (seq/drum/sampler/motion) and live DJ FX, respectively
```

### Shared utilities

Pure, dependency-free helpers under `src/utils/` — importable from **any** layer
(they must never import from `audio/`, `state/` or `ui/`, so the audio layer can
use them without dragging in UI code). Each replaced a helper that had been
copy-pasted across modules.

```yaml
utils/math.ts:       clamp(v,min,max) · clamp01(v) · midiToHz(note)   # A4 = 69 = 440 Hz
utils/taper.ts:      toNorm(def,v) · fromNorm(def,n)                  # param taper mapping
utils/base64url.ts:  toBase64Url(bytes) · fromBase64Url(s)            # RFC 4648 §5, unpadded
utils/array.ts:      assertIndex(arr,i,name) · IndexError
utils/compression.ts: deflateRaw / inflateRaw                          # zip codec + share links
utils/zip.ts:        the hand-written zip reader/writer (ADR-003)
utils/wake-lock.ts:  screen wake lock, follows engine.ctx state
utils/listeners.ts:  ListenerSet<Args> — add(fn) -> disposer · emit(...args)
```

Audio-side, `audio/param-utils.ts` holds the smoothing vocabulary every
`AudioParam` write shares: `rampTo(param, value, ctx, tau)` /
`rampCancelAndSet(...)` over the four named time constants — `RAMP_FAST` 5 ms,
`RAMP_MEDIUM` 10 ms, `RAMP_SMOOTH` 20 ms (the insert effects' own controls, which
zipper audibly at anything shorter), `RAMP_SLOW` 50 ms. These are dialled by ear
under ADR-010, so they are named in one place rather than spelled as literals at
the call site.

`ListenerSet` backs every `onStep`/`onNote`/`onFollowChange` hook (the four
transport machines and `BankBar`), which had each open-coded the same
`Set` + `add → return () => delete` pair.

The four machine tabs share their **chrome** through
`ui/panels/step-panel-scaffold.ts` — composable helpers, not one template, since
the panel bodies genuinely differ (note labels, a tuning strip, slot loaders, an
SVG graph). One internal `laneHooks(engine, lane)` switch maps the systematic
per-lane accessor families (PatternStore edit/copy/content, Arrangement play
bank, the machine's `onStep`), and the exported helpers read from it:
`bankBarFor` (the A/B/C/D bar, `testidPrefix` = lane), `wrapGridWithRestOverlay`
(the `position: relative` wrapper + overlay + follow wiring),
`wirePlayhead` (highlight only while edit bank === play bank, refreshing the
overlay on the same tick — and only while the panel's `VisibilityGate` reports it
on screen, re-syncing to the current step on reveal), `VisibilityGate` itself
(inactive tabs stay mounted, so `app.ts` drives every panel's gate from one
`tabs.onViewChange`) and `GridCursor` (the drum/sampler 2-D selection
cursor). `paintTriggerCell` lives with `stepTitle` in
`ui/components/step-settings.ts`; the seq panel keeps its own painter because it
also writes the note name as the button label. Every `data-testid` is unchanged.

The transport machines additionally share three helpers:
`forEachActiveHit(bank, idx, when, stepDur, muted, fire)`
(`audio/transport/step-hits.ts`) — the one-shot lane sweep (skip muted, skip
off, roll `prob`, expand ratchets) used by the drum machine and the sampler;
`Performance.stepIndex(step, cells, rateIdx)` = `cellIndex(mapStep(step), …)`,
read by the seq/drum/sampler machines; and **`LaneMeter`**
(`audio/transport/lane-meter.ts`), which each of the four machines owns as
`.lane` and asks `forEachHit(step, when, fn)` — usually one cell per tick, none
on a tick a coarser lane skips, two or three inside one tick for a rate finer
than a 16th ([features/meter.md](features/meter.md)). The **motion** machine
builds its `LaneMeter` with no stutter map: automation must not follow stutter
remaps.

**A bar is `barTicks`, not 16.** `SEQ_LENGTH` used to mean cells-per-pattern,
ticks-per-bar and columns-of-UI at once; `state/meter.ts` names the three apart
(`GRID_CELLS`, `barTicks()`, `LANE_RATES`) and `SEQ_LENGTH` is now just an alias
of the first. New code says which one it means — and in the UI goes through
`ui/lane-grid.ts`, so a grid, its ruler and its beat accents cannot disagree.
See [ADR-019](decisions/adr-019-the-bar-is-a-tick-count.md).

Insert effects additionally share `bindBypassMix(bus, prefix, fx)`
(`audio/effects/effect.ts`) — the `${prefix}.on` → `setBypass` and
`${prefix}.mix` → `setMix` subscriptions every `Effect.bind` opened by hand.
`Compressor.bind` calls it too, for the `.on` half alone: it defines no `setMix`,
and that absence is exactly how the helper knows not to subscribe a `.mix` param
the compressors and the wah do not have.

All six insert effects extend **`WrappedEffect`** (`audio/effects/effect.ts`),
which owns the `BypassWrapper`, publishes its `input`/`output` as the `Effect`
surface and delegates `setBypass`. A subclass is then only its DSP span plus its
`bind`; `Compressor` overrides `setBypass` to also clear its GR meter.
`setMix` stays off the base deliberately — see effects.md REQ-1.

Their **params** come from one factory per shared effect in
`state/params.ts` (`distParams`, `phaserParams`, `delayParams`, `reverbParams`,
over `fxOnParam`), instantiated per prefix, so the three chains cannot drift into
three different delays. Per-chain defaults are arguments, not copies. The wah and
the compressors stay longhand — each appears once. `npm run check:params` is the
gate: `public/params.json` and `public/params.md` must regenerate byte-identical.

The four payload validators share `state/validate-utils.ts`
(`isObject`, `describeValue`, `MAX_ERRORS`, `AddError`) — `isObject` is a
security predicate under ADR-015, and it had four copies. `checkUnit` /
`checkRatchet` keep one copy each in `song-validate.ts` and `song-author.ts`:
same names, different signatures, because the canonical validator refuses what
the dialect coerces (ADR-013).

### Event flow / propagation

The dependency graph above is the *static* view (who owns whom). This is the
*dynamic* view — **what fires what, and in what order**. The forward param path
is the obvious half; the **reverse (repaint) path and the bulk-load suppression
are where the subtlety lives**, so they're spelled out here.

**Two notification channels** (both on `ParamBus`):

- `subscribe(id, fn)` — **per-param**. Fires immediately with the current value,
  then on every non-`silent` `set(id, …)`. This is the **convergence point**:
  the `Engine`'s audio appliers (`subscribeParams` / `Effect.bind`) *and* every
  UI control (`knob`, `switch`, `segmented`, `strip`, `param-dropdown`) register
  here. One channel drives **both** audio and visuals, and neither side knows
  about the other (REQ-1).
- `onChange(id, v)` — **global** "an edit happened" signal, meaning *the user
  changed the sound*. Two consumers: `main.ts` → `session.markDirty()` (the active
  preset becomes dirty) and `SessionAutosave` (arms its debounced capture).
  Suppressed via a `suppressChange` counter during bulk applies (flow 2 below) and,
  through the public `withoutChangeSignal(fn)`, while a **machine** writes params
  (flow 4). Both consumers act on user intent, so a write neither consumer should
  see must be suppressed at the writer — only the writer knows whose write it is.

**1 — Live edit** (forward + repaint; the common case)

```
knob drag ─→ bus.set(id, v)
               ├─ per-param listeners ─┬─→ Engine applier ─→ audio graph update
               │                       └─→ bound controls re-render (the editing
               │                            control + any other UI bound to id)
               └─ onChange(id) ─→ session.markDirty()   (preset now dirty)
```

**2 — Song / preset load** (bulk apply) — `Song.apply`:

```
Song.apply ─→ bus.resetDefaults()      (clear stale params; onChange suppressed)
          ─→ bus.restore(file.params)  (per-param listeners FIRE → audio + UI
          │                              repaint; onChange SUPPRESSED → not an edit)
          ─→ patterns.restore(...)     (re-emits every step → panels repaint)
          ─→ arr.set{Seq,Drum,Sampler}Chain → arrangement.onChange → chain panels
```

The load-bearing move: `restore()` is **not** `silent`, so per-param listeners
fire and the UI repaints through the *same* `subscribe` channel as a live edit —
there is **no explicit "repaint the UI" call anywhere**. Only the global
`onChange` is gated, so loading a song isn't seen as an edit. (`resetDefaults`
runs first to make the apply *authoritative*: a param absent from the file snaps
back to its default instead of lingering from the previous patch — see REQ-4 /
[ADR-006](decisions/adr-006-no-op-param-defaults.md).)

**3 — Note trigger**

```
bus.onNote ─→ Engine.playNote / releaseNote ─→ Polyphony
   (unless passthroughSuppressed — then the arpeggiator/sequencer own triggering)
```

The arp sets `passthroughSuppressed` when it takes ownership of held notes, so
raw key passthrough is gated while it (or the sequencer) drives the voices.

**4 — Machine automation** (the motion sequencer; Tape Stop's ramp is the same
shape)

```
frame loop ─→ bus.withoutChangeSignal(() =>
                 bus.set(id, v))
               ├─ per-param listeners ─┬─→ Engine applier ─→ audio graph update
               │                       └─→ the bound knob / XY dot moves
               └─ onChange  ✗ SUPPRESSED — the machine wrote this, not the user
```

Structurally flow 1 with the global signal withheld, and the distinction is not
cosmetic: this path runs **up to 60×/s for as long as the transport plays**, so
letting it reach `onChange` re-armed the session-autosave debounce faster than it
could ever elapse — the session was never written at all — and marked the patch
dirty just for pressing Play. Contrast the XY Pad's spring-back ramp, which also
writes per frame but *is* a user gesture and stays on flow 1. See
[runtime-performance](features/runtime-performance.md) REQ-5.

**Ordering that matters**: `Arrangement` is constructed **before** the
sequencer/drum/sampler/motion machines in `Engine.init()`, so its `clock.onTick`
runs first and the **play banks are settled before the machines read them on the
same tick**. And transport modules are built **after** the voices so they can call
back into the engine.

### Audio graph (system diagram)

```
voices ─→ voiceBus ─→ distortion → wah → phaser → delay → reverb → duck → synthPan ─┐
            drumBus ─→ drumComp → drumPhaser → drumDelay → drumReverb ─────────────┤
            samplerBus  (+ sampler dist/phaser/delay/reverb/duck) ────────────────┤
                                                                                   ▼
        preMaster ─→ djLow ─→ djHigh ─→ masterComp ─→ analyser ─→ master ─→ destination
```

- The **drum bus and the sampler bus join at `preMaster`**, bypassing the synth FX
  chain.
- `synthPan` is the synth channel's auto-panner, swept by the LFO's `pan`
  destination and centred (a no-op) otherwise. It is deliberately the **last**
  synth stage so that nothing upstream of it pays for two channels it does not
  need: the voice path is mono end to end (mono oscillators/noise → gains →
  1-channel filter worklet → gains), and the insert chain stays 1-channel through
  `dist → wah → phaser → delay`. The **reverb**, last in the chain, is where the
  synth channel actually becomes stereo — its impulse response is a 2-channel
  buffer whose channels are independently randomised and phase-offset, so a
  1-channel input convolves to two decorrelated ones. That is generated stereo,
  not a speaker up-mix; a speaker up-mix (L = R) is what the drum panners and the
  2-channel compressors do to a mono input (ADR-010; see
  [`features/lfo.md`](features/lfo.md) REQ-4). The bank-render tap
  ([`features/render-to-sampler.md`](features/render-to-sampler.md)) sits after
  it, so a rendered bank captures the pan movement.
- The **analyser taps pre-master**, so the scope is independent of the master
  volume knob. The tap is a lossless `splitter → analyserL/analyserR → merger →
  analyser` so the scope can also show per-channel L/R (see
  [`features/scope.md`](features/scope.md)).
- `drumComp` is a **FET**-mode compressor; `masterComp` is a **VCA**-mode
  compressor (see [`features/compressor.md`](features/compressor.md)).
- The **duck** is the one chain member driven from outside its own chain: its
  gain envelope is scheduled from `DrumMachine.onHit`, at the absolute time each
  drum hit will sound, so the synth and sampler buses move out of the drums' way
  with no audio detector anywhere. `Engine.init()` wires that trigger — the
  chains are built in the constructor, the machines are not. The drum bus has no
  ducker: its own hits are the key. See
  [`features/sidechain-ducking.md`](features/sidechain-ducking.md).

The three insert chains are built as units by `audio/effects/fx-chain.ts` —
`createSynthChain` / `createDrumChain` / `createSamplerChain`, held on Engine as
`synthFx` / `drumFx` / `samplerFx`. Each `FxChain` owns its effect **order**, its
param **prefixes** and (for the drum comp) its **ratio table**, and exposes
`fx` (named members, e.g. `drumFx.fx.comp`), `tail` (the last effect's output —
the bank-render tap point), `wire(input, output)` and `bind(bus)`. They are three
explicit factories rather than one generic spec because the chains are alike but
not identical: only the synth has a wah, only the drum bus heads with a
compressor. `masterComp` stays a flat Engine field — it is a master-bus insert
(`djLow → djHigh → masterComp → analyser`), not a chain member — and `Engine.drumComp`
remains available as a getter onto `drumFx.fx.comp`, which is what `StudioApi`
and the drum panel's GR meter read.

### State model (the "schemas")

```yaml
ParamDef:                # the scalar "schema" — src/state/params.ts
  id: string
  min: number
  max: number
  default: number
  step?: number
  taper?: linear | exp | power | discrete
  curve?: number         # exponent for the power taper (see ladder-filter.md)
  unit?: string
  format?: (v) => string
  labels?: string[]      # for discrete params

PatternStore step types: # src/state/patterns.ts
  StepSettings: { velocity, gate, prob, ratchet, tie, micro }   # micro: step-settings.md REQ-6
  SeqStep:     StepSettings + { on, note }
  TriggerCell: StepSettings + { on }   # DrumCell / SamplerStep
```

`SongFile` (the persistence schema) is specified in
[`features/song-mode.md`](features/song-mode.md).

### Persistence

```yaml
localStorage:
  websynth.preset.*   : factory + user presets   # state/preset.ts
  websynth.preset.index : preset name index — factory ∪ user (ensureFactoryPresets seeds it)
  websynth.song.*     : saved song slots          # state/song.ts
  websynth.song.index : slot name index
  websynth.session.<tab> : debounced autosave of the live session, one per tab (silent boot restore)  # state/session-autosave.ts
  websynth.session    : the pre-v8 single key — still READ once so an existing session survives, never written
  websynth.perf       : performance-mode pref (auto|weak|medium|strong)  # state/perf-mode.ts — device-scoped, NOT a patch param
  websynth.midisync   : sync mode (off|master|slave)   # state/sync-mode.ts — device-scoped, NOT a patch param
  websynth.onboarding.done : guided-tour completed flag        # ui/onboarding
  websynth.hint.emptyplay  : "pressed Play on an empty song" hint dismissed  # ui/components/empty-play-modal.ts
  websynth.debug.about     : About-modal Debug section open    # ui/components/about-debug.ts
  websynth.shortcuts.about : About-modal full key list shown   # ui/components/about-shortcuts.ts
  websynth.keyboard.layout : qwerty|azerty|qwertz|dvorak|auto  # state/keyboard-layout.ts — device-scoped, NOT a patch param
  websynth.ui.collapsed.pattern : pattern-row collapse state   # ui/app.ts
  websynth.ui.collapsed.fx      : FX-section collapse state    # ui/app.ts
  websynth.ui.collapsed.seqtrack.<t> : per-seq-track fold state # ui/panels/seq-panel.ts — one key per track
  websynth.ui.scope.height : scope panel height in px, 130..260 # state/scope-height.ts — device-scoped workspace pref, NOT a patch param
not_persisted:
  decoded audio buffers  # sampler stores only filenames (sampleNames); reloaded —
                         # or carried in a project-zip download (features/project-export.md)
```

The two **named-slot** stores (presets and saved songs) share one implementation,
`SlotStore` (`src/state/slot-store.ts`): a prefix plus a name index at
`<prefix>index`, with `readIndex`/`writeIndex`/`addToIndex`/`removeFromIndex` and
opaque-JSON `readRaw`/`writeRaw`/`remove`. Serialization stays with the caller —
`Presets.save` rounds params, `Song.saveSlot` writes the canonical compact form —
so the store never knows either schema. A corrupt or absent index reads as empty
rather than throwing. Project **zips** are not slot-storable (localStorage is
text-only), so save slots stay JSON-only.

Blank step grids likewise have one source: `emptyPatternBanks()`
(`state/patterns.ts`) returns `BANK_COUNT` banks per machine from the same
`makeSeqBank`/`makeDrumBank`/`makeSamplerBank`/`makeMotionBank` builders
`PatternStore` boots with, so "New Song" can never drift from a fresh store.
(The demo-authoring helpers in `song.ts` — `emptySeq`/`seqFromNotes` — stay
separate on purpose: they use different constants that are already serialized
into the committed demos and share links.)

## Global conventions (constrain every feature)

- **Filter cutoff is a MIDI note number, not Hz.** The ladder filter worklet takes
  `cutoffNote` so envelope/LFO modulators sum in **semitones** via Web Audio's
  native `AudioParam` input summation. Keep modulation additive in semitone space.
- **AudioWorklets** (`ladder-filter`, `hardware-compressor`, `recorder`) live as
  plain JS in `public/worklets/` and must be `loadModule()`-ed (awaited) before the
  nodes that use them are created. `Engine.init()` is async for this reason.
- **DSP worklets favour _musical, stable, cheap_ over physical accuracy** —
  perceived behaviour first, bounded/no-NaN output always, minimal per-sample
  cost. The multiplier differs per worklet and it is worth being exact about
  which: the **ladder filter** runs once per voice on **one** channel
  (`channelCount: 1`, [`features/ladder-filter.md`](features/ladder-filter.md)
  REQ-9), so 8-voice polyphony is its whole budget; the **compressors** are two
  bus instances running 2 channels each. "Academically correct" DSP (ZDF,
  oversampling, thermal models) is declined unless it is *also* cheap and stable. See
  [ADR-010](decisions/adr-010-musical-stable-cheap-dsp.md).
- **No-op defaults for new params.** New analogue/song params default to a value
  that changes nothing (sub level 0, unison 1 voice, drift 0, djfilter 0,
  `seq.master` 1) so existing presets are unaffected. `glide.mode` defaults to
  `always` (1) for the same reason.
- **Interaction design follows "Don't Make Me Think"** — six ordered laws, chief
  among them *one gesture, one outcome* (a gesture whose result depends on
  invisible state is a defect) and *follow hardware/DAW precedent before
  inventing*. Every new interactive control owes a **gesture inventory** in its
  spec; run [`recipes/design-an-interaction.md`](recipes/design-an-interaction.md)
  before writing the listener. See
  [ADR-014](decisions/adr-014-dont-make-me-think.md); the grids' worked instance
  is [`features/step-grid-editing.md`](features/step-grid-editing.md).
- **CSS Modules** for all component/panel styling (`src/ui/styles/*.module.css`);
  global CSS is only `base.css` / `theme.css` / `layout.css`. State classes
  (`.on`, `.active`, `.playing`, …) are global — match with `:global(...)`.
- **Typography** — `--serif` is display type (identity, headings, faceplate
  legends), `--sans` is content (body copy, status lines, anything the user
  types), `--mono` is readouts and changing digits. Sans is the inherited
  default, so every other face is a deliberate opt-in, pinned by
  `tests/ui/typography.test.ts` — CSS is exempt from the SDD guard, so nothing
  else catches a drift. → [`features/typography.md`](features/typography.md).
- **Stable `data-testid`s** are minted at the factory level (`knob-<paramId>`,
  `switch-<paramId>`, `seg-<paramId>`, `tab-<id>`, `seq-step-<i>`, …). E2E specs
  select by testid/text/role because CSS Module class names are hashed. The id set
  is a contract with its own spec — [`features/testids.md`](features/testids.md).
- **Dev bridge** — `main.ts` exposes `window.__synth = { engine, bus, patterns,
  session, xy, patternUndo }` gated on `import.meta.env.DEV` (absent in
  production). Use it for E2E
  state assertions, e.g. `window.__synth.bus.get('filter.cutoff')`.
- **TypeScript is strict** with `noUncheckedIndexedAccess` — expect `arr[i]!`
  assertions; match that style. Tests live **outside `src/`** so `tsc` ignores
  them. So does this `specs/` folder.

## Key decisions (ADRs)

The *why* behind the choices above — and the alternatives each one rejected —
lives in [`decisions/`](decisions/) as Architecture Decision Records. The
load-bearing ones:

- [ADR-000](decisions/adr-000-spec-driven-development.md) — Spec-Driven Development
  as the working method (enforced, not optional).
- [ADR-001](decisions/adr-001-parambus-over-redux.md) — `ParamBus` over a state
  framework (the scalar single-source-of-truth behind REQ-1/REQ-2).
- [ADR-002](decisions/adr-002-audioworklet-compressor.md) — a custom AudioWorklet
  compressor over the native `DynamicsCompressorNode`.
- [ADR-003](decisions/adr-003-no-runtime-dependencies.md) — zero runtime
  dependencies (vanilla TS + the Web platform; `lamejs`/`qr`/`jsqr` vendored).
- [ADR-004](decisions/adr-004-patternstore-separate-from-parambus.md) —
  `PatternStore` separate from `ParamBus` (REQ-5; grids aren't scalars).
- [ADR-005](decisions/adr-005-cutoff-as-midi-note.md) — filter cutoff as a MIDI
  note number, for semitone-additive modulation.
- [ADR-006](decisions/adr-006-no-op-param-defaults.md) — no-op defaults for new
  params (REQ-4; existing presets/songs are unaffected).
- [ADR-007](decisions/adr-007-songfile-additive-versioning.md) — additive
  `SongFile` versioning (old songs keep loading and sounding the same).
- [ADR-008](decisions/adr-008-components-self-wire-params.md) — components
  self-wire their params (`Effect.bind`); voice allocation / lane mix extracted
  to `Polyphony` / `LaneMixer` so `Engine` coordinates rather than knows-all.
- [ADR-009](decisions/adr-009-ui-depends-on-studio-api-facade.md) — the UI
  depends on a narrow `StudioApi` facade, not the concrete `Engine` (Engine
  satisfies it structurally; internals stay invisible to the UI).
- [ADR-010](decisions/adr-010-musical-stable-cheap-dsp.md) — DSP worklets favour
  *musical, stable, cheap* over physical accuracy (the ladder filter + the
  compressors).
- [ADR-011](decisions/adr-011-export-precision-and-default-sparse-serialization.md) —
  song/preset export rounds to 4 sig-figs + writes default-sparse step cells
  (optimise only at the serialization boundary).
- [ADR-012](decisions/adr-012-true-bypass-disconnects.md) — bypassed effects
  disconnect their processed path after the crossfade settles (true bypass), so
  idle convolvers/shapers/compressor worklets cost zero audio-thread CPU.
- [ADR-013](decisions/adr-013-authoring-dialect-input-only.md) — the song
  authoring dialect is **input-only** (every import surface expands it to the
  canonical format; nothing ever exports it).
- [ADR-014](decisions/adr-014-dont-make-me-think.md) — interaction design follows
  *"Don't Make Me Think"*: six ordered laws, with *one gesture, one outcome* and
  *precedent before invention* doing most of the work.
- [ADR-019](decisions/adr-019-the-bar-is-a-tick-count.md) — the bar is a **tick
  count**, not a time signature, and every lane's cell index is a pure function
  of `clock.step` (which is what makes a 12- or 14-tick lane survive a seek).

## Tests & verification

- `npm run typecheck` — the primary gate.
- `npm test` — Vitest unit suite (pure logic + transport modules against a mock
  `AudioContext` + DOM components in jsdom).
- `npm run e2e` — Playwright smoke + control-surface + flow specs.

How to write either kind (mocks, the test clock, dialogs, downloads, fake media
devices) is [`recipes/write-a-test.md`](recipes/write-a-test.md); the selector
contract those specs read is [`features/testids.md`](features/testids.md). Nothing
automated can tell you whether a change is *musical* — that needs
[`recipes/verify-audio-by-ear.md`](recipes/verify-audio-by-ear.md) and a listen
([ADR-010](decisions/adr-010-musical-stable-cheap-dsp.md)).
