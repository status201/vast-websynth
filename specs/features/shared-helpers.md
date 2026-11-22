# Shared helpers (the code every layer reuses)

```yaml
id: shared-helpers
status: implemented
version: 1
owner: core
related:
  - architecture          # the layer rules these helpers live under
  - effects
  - meter
  - css-cascade-layers
  - untrusted-input
source:
  - src/utils/
  - src/audio/param-utils.ts
  - src/utils/listeners.ts
  - src/ui/app.ts
  - src/ui/panels/step-panel-scaffold.ts
  - src/audio/transport/step-hits.ts
  - src/audio/transport/lane-meter.ts
  - src/audio/effects/effect.ts
  - src/state/validate-utils.ts
  - src/ui/dom.ts
  - src/audio/recorder/buffer-dsp.ts
```

## Background / Why

Each helper here replaced a body that had been written out verbatim more than
once, where the copies agreed and the risk was that one day they would not. This
spec is the catalogue: what exists, where it lives, and the rule that lets each
layer import it. [Architecture](../architecture.md) owns the layer rules themselves.

## Technical design

Pure, side-effect-free helpers under `src/utils/` — importable from **any** layer.
Each replaced a helper that had been copy-pasted across modules.

The import rule is **directional, not absolute**: a util may never import from
`audio/` or `ui/`, so the audio layer can use one without dragging in UI code
([architecture](../architecture.md) REQ-ui-and-audio-never-call-each-other, ADR-001) and neither layer can reach the other through here. It *may*
import a **pure declaration** from `state/` — `state/limits.ts` (the one place a
bound is written down, ADR-015) and the `ParamDef` **type** from `state/params.ts`
— because duplicating either is the drift the single-source rules exist to
prevent. Three do today: `music.ts` and `zip.ts` take bounds from `limits.ts`,
`taper.ts` takes `ParamDef` as a type-only import. Nothing here imports a
`state/` module that *holds* state.

```yaml
utils/math.ts:       clamp(v,min,max) · clamp01(v) · midiToHz(note)   # A4 = 69 = 440 Hz
utils/taper.ts:      toNorm(def,v) · fromNorm(def,n)                  # param taper mapping
utils/base64url.ts:  toBase64Url(bytes) · fromBase64Url(s)            # RFC 4648 §5, unpadded
utils/array.ts:      assertIndex(arr,i,name) · IndexError
utils/compression.ts: deflateRaw / inflateRaw                          # zip codec + share links
utils/zip.ts:        the hand-written zip reader/writer (ADR-003)
utils/wake-lock.ts:  screen wake lock, follows engine.ctx state
utils/listeners.ts:  ListenerSet<Args> — add(fn) -> disposer · emit(...args)
utils/async.ts:      delay(ms, signal?) · withTimeout(p, ms, fallback)   # bounded waits; never reject
                     # the Engine's resume verify, the factory reset's capped wipes,
                     # the offline copy's worker poll
utils/format.ts:     plural(n, noun) · formatBytes(bytes) · megabytes(bytes)
                     # every count and size the UI spells out ("3 presets", "7.1 MB", "35 kB")
utils/offline-copy.ts: OfflineCopy state machine + the page/worker cache contract
                     # features/play-offline.md — platform code like wake-lock.ts, no UI
utils/music.ts:      scale tables · buildQuantizeTable · diatonicChord · degreeLabel
                     # features/scale-quantization.md, features/chord-tools.md.
                     # SCALE_LABELS is APPEND-ONLY — a song stores the index.
utils/tempo.ts:      DIVISIONS · sweetSpots(bpm) · syncedValue(...) · nearestDivision(...)
                     # BPM <-> note-division math. Two consumers, which is why it
                     # is here: the UI's sweet-spot badges (features/tempo-sync-help.md)
                     # and the audio layer resolving `lfo.sync` (features/lfo.md REQ-lfo-rate-is-exponentially-tapered).
                     # It started under ui/onboarding/, which audio may not import.
```

Audio-side, `audio/param-utils.ts` holds the smoothing vocabulary every
`AudioParam` write shares: `rampTo(param, value, ctx, tau)` /
over four named time constants — `RAMP_FAST` 5 ms, `RAMP_MEDIUM` 10 ms,
`RAMP_SMOOTH` 20 ms (the insert effects' own controls, which zipper audibly at
anything shorter) and `RAMP_BYPASS` 25 ms (an effect's whole dry/wet swap, which
moves far more level than any one knob — [effects](effects.md) REQ-bypass-and-mix-are-a-crossfade).
There is deliberately no cancel-then-ramp helper: `rampTo` retargets from wherever
the curve has reached, so it never needs a cancel. These are dialled by ear
under ADR-010, so they are named in one place rather than spelled as literals at
the call site.

`ListenerSet` backs every `onStep`/`onNote`/`onFollowChange` hook (the four
transport machines and `BankBar`), which had each open-coded the same
`Set` + `add → return () => delete` pair.

**`ui/app.ts` is the assembly, not the parts.** `mountApp` builds the five
regions in page order and wires the hooks that cross them; each region lives
in its own module and binds the bridge hooks its controls own:

