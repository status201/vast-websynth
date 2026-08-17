# Recipe — add a transport module

```yaml
id: add-a-transport-module
status: implemented
version: 1
owner: core
related:
  - architecture
  - ../features/transport.md
  - write-a-test
source:
  - src/audio/transport/sequencer.ts   # reference module
  - src/audio/transport/clock.ts
  - src/audio/transport/step-hits.ts
  - src/audio/engine.ts
```

A repeatable **playbook**, not a feature. A *transport module* is a clock-driven
scheduler under `src/audio/transport/` (arpeggiator, sequencer, drum machine,
sampler, arrangement, performance). They share one shape: subscribe to the
[`Clock`](../features/transport.md) in the constructor, and on each tick read
pattern state and schedule events at absolute audio time. The concrete worked
instance is [`StepSequencer`](../features/sequencer.md)
(`src/audio/transport/sequencer.ts`).

## Background / Why

The `Clock` implements the classic "two clocks" look-ahead pattern: a worker
timer wakes the scheduler ~every 25 ms, which enqueues events ~100 ms ahead
against absolute `AudioContext` time. A transport module never reads
`ctx.currentTime` to time a note — it schedules at the `when` the clock hands it,
so events stay sample-accurate under main-thread jank.

## Steps

### 1. Subscribe in the constructor — `src/audio/transport/<name>.ts`

Take collaborators in the house order — `(output/ctx, clock: TickSubscriber,
patterns, arrangement, perf, …)` — and end the constructor by subscribing:

```ts
constructor(
  private readonly output: SynthOutput,
  private readonly clock: TickSubscriber,
  private readonly patterns: PatternStore,
  private readonly arrangement: Arrangement,
  private readonly perf: Performance,
) {
  clock.onTick((step, when) => this.onTick(step, when));
  // optional: clock.onStart(...) / clock.onStop(...) to reset/flush state
}
```

### 2. Schedule on each tick

Bail if disabled, map the raw step through `perf.mapStep` (stutter) into your
grid length, read the play bank, and schedule at absolute `when` — using
`clock.sixteenthDuration()` for gate lengths and `step-hits.ts` for the shared
probability-roll / ratchet math:

```ts
private onTick(step: number, when: number): void {
  if (!this.enabled) return;
  const idx = this.perf.mapStep(step) % MY_LENGTH;
  const cell = this.patterns.myBank(this.arrangement.myPlayBank)[idx];
  if (!cell || !cell.on || !rollProb(cell.prob)) return;
  for (const h of stepHits(cell, when, this.clock.sixteenthDuration())) {
    this.output.trigger(/* … */ h.t);          // schedule at absolute audio time
  }
}
```

### 3. Expose control + construct in the engine

Add `setEnabled`/`setMuted` and any `onStep`/`onNote` listener registration
(returning unsubscribers). Construct the module in `Engine.init()` **after** the
`Clock` — and after `Arrangement` if it reads play banks — wire its params in
`subscribeParams`, and surface it on `StudioApi` if the UI needs it:

```ts
// src/audio/engine.ts — Arrangement first so its tick settles play banks
this.arrangement = new Arrangement(this.patterns, this.clock);
this.myModule  = new MyModule(output, this.clock, this.patterns, this.arrangement, this.perf);
```

### 4. Verify

```bash
npm run typecheck
npm test            # tests/audio/transport/<name>.test.ts (mock ctx + test-clock)
```

### Reading the meter

A module that steps through a **pattern** does not do its own `% SEQ_LENGTH`:
it owns a `LaneMeter` (`audio/transport/lane-meter.ts`) and asks
`forEachHit(step, when, fn)` — usually one cell per tick, none on a tick a
coarser lane skips, two or three inside one tick for a rate finer than a 16th.
That is what gives it a length, a step rate and lane-relative swing for free,
and keeps its cell index a pure function of `clock.step` so a seek needs no
repair ([features/meter.md](../features/meter.md) REQ-3). A module that merely
counts **bars** reads `barTicks` instead. Build the `LaneMeter` with the
`Performance.mapStep` fold if the module should follow stutter, and without it
if it should not (the motion sequencer does not).

## Gotchas

- **Construction ordering matters.** `Arrangement`'s `onTick` must run before a
  machine reads the play bank for the same tick — so it is constructed first
  (see the comment in `engine.ts`). Order your module after it.
- **Never time events off `ctx.currentTime`** — schedule at the `when` the clock
  provides. Use `clock.sixteenthDuration()` for gate/ratchet spacing.
- Always route the step through `perf.mapStep(step)` before the modulo, or the
  module ignores live stutter.
- A disabled lane's play bank tracks that machine's edit bank (the `Arrangement`
  handles this) — read `arrangement.<lane>PlayBank`, not the edit bank.

## Scenarios (BDD)

```gherkin
Scenario: The module schedules an enabled step at the tick's audio time
  Given an enabled transport module driven by a test clock
  When a tick fires for an active step at time `when`
  Then it triggers output at `when` (not ctx.currentTime), respecting gate/prob
# pinned by: tests/audio/transport/sequencer.test.ts, tests/audio/transport/test-clock.ts
```

## Tests & verification

- `tests/audio/transport/sequencer.test.ts` — reference; drive with the
  `tests/audio/transport/test-clock.ts` double against the mock `AudioContext`
  (see [write-a-test](write-a-test.md)).
- `npm run typecheck` / `npm test`.
