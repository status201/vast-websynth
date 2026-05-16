# CLAUDE.md

Guidance for working in this repo. See `README.md` for the user-facing overview.

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
```

`npm run typecheck` is still the primary check (TS is in `strict` mode with
`noUncheckedIndexedAccess`, so expect `arr[i]!` assertions throughout — match
that style). There is also a small Vitest suite under `tests/` covering the
pure-logic units (`ParamBus`, `PatternStore`, `Song`) and the DOM components
(`createButton`, `Dropdown`); it runs in jsdom. Tests live **outside `src/`**
so they stay invisible to `tsc` — `typecheck`/`build` behaviour is unchanged.
There is no linter.

## Architecture

Two long-lived objects are created once in `main.ts` and threaded everywhere:

- **`ParamBus`** (`state/params.ts`) — the single source of truth for every
  scalar parameter. Every param is registered in `registerDefaults()` with
  `min/max/default/taper/format`. Setting a value clamps it and notifies
  subscribers. **UI and audio never talk directly** — a knob calls
  `bus.set(...)`; the `Engine` does `bus.subscribe(...)` to apply it to the
  audio graph. To add a parameter: add a `ParamDef`, subscribe in
  `Engine.subscribeParams()`, add a UI control in `ui/app.ts`.
- **`Engine`** (`audio/engine.ts`) — owns the `AudioContext`, the voice pool
  (8 `Voice`s), the FX chain, and transport modules. Note events flow through
  `bus.onNote` → `playNote` / `releaseNote` unless `passthroughSuppressed` is
  set (arpeggiator/sequencer take over note triggering then).

Audio graph:

```
voices → voiceBus → distortion → wah → phaser → delay → reverb ─┐
                                                  drumBus ───────┤
                                                          preMaster → analyser → master → destination
```

The analyser taps **pre-master** so the scope is independent of the volume
knob. The drum bus **and** the sampler bus join at `preMaster`, bypassing the
synth FX chain.

**Audio export** — a zero-output `recorder` AudioWorklet
(`public/worklets/recorder.js`, wrapped by `audio/recorder/node.ts`) is tapped
off `master` (post master-volume) as a pure sink. `RecorderController`
(`audio/recorder/recorder-controller.ts`) drives capture: `exportSong()` plays
one full pass of the longest enabled arrangement chain then auto-stops;
`toggleManual()` is a free-form record toggle. Encoding is **pure** and
AudioContext-free (`audio/recorder/encode.ts` — `encodeWav` is dependency-free;
`encodeMp3` uses the vendored lamejs) so it is unit-testable under jsdom.

Non-scalar state (step grids) lives in **`PatternStore`** (`state/patterns.ts`),
not in `ParamBus`, because the shapes are arrays of objects. It has its own
listener mechanism.

### Song mode

- **`PatternStore`** holds 4 sequencer banks + 4 drum banks. The UI edits the
  *edit bank* (`seq`/`drum` getters; `setSeqEditBank`/`setDrumEditBank`
  re-emit every step so panels repaint). The transport reads the *play bank*
  (`seqBank(i)`/`drumBank(i)`) chosen by the Arrangement — which may differ.
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
- **Sampler** — `PatternStore` also holds 4 **sampler** banks (8 slots × 16
  steps, `SamplerStep`). `SamplerMachine` (`audio/transport/sampler-machine.ts`)
  mirrors `DrumMachine` but each slot plays a user-loaded `AudioBuffer`
  one-shot; the `Arrangement` has a third `sampler` chain lane. Decoded buffers
  live in `SamplerMachine`; only filenames (`patterns.sampleNames`) persist —
  after a song import the user re-loads the files (`.needs-reload` label hint).
- **`Song`** (`state/song.ts`) — `capture`/`apply` a full song (`bus.snapshot`
  + all banks + all three chains). `SongFile` is now `version: 1 | 2`; v2 adds
  optional `samplerBanks`/`samplerChain`/`sampleNames`. `fromJSON` is unchanged
  and accepts both; v1 files (incl. `DEMO_SONGS`) load with empty sampler
  state. JSON file export/import **and** localStorage slots under
  `websynth.song.*`. `DEMO_SONGS` (Knight Rider, Zombie Nation, I Feel Love).

## Conventions & gotchas

- **Filter cutoff is a MIDI note number**, not Hz. The ladder filter worklet
  takes `cutoffNote` so envelope/LFO modulators sum in semitones via Web
  Audio's native `AudioParam` input summation. Keep modulation additive in
  semitone space.
- The ladder filter is an **AudioWorklet**; its processor lives in
  `public/worklets/ladder-filter.js` (plain JS, runs on the audio thread —
  no TS, no imports). `LadderFilterNode.loadModule()` must be awaited before
  voices are created.
- `Engine.init()` is async (loads the worklet, creates voices, builds
  transport modules). Transport modules are created **after** voices so they
  can call back into the engine.
- Presets persist to `localStorage` under `websynth.preset.*`. Factory
  presets are seeded by `ensureFactoryPresets()` on boot.
- Audio cannot start without a user gesture — everything is wired inside the
  "Tap to start" handler in `main.ts`.
- UI is hand-built DOM (`document.createElement`), no virtual DOM. Components
  in `ui/components/`, larger sections in `ui/panels/`. The on-screen keyboard
  is exposed as `window.__synthKeyboard` and the transport toggle as
  `window.__transportToggle` so `shortcuts.ts` can drive them (keeps the
  play-button visuals in sync).
- `glide.mode` defaults to **`always`** (1), not `off`, because `always`
  with glide time 0 reproduces the pre-song-mode behaviour — keeps existing
  presets that set `mixer.glide` sounding the same.
- New analogue/song params default to a **no-op** (sub level 0, unison 1
  voice, drift 0, djfilter 0) so existing presets are unaffected.
- Demo-song riffs aim to be *recognisable*, not note-perfect transcriptions.

## Branding

The product is presented in-app as **"VAST G1-J5"**; the package/repo name is
`websynth`. Both refer to the same thing.