```
ui/app.ts                  mountApp: order + the late-bound hooks (FX expand, demo
                           loader, the scope's live perf knobs and Debug source)
ui/shell/header.ts         brand, preset cluster, transport, voicing
                           (binds openPresetImport, toggleInfoBadges)
ui/shell/play-button.ts    the Play button + its LED state machine
                           (binds toggleTransport, cuePlay)
ui/panels/synth-panels.ts  the eight synth panels (bus only)
ui/panels/fx-rack.ts       the insert-effect rack (bus only)
ui/shell/pattern-row.ts    the MACHINES tabs + their tab-scoped routing
                           (binds undoActiveMachine, clearSelectedStep, showTab)
ui/shell/bottom.ts         wheels, the EQ row, the keyboard (binds pressKey, releaseKey)
ui/shell/scope-panel.ts    the scope, its three toggles and its resize grip
ui/shell/deps.ts           ShellDeps — what main.ts hands mountApp; each region's
                           signature takes the Pick<ShellDeps, …> it reads
ui/viewport.ts             the two mount-time breakpoints (isCompact, isPhone)
```

Each region's stylesheet is its own too (`styles/header.module.css` and its
siblings, layer `shell`), beside the panel chrome they all share
(`styles/panel.module.css`, layer `chrome`).

Moving a builder moves its component imports, and CSS Modules inject in import
order — so the split depends on every stylesheet declaring a cascade layer
([css-cascade-layers](css-cascade-layers.md)), which takes source order
out of the cascade between modules. A move like this is proven pixel-identical
with `scripts/css-cascade/fingerprint.mjs`, not by `tsc` or the unit suite.

