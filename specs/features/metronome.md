# Metronome

```yaml
id: metronome
status: implemented
version: 1
owner: core
related:
  - architecture
  - transport
  - meter               # what a beat and a bar are
  - transport-position  # beats are painted when heard
  - sample-recorder     # the one surface that holds it
  - runtime-performance # costs nothing while nobody holds it
source:
  - src/audio/metronome.ts
  - src/audio/engine.ts        # beatTicks
  - src/ui/studio-api.ts       # beatTicks for the UI
```

A beat source plus an optional click, for recording against the tempo. While
the transport plays, it follows the transport; while it is stopped, it keeps
time on its own at the current BPM, so a beat light never goes dark and a click
can be recorded against without starting the song.

## Background / Why

The [sample recorder](sample-recorder.md) can record over a playing song, and
wants a tempo to play to when the song is stopped. The transport has no click,
and adding one to the clock would put a voice on the master bus that every
export would then have to exclude. So the metronome is its own small audio
object: it **reads** the clock, never drives it, and plays to `ctx.destination`.

## Requirements

- **REQ-a-metronome-runs-only-while-held** — `acquire()` returns a release.
  While nothing holds it, the metronome has no timer, no clock subscription and
  schedules nothing. It is built by `createMetronome(engine)` from the chunk that
  wants it (today, only the sample studio's lazy chunk), so it adds nothing to
  boot ([runtime-performance](runtime-performance.md)). The last release cancels
  its timer and unsubscribes from the clock.
- **REQ-beats-follow-the-transport-while-playing** — While the clock plays, a beat
  is every tick whose step is a multiple of `beatTicks`, at that tick's audio
  time. It is a **downbeat** when the step is a multiple of `barTicks`
  ([meter](meter.md) REQ-bar-ticks-is-the-arrangement-bar-line). Both are read
  per tick, so a meter change takes effect at the next beat.
- **REQ-beats-run-free-while-stopped** — While the clock is stopped, a look-ahead
  timer (every 25 ms, 100 ms ahead) lays beats `beatTicks × sixteenthDuration()`
  apart at the current BPM, with a downbeat every `barTicks / beatTicks` beats.
  The free run continues from the last transport beat's time and bar position,
  so stopping the song does not jolt the beat. Starting the song hands the beat
  back to the transport.
- **REQ-the-click-is-outside-the-master-bus** — The click is a short synthesized
  blip, higher on the downbeat, scheduled sample-accurately at the beat's audio
  time. It goes straight to `ctx.destination`, so it is never in a master
  recording, an export or a render. It is **off** by default (`setClick`).
- **REQ-a-count-in-forces-the-click** — `countIn()` returns the audio time of
  the downbeat a take should start on, and makes the click audible for every
  beat before it, whatever `setClick` says:
  - **Stopped**: the free run restarts with a downbeat 100 ms from now, and the
    count is that whole bar.
  - **Playing**: the count ends on the next transport downbeat at least one beat
    away. Its time is extrapolated from the newest tick at the current tempo.

  `cancelCountIn()` ends the forced click early.
- **REQ-beat-listeners-get-audio-time** — `onBeat(fn)` hands each beat to its
  listeners as `{ when, downbeat, index, playing }` when it is **scheduled**, up
  to the look-ahead early. A display paints it at `when` through the shared
  `audibleTimeline().at` ([transport-position](transport-position.md)
  REQ-the-playhead-is-drawn-when-it-is-heard). A throwing listener is skipped,
  never allowed to stop the beat.

## Technical design

### Contract / public interface

```yaml
src/audio/metronome.ts:
  createMetronome(host: MetronomeHost): Metronome
  MetronomeHost: { ctx: currentTime/destination/createOscillator/createGain, clock: playing/bpm/sixteenthDuration()/onTick/onStart/onStop, barTicks, beatTicks }
  Metronome.acquire(): () => void        # refcounted hold
  Metronome.setClick(on: boolean): void  # the audible click; default off
  Metronome.click: boolean
  Metronome.onBeat(fn: (b: Beat) => void): () => void
  Metronome.countIn(): number            # audio time of the take's downbeat
  Metronome.cancelCountIn(): void
  Metronome.beatDuration(): number      # one beat in seconds — the count's arithmetic reads this, never re-derives it
  Beat: { when: number, downbeat: boolean, index: number, playing: boolean }
engine.ts / StudioApi:
  beatTicks: number                      # ticksPerBeat(transport.beatUnit)
```

### Layer touchpoints & ordering

- The metronome only reads the clock (`onTick` / `onStart` / `onStop`), so
  it cannot wedge it ([transport](transport.md)): its own listeners run inside
  `try`.
- The click nodes (one oscillator + one gain per beat) are created at schedule
  time and disconnect themselves on `ended`.

### Persistence

None. The studio remembers its CLICK and Count-in choices for the rest of the
session ([sample-recorder](sample-recorder.md)); nothing is stored.

## Scenarios (BDD)

```gherkin
Scenario: Nobody holding it costs nothing (REQ-a-metronome-runs-only-while-held)
  Given a metronome that has been acquired and released
  Then it holds no timer and no clock subscription
  And no beat is scheduled afterwards
# pinned by: tests/audio/metronome.test.ts

Scenario: Beats follow the transport (REQ-beats-follow-the-transport-while-playing)
  Given a 4/4 meter and the transport playing
  When ticks 0 to 16 are handed out
  Then beats arrive on steps 0, 4, 8, 12 and 16 at their ticks' times
  And steps 0 and 16 are downbeats
# pinned by: tests/audio/metronome.test.ts

Scenario: Beats run free at the BPM when stopped (REQ-beats-run-free-while-stopped)
  Given the transport stopped at 120 BPM in 4/4
  When the metronome is held for a second of audio time
  Then beats are 0.5 s apart and every fourth is a downbeat
# pinned by: tests/audio/metronome.test.ts

Scenario: The click is off until asked for, and the count-in forces it (REQ-a-count-in-forces-the-click)
  Given a held metronome with the click off
  Then no click is scheduled for a beat
  When a count-in starts while stopped
  Then the four beats before the returned downbeat each schedule a click
  And the returned time is one bar after the first counted beat
# pinned by: tests/audio/metronome.test.ts

Scenario: The click sounds right (REQ-the-click-is-outside-the-master-bus)
  Given the studio open with CLICK on
  Then the click is audible over a playing song and clearly accents the downbeat
# not automated — a musical claim (ADR-010), heard in Firefox and Chrome
```

## Tests & verification

- `tests/audio/metronome.test.ts` against a stub clock and context.
- By ear (ADR-010), Firefox then Chrome: level against a demo song, downbeat
  accent, no drift between the light and the click.
