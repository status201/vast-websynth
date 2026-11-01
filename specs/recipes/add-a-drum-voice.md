# Recipe — add a drum voice

```yaml
id: add-a-drum-voice
status: implemented
version: 2
owner: core
related:
  - drum-machine
  - step-settings
  - add-a-parameter
source:
  - src/audio/drums/drum-synths.ts
  - src/audio/transport/drum-machine.ts  # MODEL_BUILDERS
  - src/state/params.ts                  # DRUM_MODEL_LABELS, DRUM_TRACK_LABELS, drumTrackParams()
  - src/state/patterns.ts                # DRUM_TRACK_COUNT
```

How to add a synthesised drum sound. A new **voice** is a new *model* any of the
eight tracks can select ([drum-machine](../features/drum-machine.md)
REQ-a-drum-tracks-algorithm-is-selectable): two appends, no schema change. A new
**track** (a ninth row) is a different, rarer change, at the end.

## Background / Why

Drum voices are synthesised one-shots implementing `DrumSynth`. A track's
`drum.t{i}.model` is an index into `DRUM_MODEL_LABELS`, and `MODEL_BUILDERS` must
stay index-aligned with it. The index is stored in every song, preset and share
link, so **both lists are append-only**: inserting or reordering silently swaps
the voice of every saved song that used a later index.

## Steps

### 1. Implement `DrumSynth` — `src/audio/drums/drum-synths.ts`

```ts
export class MyDrum implements DrumSynth {
  readonly output: GainNode;              // persistent; ramped on a model swap
  trigger(when: number, velocity: number, chokeAt?: number): void { /* … */ }
  setTune(semitones: number): void { /* … */ }
  setDecay(seconds: number): void { /* … */ }
}
```

The contract is the whole of the drum-machine spec's voice rules: tune audible on
every source (REQ-tune-is-audible-on-every-voice), a gate < 1 chokes downstream
(`chokeRoute`), each envelope ends on a linear ramp to exactly 0 via `decayEnv()`
(REQ-a-voice-envelope-reaches-true-zero), and `finishHit()` disconnects every
per-hit node, the choke gain included (REQ-per-hit-nodes-are-disposable). Start a
clamped hit's choke with it (REQ-a-clamped-hit-carries-its-choke).

### 2. Append the builder and the label

- `MODEL_BUILDERS` in `src/audio/transport/drum-machine.ts`:
  `(ctx, noise) => new MyDrum(ctx, noise)` at the **end**.
- `DRUM_MODEL_LABELS` in `src/state/params.ts`: its label at the **end**.
  `drum.t{i}.model`'s range follows `DRUM_MODEL_LABELS.length` by itself.
- Run `npm run gen:params`: the labels reach `public/params.json`, which CI's
  `check:params` compares.

### 3. Listen

Constants are dialled by ear (ADR-010): render the new voice with
`npm run bench:audio` against a stock voice, and listen for the tail with drive up
([verify-audio-by-ear](verify-audio-by-ear.md)).

## Adding a track instead (rare)

A ninth row touches the pattern shape, so it is a song-format question first
([evolve-the-song-format](evolve-the-song-format.md)): `drumBanks` is validated as
`[banks][8][16]`. If it is still wanted: bump `DRUM_TRACK_COUNT`
(`src/state/patterns.ts`), add a slot name to `DRUM_TRACK_LABELS` and a classic
model for it to both lists. `drumTrackParams()`, the engine's per-track subscribe
loop and the grid all iterate `DRUM_TRACK_COUNT`.

## Gotchas

- **Append only**, in both lists, at the same index.
- A track's *slot name* (`DRUM_TRACK_LABELS`, the dialect's `kick`/`chat`/…) is not
  its model's label; the grid row shows the model's.
- The hat choke group is by model index (`C.Hat` / `O.Hat`); a new voice is not in
  it unless the group table names it.

## Scenarios (BDD)

```gherkin
Scenario: The new track triggers and has its own controls
  Given DRUM_TRACK_COUNT is increased and MyDrum is in the tracks list
  When a step on the new row fires
  Then MyDrum.trigger runs and drum.t{n}.vol/tune/decay/mute control it
# pinned by: tests/audio/drums/drum-synths.test.ts, tests/audio/transport/drum-machine.test.ts
```

## Tests & verification

- `tests/audio/drums/drum-synths.test.ts` (every model honours the envelope and
  teardown rules), `tests/audio/transport/drum-machine.test.ts`,
  `tests/state/patterns.test.ts`. `npm test` / `npm run typecheck`.
