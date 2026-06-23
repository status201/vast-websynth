# Transport clock

```yaml
id: transport
status: implemented
version: 1
owner: core
related:
  - architecture
  - arpeggiator
  - sequencer
  - arrangement
source:
  - src/audio/transport/clock.ts
  - src/audio/transport/tick-source.ts
  - src/state/params.ts
  - src/audio/engine.ts
```

The look-ahead clock that drives every timed module (arp, sequencer, drum machine,
sampler, arrangement, performance, recorder).

## Background / Why

Timers in the browser are jittery, but `AudioParam` scheduling is sample-accurate.
The clock uses the classic **"two clocks"** pattern (Chris Wilson, 2013): a
`setInterval` wakes us every ~25 ms to *enqueue* upcoming ticks, but each tick
carries the **absolute AudioContext time** it should sound, ~100 ms ahead, so
consumers schedule with `setValueAtTime` etc. and stay tight regardless of timer
jitter.

## Requirements

- **REQ-1** — Subscribers get `(stepIndex, audioTime)` per 16th-note tick,
  scheduled `SCHEDULE_AHEAD_S` ahead.
- **REQ-2** — `onStart` fires before the first tick; `onStop` on stop. Order
  matters: the [arrangement](arrangement.md) subscribes first.
- **REQ-3** — BPM and swing are live-settable; swing delays off-beat 16ths.

## Technical design

### Contract / public interface

```yaml
Clock:   # src/audio/transport/clock.ts (implements TickSubscriber)
  get playing: boolean
  get step: number
  setBpm(b)            # clamped 20..400 internally
  setSwing(s)          # 0 (straight) .. 1
  start() / stop()
  onTick(fn) / onStart(fn) / onStop(fn) -> unsubscribe
constants: LOOKAHEAD_MS = 25, SCHEDULE_AHEAD_S = 0.1
TickListener: (step, when) => void        # tick-source.ts
```

### Data shapes (registry)

```yaml
transport.bpm:   { range: 40..240, default: 120, step: 1, format: bpm }
transport.swing: { range: 0..1, default: 0 }
```

### Layer touchpoints & ordering

```yaml
engine (subscribeParams): transport.bpm -> clock.setBpm; transport.swing -> clock.setSwing
construction order (engine): new Arrangement(...) BEFORE the machines, so on each
  tick the play banks are settled before the machines read them (see arrangement.md)
UI: header transport-play button toggles clock.start()/stop()
```

Note the registry clamps BPM to `40..240` for the UI knob, while `Clock.setBpm`
clamps to `20..400` — Tape Stop ([performance](performance.md)) ramps BPM below
the UI floor.

## Scenarios (BDD)

```gherkin
Scenario: Ticks carry absolute audio time ahead of now
  Given the clock is started
  When a tick fires for step n
  Then its `when` is in the future by up to SCHEDULE_AHEAD_S
# pinned by: tests/audio/transport/clock.test.ts

Scenario: Swing delays the off-beat 16ths (edge)
  Given setSwing(0.5)
  Then even steps keep their time and odd steps are pushed later
# pinned by: tests/audio/transport/clock.test.ts
```

## Tests & verification

- `tests/audio/transport/clock.test.ts` (uses an injectable test clock).
- `npm test`.

## Open questions / future

- `step` is a monotonically increasing 16th counter; bar logic is `step %
  SEQ_LENGTH` (consumed by the arrangement + step machines).
