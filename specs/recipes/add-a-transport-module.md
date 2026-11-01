# Recipe — add a transport module

```yaml
id: add-a-transport-module
status: implemented
version: 2
owner: core
related:
  - architecture
  - ../features/transport.md
  - ../features/meter.md
  - write-a-test
source:
  - src/audio/transport/sequencer.ts   # reference module
  - src/audio/transport/lane-meter.ts
  - src/audio/transport/clock.ts
  - src/audio/transport/step-hits.ts
  - src/audio/engine.ts
```

A repeatable **playbook**, not a feature. A *transport module* is a clock-driven
scheduler under `src/audio/transport/` (arpeggiator, sequencer, drum machine,
sampler, motion, arrangement, performance). They share one shape: subscribe to the
[`Clock`](../features/transport.md) in the constructor, and on each tick read
pattern state and schedule events at absolute audio time. The worked instance is
[`StepSequencer`](../features/sequencer.md) (`src/audio/transport/sequencer.ts`).

## Background / Why

The `Clock` hands out each 16th with the absolute `AudioContext` time it sounds,
ahead of time ([transport](../features/transport.md)). A module never reads
`ctx.currentTime` to time a note: it schedules at the `when` it is given, so
events stay sample-accurate under main-thread jank. A module that steps through a
**pattern** never does its own `% SEQ_LENGTH` either: its length, step rate and
swing come from a `LaneMeter` ([meter](../features/meter.md)).

## Steps

### 1. Subscribe in the constructor, and own a `LaneMeter` — `src/audio/transport/<name>.ts`

Take collaborators in the house order — `(output/ctx, clock: TickSubscriber,
patterns, arrangement, perf, …)` — build the lane, and end by subscribing:

```ts
readonly lane: LaneMeter;

constructor(
  private readonly output: SynthOutput,
  private readonly clock: TickSubscriber,
  private readonly patterns: PatternStore,
  private readonly arrangement: Arrangement,
  private readonly perf: Performance,
) {
  // perf.mapStep folds stutter in; pass undefined to ignore it (motion does).
  this.lane = new LaneMeter(clock, (s) => perf.mapStep(s), () => arrangement.loopTicks('my'));
  clock.onTick((step, when) => this.onTick(step, when));
  // optional: clock.onStart / onStop / onSeek to reset or release state
}
```

### 2. Schedule on each tick, one cell at a time

`forEachHit` calls back once per cell that **begins** in this tick (none on a tick
a coarser lane skips, two or three for a rate finer than a 16th), with the cell
index already wrapped to the lane, its swung `when` and its duration. Read the
play bank and schedule; `step-hits.ts` holds the shared probability / ratchet /
micro math (`stepHits`, `rollProb`, `microOffset`, `forEachActiveHit` for
multi-row grids):

```ts
private onTick(step: number, when: number): void {
  if (!this.enabled) return;
  this.lane.forEachHit(step, when, (idx, at, cellDur) => {
    const cell = this.patterns.myBank(this.arrangement.myPlayBank)[idx];
    if (!cell || !cell.on || !rollProb(cell.prob)) return;
    for (const h of stepHits(cell, at, cellDur)) {
      this.output.trigger(/* … */ h.t);   // absolute audio time
    }
  });
}
```

### 3. Expose control + construct in the engine

Add `setEnabled`/`setMuted` and any `onStep`/`onNote` listener registration
(returning unsubscribers). An `onStep` reports `(idx, when)`: the cell **and its
audio time**, because a display waits for `when` through `ui/audible.ts`
([transport-position](../features/transport-position.md)
REQ-the-playhead-is-drawn-when-it-is-heard). Then, in `src/audio/engine.ts`:

- construct the module in `Engine.init()` **after** the `Clock` and the
  `Arrangement` (its tick settles the play banks first);
- add its lane to the `<m>.len` / `<m>.rate` subscription loop and to
  `applyMeter()`'s `setBarTicks` list, with the params registered per
  [add-a-parameter](add-a-parameter.md) (defaults: `LEN_FOLLOW`, `DEFAULT_LANE_RATE`);
- wire its other params in `subscribeParams`, and surface it on `StudioApi` if the
  UI needs it.

```ts
this.arrangement = new Arrangement(this.patterns, this.clock);   // first
this.myModule = new MyModule(output, this.clock, this.patterns, this.arrangement, this.perf);
```

### 4. Verify

```bash
npm run typecheck
npm test            # tests/audio/transport/<name>.test.ts (mock ctx + test-clock)
```

## Gotchas

- **Construction ordering matters.** `Arrangement`'s `onTick` must run before a
  machine reads the play bank for the same tick, so it is constructed first.
- **Never time events off `ctx.currentTime`**, and never space gates or ratchets
  with `clock.sixteenthDuration()`: use the `cellDur` `forEachHit` hands you, or a
  coarser rate plays 16th-length gates.
- **Never compute the cell yourself** (`step % N`): a hand-rolled index ignores
  the lane's length, rate, swing, chain paging and stutter, and breaks on a seek.
  A module that only counts **bars** reads `barTicks` instead.
- Read `arrangement.<lane>PlayBank`, not the edit bank (a disabled lane's play bank
  already tracks the edit bank).

## Scenarios (BDD)

```gherkin
Scenario: The module schedules an enabled step at the tick's audio time
  Given an enabled transport module driven by a test clock
  When a tick fires for an active step at time `when`
  Then it triggers output at `when` (not ctx.currentTime), respecting gate/prob
# pinned by: tests/audio/transport/sequencer.test.ts, tests/audio/transport/test-clock.ts
```

## Tests & verification

- `tests/audio/transport/sequencer.test.ts` is the reference; drive with the
  `tests/audio/transport/test-clock.ts` double against the mock `AudioContext`
  ([write-a-test](write-a-test.md)). `npm run typecheck` / `npm test`.
