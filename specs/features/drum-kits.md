# Drum kits & randomize

```yaml
id: drum-kits
status: implemented
version: 2   # v2: KitDef.model row + the Percussion kit (voice models, drum-machine.md REQ-11)
owner: core
related:
  - architecture
  - drum-machine
  - presets
  - song-mode
source:
  - src/audio/drums/drum-kits.ts
  - src/ui/panels/drum-panel.ts
```

Factory **kit presets**, a **randomize** ("surprise me") action, and per-track
**reset** — all layered on top of the per-track scalar params owned by the
[drum machine](drum-machine.md).

## Background / Why

The drum machine parameterises each track (tune/decay/tone/drive/pan/vol), but
dialling in a whole kit by hand is slow and most users want to *pick* a starting
point. A kit is just a named table of per-track param values applied through the
bus, so it needs no new audio code, no new persistence, and no new file format —
it reuses `bus.set` and the fact that every scalar param is already captured by
presets and songs. Randomize is the same mechanism with values drawn from musical
sub-ranges; reset writes each param back to its registered default.

## Requirements

- **REQ-1** — A small set of factory kits (e.g. Default, 808, 909, LoFi,
  Acoustic, Techno, Percussion), each a sparse per-track table merged over the
  registered defaults.

- **REQ-2** — `applyKit(bus, name)` writes every per-track param for all tracks:
  the kit's value where given, otherwise the param's registered default (so
  switching kits is deterministic and fully overwrites the previous kit).

- **REQ-3** — `randomKitValues(rand?)` is **pure** (takes an injectable RNG) and
  returns param→value entries within musical sub-ranges (not the full param
  range). `randomizeKit(bus, rand?)` applies them via `bus.set`.

- **REQ-4** — UI: a KIT dropdown + a Randomize button lead the **sound-design
  row below the grid** (alongside the per-drum tuning strip), not the panel
  header — the header is already full and widening it pushes the drum-compressor
  help badge off-screen. Selecting a kit applies it, Randomize rolls a new one;
  both repaint the tuning strip via the knobs' own bus subscriptions.

- **REQ-5** — No-op safety: the Default kit and reset reproduce the registered
  defaults exactly, so existing presets/songs are unaffected.

- **REQ-6** (v2) — A kit may also choose each track's **voice model**
  (`KitDef.model`, writing `drum.t{i}.model` — drum-machine.md REQ-11). The
  **Percussion** kit uses this to turn the machine into a percussion section
  (congas/bongo/clave/shaker/cowbell over tuned toms' slots). Randomize
  deliberately does **not** touch models — it stays a timbre shuffle of the
  current voices; `applyKit` still resets the model row to defaults for kits
  that omit it (REQ-2 semantics).

## Technical design

### Contract / public interface

```yaml
# src/audio/drums/drum-kits.ts
KitDef: Record<paramSuffix, number>     # suffix e.g. 'tune' | 'tone' | ...; per-track arrays
DRUM_KITS: Record<string, KitDef>        # Object.keys order = dropdown order; 'Default' first
applyKit(bus: ParamBus, name: string): void
randomKitValues(rand?: () => number): Record<ParamId, number>   # pure
randomizeKit(bus: ParamBus, rand?: () => number): void
```

### Data shapes

```yaml
# A KitDef gives, per drum param, an 8-entry array (one per track). Omitted
# params fall back to the bus default in applyKit.
KitDef:
  tune?:  number[]   # semitones per track
  decay?: number[]   # seconds per track
  tone?:  number[]   # 0..1 per track
  drive?: number[]   # 0..1 per track
  pan?:   number[]   # -1..1 per track
  vol?:   number[]   # 0..1 per track
  model?: number[]   # voice model index per track (v2; drum-machine.md REQ-11)
```

### Layer touchpoints & ordering

```yaml
drum-kits.ts: pure data + bus writes only — imports DRUM_TRACK_COUNT, no AudioContext
ui (drum-panel.ts sound-design row, below the grid — not the header):
  Dropdown(Object.keys(DRUM_KITS)) -> applyKit; Randomize button -> randomizeKit;
  testids drum-kit / drum-randomize
reset (same row's tuning strip): per-track, writes bus.def(id).default via bus.set
```

### Persistence

Kits/randomize/reset only **write existing scalar params**, so their effect is
captured by presets (`websynth.preset.*`) and songs (`SongFile.params`)
automatically. The **selected kit name is deliberately NOT persisted** — only the
resulting param values are. There is no new localStorage key or `SongFile` field.

## Scenarios (BDD)

```gherkin
Scenario: Selecting a kit changes the tracks
  Given the KIT dropdown
  When a non-default kit is selected
  Then every drum.t{i}.* param is set to the kit's value or its default
# pinned by: tests/audio/drums/drum-kits.test.ts, e2e/drum-kit.spec.ts

Scenario: Randomize stays in musical range
  Given a seeded RNG
  When randomKitValues runs
  Then each returned value is within its param's musical sub-range and clamps in the bus
# pinned by: tests/audio/drums/drum-kits.test.ts

Scenario: The Default kit is a no-op
  Given freshly registered defaults
  When applyKit(bus, 'Default') runs
  Then the snapshot equals the registered defaults for all drum.t{i}.* params
# pinned by: tests/audio/drums/drum-kits.test.ts
```

## Tests & verification

- Unit: `tests/audio/drums/drum-kits.test.ts` — `npm test`
- E2E: `e2e/drum-kit.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge: `window.__synth.bus.get('drum.t0.tune')` (DEV only)

## Open questions / future

- Kit selection is stateless (an action menu). A persisted "current kit" with a
  "Custom" state when params diverge could be added later if users want it.
- User-saved custom kits (beyond presets) are out of scope for v1.
```
