# Live trigger timing (a hit with no time of its own starts one render burst ahead)

```yaml
id: live-trigger-timing
status: implemented
version: 3
owner: core
related:
  - voicing          # live notes: Polyphony.playNote / releaseNote
  - drum-machine     # the pad audition: DrumMachine.triggerTrack
  - sampler          # the slot audition, MIDI pads and Stop's cut: triggerSlot, stopAll
  - envelopes        # REQ-envelope-scheduling-is-future-time-safe: the attack this protects
  - ../decisions/adr-010-musical-stable-cheap-dsp
source:
  - src/audio/param-utils.ts                  # liveStartTime, LIVE_MARGIN_MAX_S
  - src/audio/polyphony.ts
  - src/audio/transport/drum-machine.ts
  - src/audio/transport/sampler-machine.ts
```

One rule for where a sound lands when nothing gave it a time: a key, a QWERTY
note, a MIDI note, a drum pad, a sampler pad. The sequencer, the arpeggiator and
every machine already schedule ahead by the transport's look-ahead and are not
touched by it.

## Background / Why

Every trigger is automation on an absolute clock: an envelope anchored with
`setValueAtTime` and approached with `setTargetAtTime`, a pitch sweep, a gain
ramp. A live trigger used to take `ctx.currentTime` as its time. But the renderer
runs a device callback's worth of quanta back to back, and an event read during
that burst can already be in the past. Web Audio renders a past-anchored curve as
if it had been running all along, so the first audible sample is most of the way
through the attack: a click on the first sample, at random, more often on a busy
machine. A MONO/POLY switch and Panic idle every voice, which made the next note
the easiest place to hear it.

A partial margin does not help: one stale quantum (2.7 ms) already skips about
80% of a 5 ms attack. The margin has to cover the whole burst, and the browser
reports the burst as `baseLatency`.

## Requirements

- **REQ-a-live-trigger-starts-ahead-of-the-render** — A trigger with no time of
  its own is placed at `liveStartTime(ctx)`: `currentTime` plus one render burst,
  `baseLatency`, bounded to one render quantum at least and `LIVE_MARGIN_MAX_S`
  (20 ms) at most. A realtime context reporting no burst (Gecko reports
  `baseLatency` `0`) gets `LIVE_MARGIN_MAX_S`; an offline context, which has no
  render burst to outrun, gets one quantum. Through the real graph, in both
  engines, notes and pad hits anchored at `currentTime` clicked at random under
  load and the same hits a burst ahead did not.
- **REQ-a-live-release-takes-the-same-margin** — A live release (`releaseNote`
  with no time) takes the same margin as the attack it ends, so a quick tap still
  releases after it attacks.
- **REQ-a-cut-made-now-starts-ahead-of-the-render** — A fade that ends a sound
  *now* is a trigger too: Stop's sampler cut (`SamplerMachine.stopAll`, a 5 ms
  ramp) lands at `liveStartTime`. Anchored at bare `currentTime`, a ramp that
  short can already be over when it renders, which makes it a hard cut.
  Deliberate: the synth's kill (Panic, a MONO/POLY switch) measured clean at
  `currentTime` and is left there.
- **REQ-the-margin-follows-the-device** — The margin is the device's burst, not a
  constant, where the browser reports one: 10 ms in Blink on a typical Windows
  setup, less on a low-latency device. Where it does not (Gecko), it is the 20 ms
  ceiling, because 10 ms was measured too short there; that is the added
  key-to-sound latency a Firefox player pays.

## Technical design

```ts
// src/audio/param-utils.ts
export const LIVE_MARGIN_MAX_S = 0.02;
export function liveStartTime(ctx: BaseAudioContext): number;
```

Callers: `Polyphony.playNote` / `releaseNote` when `when` is absent,
`DrumMachine.triggerTrack`, `SamplerMachine.triggerSlot`, `SamplerMachine.stopAll`.

## Scenarios (BDD)

```gherkin
Scenario: A live note and its release land one burst ahead (REQ-a-live-trigger-starts-ahead-of-the-render, REQ-a-live-release-takes-the-same-margin)
  Given the context reports a baseLatency of 10 ms
  When a key plays a note with no time of its own, and releases it
  Then both are placed at currentTime + 10 ms
# pinned by: tests/audio/polyphony.test.ts

Scenario: The margin is bounded both ways (REQ-the-margin-follows-the-device, edge)
  Given an offline context, or a realtime one reporting a baseLatency of 0, or one of 500 ms
  When a live note plays
  Then it lands one render quantum ahead, LIVE_MARGIN_MAX_S ahead, or LIVE_MARGIN_MAX_S ahead
# pinned by: tests/audio/polyphony.test.ts

Scenario: A pad audition starts one burst ahead (REQ-a-live-trigger-starts-ahead-of-the-render, regression)
  Given the context reports a baseLatency
  When a drum pad or a sampler pad is triggered by hand
  Then its hit is scheduled at currentTime + baseLatency
# pinned by: tests/audio/transport/drum-machine.test.ts, tests/audio/transport/sampler-machine.test.ts

Scenario: Stop's sampler cut lands one burst ahead (REQ-a-cut-made-now-starts-ahead-of-the-render, regression)
  Given a sampler hit sounding and a context reporting a baseLatency
  When the transport stops
  Then the hit's fade is anchored at currentTime + baseLatency, not at currentTime
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A scheduled hit is untouched (REQ-a-live-trigger-starts-ahead-of-the-render)
  Given a note or a step that carries its own time
  Then it is scheduled exactly there
# pinned by: tests/audio/polyphony.test.ts
```

## Tests & verification

- `tests/audio/polyphony.test.ts`, `tests/audio/transport/drum-machine.test.ts`,
  `tests/audio/transport/sampler-machine.test.ts`.
- By ear, on a busy machine: fast notes on the computer keys and repeated pad
  taps, especially right after Panic or a MONO/POLY switch. No first-sample clicks.
- `--browser firefox` takes read onsets since [audio-export](audio-export.md)
  REQ-a-silent-quantum-is-captured-as-silence; before it, a Firefox take opened
  only once the note was sounding.
