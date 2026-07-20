# Recipe — add a drum voice (track)

```yaml
id: add-a-drum-voice
status: implemented
version: 1
owner: core
related:
  - drum-machine
  - step-settings
  - add-a-parameter
source:
  - src/audio/drums/drum-synths.ts
  - src/audio/transport/drum-machine.ts
  - src/state/patterns.ts                # DRUM_TRACK_COUNT
  - src/state/params.ts                  # DRUM_TRACK_LABELS, drumTrackParams()
```

How to add a 9th (etc.) synthesised drum track. More involved than most recipes —
the track count is referenced in several places, some by literal.

## Background / Why

Drum voices are synthesised one-shots implementing the `DrumSynth` interface. The
[drum machine](../features/drum-machine.md) holds a fixed-order `tracks` list whose
order must match `DRUM_TRACK_LABELS`. Adding a voice means growing that list **and**
the per-track params/grid, plus the choke model comes free via `chokeRoute`.

## Steps

### 1. Implement `DrumSynth` — `src/audio/drums/drum-synths.ts`

```ts
export class MyDrum implements DrumSynth {
  readonly output: AudioNode;
  trigger(when: number, velocity: number, chokeAt?: number): void { /* … */ }
  setTune(semitones: number): void { /* … */ }
  setDecay(seconds: number): void { /* … */ }
}
```

Use `chokeRoute(ctx, output, chokeAt)` so gate < 1 chokes the hit downstream (see
[step-settings](../features/step-settings.md)).

### 2. Add it to the track list — `src/audio/transport/drum-machine.ts`

Append to `this.tracks = [ … new MyDrum(this.ctx) ]` (order must match the labels).

### 3. Grow the count + labels

- Bump `DRUM_TRACK_COUNT` in `src/state/patterns.ts`.
- Add a label to `DRUM_TRACK_LABELS` in `src/state/params.ts`.

### 4. Per-track params + engine wiring

`drumTrackParams()` generates `drum.t{i}.vol/tune/decay/tone/drive/pan/mute/model`.
Verify + verify
(see Gotchas).

## Gotchas

- **Track counts.** `drumTrackParams()` (params.ts) and the per-track subscribe
  loop in `Engine.subscribeParams()` iterate `DRUM_TRACK_COUNT` (they were
  refactored off a literal `8` when per-track tone/drive/pan were added). Bumping
  `DRUM_TRACK_COUNT` now grows the params + wiring automatically — but double-check
  any remaining literal loops if you touch that area.
- Track order in `DrumMachine.tracks` must line up with `DRUM_TRACK_LABELS` and the
  grid rows.
- The grid (`drum-panel.ts`) renders `DRUM_TRACK_COUNT` rows — confirm it picks up
  the new count.

## Scenarios (BDD)

```gherkin
Scenario: The new track triggers and has its own controls
  Given DRUM_TRACK_COUNT is increased and MyDrum is in the tracks list
  When a step on the new row fires
  Then MyDrum.trigger runs and drum.t{n}.vol/tune/decay/mute control it
# pinned by: tests/audio/drums/drum-synths.test.ts, tests/audio/transport/drum-machine.test.ts
```

## Tests & verification

- `tests/audio/drums/drum-synths.test.ts`, `tests/audio/transport/drum-machine.test.ts`,
  `tests/state/patterns.test.ts`. `npm test` / `npm run typecheck`.