The four machine tabs share their **chrome** through
`ui/panels/step-panel-scaffold.ts` — composable helpers, not one template, since
the panel bodies genuinely differ (note labels, a tuning strip, slot loaders, an
SVG graph). One internal `laneHooks(engine, lane)` switch maps the systematic
per-lane accessor families (PatternStore edit/copy/content, Arrangement play
bank, the machine's `onStep`), and the exported helpers read from it:
`bankBarFor` (the A–P bar, `testidPrefix` = lane), `wrapGridWithRestOverlay`
(the `position: relative` wrapper + overlay + follow wiring),
`wirePlayhead` (highlight only while edit bank === play bank, refreshing the
overlay on the same tick — and only while the panel's `VisibilityGate` reports it
on screen, re-syncing to the current step on reveal; painted when the step is
*heard*, via `ui/audible.ts`, not when the clock schedules it —
transport-position.md REQ-the-playhead-is-drawn-when-it-is-heard), `VisibilityGate` itself
(inactive tabs stay mounted, so `shell/pattern-row.ts` drives every panel's gate from one
`tabs.onViewChange`) and `GridCursor` (the drum/sampler 2-D selection
cursor). `paintTriggerCell` lives with `stepTitle` in
`ui/components/step-settings.ts`; the seq panel keeps its own painter because it
also writes the note name as the button label. Every `data-testid` is unchanged.

The transport machines additionally share two helpers:
`forEachActiveHit(bank, idx, when, stepDur, muted, fire)`
(`audio/transport/step-hits.ts`) — the one-shot lane sweep (skip muted, skip
off, roll `prob`, expand ratchets) used by the drum machine and the sampler;
and **`LaneMeter`**
(`audio/transport/lane-meter.ts`), which each of the four machines owns as
`.lane` and asks `forEachHit(step, when, fn)` — usually one cell per tick, none
on a tick a coarser lane skips, two or three inside one tick for a rate finer
than a 16th ([features/meter.md](meter.md)). The **motion** machine
builds its `LaneMeter` with no stutter map: automation must not follow stutter
remaps. The **arpeggiator** owns one too, for its onsets alone
([features/arpeggiator.md](arpeggiator.md) REQ-the-arp-runs-on-a-lanes-grid).

**A bar is `barTicks`, not 16.** One constant cannot mean cells-per-pattern,
ticks-per-bar and columns-of-UI at once: `state/meter.ts` names the three apart
(`GRID_CELLS`, `barTicks()`, `LANE_RATES`) and `SEQ_LENGTH` is only an alias
of the first. New code says which one it means — and in the UI goes through
`ui/lane-grid.ts`, so a grid, its ruler and its beat accents cannot disagree.
See [ADR-019](../decisions/adr-019-the-bar-is-a-tick-count.md).

Four more helpers exist for the same reason — each replaced a body that had been
written out verbatim more than once, where the copies agreed and the risk was
that one day they would not:

- **`safeBarTicks(ticks)`** (`state/meter.ts`) — `LaneMeter`, `Arrangement`,
  `LoopDriver`, `RecorderController` and `BankRenderController` each clamped the
  bar length by hand, identically. One number leaves `Engine.applyMeter()` and
  reached five copies of one rule (ADR-019). Note the fallback is
  `DEFAULT_BAR_TICKS`, not `1`: a one-tick bar would wrap every lane every tick.
- **`Arrangement.applyChain(...)`** — the four `set<Lane>Chain` methods differed
  only in which lane they wrote and which position counter they reset, so the
  load-bearing warning above the clamp (*not* `steps.map(clampChainStep)`, since
  `map` passes the index) was repeated four times. The position counters stay
  separate fields: they are read on the tick path, and the caller passes a reset.
- **`WrappedEffect.quiesceParam(p, on, held)`** — `Delay` and `Phaser` had the
  same anchored cancel for their feedback loop. The subtlety worth stating once
  is *why* it is anchored, and why it is not ramped. Its body is `pinParam`
  (`effects/effect.ts`), which the delay types' cores share through one
  `HeldFeedback` ([delay-types](delay-types.md)).
- **`loadWorkletModule(ctx, url)`** (`audio/worklet-module.ts`) — the flanger and
  the reverse delay each loaded their worklet on first use with the same
  memo-and-forget-a-failure body; the sync pair joined them (oscillator-sync.md v7),
  having memoized a failure for the session.
- **`createDjButton(label, testid)`** (`ui/components/button.ts`) — the transport
  row and the LIVE FX row each had a private `djButton`. They looked different
  and were not: both local aliases resolved to `song-panel.module.css`.

The **label lists** follow the same rule as their counts: `SEQ_TRACK_LABELS` and
`SAMPLER_SLOT_LABELS` are derived from `SEQ_TRACK_COUNT` / `SAMPLER_SLOT_COUNT`
the way `MOTION_TRACK_LABELS` and `BANK_LABELS` already were, and
`DRUM_TRACK_LABELS` is spread from `PatternStore`'s `DRUM_TRACKS` rather than
retyped — `params.ts` already imported that array for `duck.src`, so a rename
would have left the knob labels, the duck source list and the authoring guide
disagreeing about what track 3 is called.

Insert effects additionally share `bindBypassMix(bus, prefix, fx)`
(`audio/effects/effect.ts`) — the `${prefix}.on` → `setBypass` and
`${prefix}.mix` → `setMix` subscriptions every `Effect.bind` opened by hand.
`Compressor.bind` calls it too, for the `.on` half alone: it defines no `setMix`,
and that absence is exactly how the helper knows not to subscribe a `.mix` param
the compressors and the wah do not have.

Every insert effect extends **`WrappedEffect`** (`audio/effects/effect.ts`),
which owns the `BypassWrapper`, publishes its `input`/`output` as the `Effect`
surface and delegates `setBypass`. A subclass is then only its DSP span plus its
`bind`; `Compressor` overrides `setBypass` to also clear its GR meter.
`setMix` stays off the base deliberately — see effects.md REQ-every-effect-implements-the-interface.

Their **params** come from one factory per shared effect in
`state/params.ts` (`dirtParams`, `phaserParams`, `delayParams`, `reverbParams`,
over `fxOnParam`), instantiated per prefix, so the three chains cannot drift into
three different delays. Per-chain defaults are arguments, not copies. The wah and
the compressors stay longhand — each appears once. `npm run check:params` is the
gate: `public/params.json` and `public/params.md` must regenerate byte-identical.

The four payload validators share `state/validate-utils.ts`
(`isObject`, `describeValue`, `MAX_ERRORS`, `AddError`) — `isObject` is a
security predicate under ADR-015, and it had four copies. The per-step checks
`checkUnit` / `checkRatchet` / `checkMicro` / `checkBool` / `readBend` are
exported by `state/song-validate.ts`, which the dialect already imports (only
the two song parsers use them): each reports a bad value and returns the good
one. The canonical validator ignores the return and
refuses on any report; the dialect keeps the return and imports the rest of the
song (ADR-013). Refusing versus coercing is the caller's decision, so the range
and the message are written once and the two parsers cannot quote different
bounds.

Four smaller bodies follow the same rule:

- **`el(tag, className?, text?)`** (`ui/dom.ts`) — the element factory five
  hand-built surfaces (the song panel, its chain lanes, the sample studio, the
  pairing modal, the signal-flow map) each declared privately. Text only, never
  markup; the help widgets keep their own because theirs takes HTML.
- **`peakOf(...channels)`** (`audio/recorder/buffer-dsp.ts`) — the recorder's
  per-batch meter, the vocoder's gain staging and the normalizer each looped
  for the largest absolute sample.
- **`startDevServer` / `bootApp`** (`scripts/lib/bench-app.mjs`) — the two
  benches *and* `readme-screenshots.mjs` spawn vite and get past the start gate
  through these; the screenshot script's copy had kept `localhost`, which can
  resolve to the address family vite is not listening on.
- **`scripts/lib/cli.mjs`** — `flag` / `flags` (the scripts' argument parsing),
  `git`, `readStdin` and `parseJson` (what the two hooks, `sdd-guard.mjs` and
  `spec-lint.mjs`, each read their input with).

## Tests & verification

- `npm run typecheck` (the import rule is structural: a util that imports `audio/`
  or `ui/` is a review failure, not a type error), `npm run check:params` (the
  shared effect param factories), `tests/audio/no-unanchored-cancel.test.ts`, and
  each helper's own suite under `tests/`.
