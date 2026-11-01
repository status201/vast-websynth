# Transport position (moving the playhead)

```yaml
id: transport-position
status: implemented
version: 8
owner: core
related:
  - architecture
  - typography          # the readout is mono, not the faceplate serif
  - transport
  - arrangement
  - sequencer
  - motion-sequencer
  - performance
  - midi-clock-sync
  - onboarding
  - transport-window
  - transport-loop      # its wraps are seeks without a click
  - audio-export
  - render-to-sampler
  - step-grid-editing
  - meter
  - runtime-performance
  - ../decisions/adr-014-dont-make-me-think
source:
  - src/audio/transport/clock.ts
  - src/audio/transport/tick-source.ts
  - src/audio/transport/arrangement.ts
  - src/audio/transport/sequencer.ts
  - src/audio/transport/motion-machine.ts
  - src/audio/transport/performance.ts
  - src/audio/engine.ts
  - src/ui/studio-api.ts
  - src/ui/components/playhead-ruler.ts
  - src/ui/panels/step-panel-scaffold.ts
  - src/ui/audible.ts                       # the playhead is drawn when it is heard
  - src/ui/components/transport-controls.ts
  - src/ui/shell/play-button.ts             # the beat blink, likewise
  - src/ui/shortcuts.ts
```

Moving the playhead: a **seek** on the running (or stopped) transport, and the two UI
surfaces that expose it — a clickable position ruler above every machine grid, and
keyboard shortcuts.

## Background / Why

`start()` cannot move a running clock, and the grid playhead is not a position
display: it is hidden when the edit bank differs from the play bank or the lane rests
([banks](banks.md) REQ-follow-tracks-the-play-bank,
[arrangement-rest](arrangement-rest.md) REQ-a-resting-lane-plays-nothing), and silent
while a machine is disabled or the transport is stopped. So the **ruler** shows the
transport position unconditionally, and the cell highlight keeps its meaning ("this
bank's step is sounding"). The hard part: positions are counted **relatively**. The
arrangement advances `+1` per bar line, motion interpolates latched ticks, the
sequencer carries tie state, and stutter remaps against an anchor. None derive from
`clock.step`, so a seek must re-base each of them.

## Requirements

- **REQ-seek-moves-which-step-not-when** — `Clock.seek(step)` sets the step counter and
  does **not** touch `nextStepTime`, so a live jump stays in time with no retrigger.
  (`start()` re-origins the grid to `currentTime + 0.05`.) It works playing or
  stopped.
- **REQ-one-position-number-not-two** — `seek(step)` sets the counter *and* a **cue**
  (`_cue`), and `start(fromStep = cue)` begins there. A start point held apart from
  the position would be invisible state (ADR-014 law 5). With no seek the cue is `0`,
  so a plain `start()` begins at step 0. `stop()` leaves both alone, so Stop → Play
  resumes from the last seek.
- **REQ-seek-has-its-own-listener-channel** — `Clock.onSeek(fn)` fires
  **synchronously** inside `seek()`. The arrangement is built before the machines
  ([arrangement](arrangement.md) REQ-arrangement-is-built-before-the-machines), so its
  play banks settle first.
- **REQ-every-relative-consumer-reacts-to-a-seek** — A seek is complete only when
  every relative consumer has re-based (the table below). The drum and sampler
  machines hold no position state.
- **REQ-motion-baselines-survive-a-seek** — A seek clears motion's tick latch **only**.
  `restoreBaselines()` would snap every automated param and then re-capture baselines
  from automated values, losing the originals for the session. Copying `onStart`'s
  reset here is wrong.
- **REQ-seeking-is-refused-in-three-states** — Through one guard, so every surface
  disables itself consistently:
  - **sync slave** (`sync.activeMode === 'slave'`): the remote transport owns the
    playhead;
  - **a song export** or **a bank render** in flight: both bound their capture by an
    absolute step ([audio-export](audio-export.md)
    REQ-export-song-renders-from-the-top, [render-to-sampler](render-to-sampler.md)).

  A refused seek is a **silent no-op returning `false`**. A free-form manual take does
  **not** take the guard, since jumping around mid-take is what it is for. So the
  guard reads `recorder.isExporting()`, while the sampler-choke suppression on
  `clock.onStop` reads the wider `isCapturing()`.
- **REQ-a-sync-master-announces-its-seek** — While `master`, every jump broadcasts
  `songposition` + `continue`, never `start` ([midi-clock-sync](midi-clock-sync.md)
  REQ-a-midi-master-announces-its-seek). `SyncController` subscribes `clock.onSeek`,
  so a [loop](transport-loop.md) wrap ([transport](transport.md)
  REQ-a-step-router-can-redirect-the-next-step) announces exactly like a user seek.
- **REQ-one-seek-entry-point** — `Engine.seekTo(step): boolean` owns the guard;
  `Engine.canSeek(): boolean` reports it. Both are on `StudioApi`, so no surface calls
  `clock.seek` directly.
- **REQ-a-position-ruler-above-every-grid** — A strip aligned to the step columns,
  showing the transport position **unconditionally** (stopped, disabled machine, any
  edit/play relationship), plus a readout (REQ-the-readout-never-invents-bars).
  Clicking column `i` seeks to that cell of the current bar. It is built once
  (`playhead-ruler.ts`, wired from `step-panel-scaffold.ts`) and driven by the
  **clock**, not the machines' `onStep`.
- **REQ-the-ruler-costs-nothing-off-screen** — It obeys the panel's `VisibilityGate`
  ([runtime-performance](runtime-performance.md) REQ-no-work-for-offscreen-dom,
  [step-grid-editing](step-grid-editing.md) REQ-an-offscreen-grid-repaints-nothing): no
  DOM writes while hidden, and a re-sync on reveal. The ticks carry **no CSS
  transition**, because the lit class moves every 16th
  ([transport-window](transport-window.md) REQ-the-scrubber-presents-as-a-timeline).
- **REQ-home-and-shift-arrows-seek** — `Home` returns to bar 1 step 1;
  `Shift+ArrowLeft`/`Shift+ArrowRight` move ∓/± one bar, column zeroed. A bare arrow
  does nothing globally, since the octave is `-`/`=` (input-control.md
  REQ-octave-shift-is-minus-and-equal). A refused seek does not `preventDefault`, so
  the key falls through (the `boolean`-returning `UiBridge` idiom).
- **REQ-the-look-ahead-horizon-is-not-cancelled** — Hits are committed up to
  `scheduleAheadS` ahead (0.1 s; 0.2 s on the weak tier) with no retained handles, so
  that much old-position audio sounds after a jump. Accepted: cancelling every
  scheduled voice would cost more than the artefact.
- **REQ-every-ruler-tick-carries-a-title** — Every tick's `title` names the gesture.
  Each tab's ruler carries a help badge (`transport.ruler.<lane>`,
  [onboarding](onboarding.md) REQ-the-playhead-ruler-carries-a-badge), and the keys are
  in the About shortcut table ([onboarding](onboarding.md)
  REQ-about-key-symbols-are-drawn) and the README: the
  [recipe](../recipes/design-an-interaction.md)'s discoverability triple.
- **REQ-the-cue-and-the-playhead-are-two-marks** — **`AT_CLASS = 'playing'`** marks
  `clock.step`, **only while playing**. **`CUE_CLASS = 'cue'`** marks `clock.cue`
  whenever it differs from the live mark. A stopped ruler therefore says "Play starts
  here", and shows where Stop → Play resumes. Both are **global** (un-hashed) classes,
  so E2E can select them; `cue` is already a global state class
  ([play-button-blink](play-button-blink.md)). One tick may carry both and must stay
  legible.
- **REQ-the-readout-never-invents-bars** — With no chain lane enabled
  (`arrangement.songBars() === 0`), a disabled lane loops its edit bank, so the readout
  names **`BANK A`** through the same `laneHooks` accessor as the `BankBar`. It reads
  the **edit** bank, not the cached `<lane>PlayBank`, which reads stale after a bank
  click while stopped. Otherwise it is **`BAR n/N`**, `n = bar % songBars() + 1`,
  agreeing with the Song scrubber ([transport-window](transport-window.md)). It is set
  in **`--mono`** ([typography](typography.md) REQ-mono-is-readouts-and-pasted-text), so
  a counting `n` does not shuffle `/N`.
- **REQ-a-bar-stepper-only-where-bars-exist** — In `BAR` mode the readout is `‹ BAR n/N
  ›`, and the arrows seek ∓/± one bar **preserving the cell** (`(bar ± 1) × barTicks +
  pos % barTicks`), clamped to `[0, songBars())`. That is the one move `Shift`+arrows
  cannot make. In `BANK` mode the arrows are **hidden**, never a bank switcher (law 2;
  the `BankBar` owns that).
- **REQ-a-refused-seek-says-so** — While `!canSeek()` the ticks and stepper carry
  `aria-disabled` and a title naming the reason. They stay un-`disabled`, so the
  silent no-op is unchanged. Tick titles name the **beat**, matching the printed
  `1 2 3 4`.
- **REQ-the-ruler-is-the-lanes-grid** — Tick count, beat numbering and accents come
  from `laneGrid()`, the resolver the grid uses ([meter](meter.md)
  REQ-accents-and-ruler-derive-from-the-meter/REQ-cells-beyond-the-length-are-hidden).
  Ticks past the played length are `hidden`, so all sixteen testids resolve and a
  meter change is a class flip. Every bar computation here uses `barTicks`.
- **REQ-a-tick-sits-over-the-step-it-marks** — `playheadRulerFor` hands the panel two
  pieces to place, so the ruler's label slot must be the **same width** as the rows
  beneath. A panel overriding that width does so from **one constant used by both
  rows** (a widened sampler cluster once put every tick 80 px left). Pinned by
  geometry, not class names.
- **REQ-the-playhead-is-drawn-when-it-is-heard** — The clock hands steps out up to
  `scheduleAheadS` early. So every playhead display (the lit step on the grids, the
  ruler tick and readout, the transport readout and timeline, the Play blink) moves
  when its step is **heard**. `audibleTimeline(api)` (`src/ui/audible.ts`, one per
  clock) runs UI work at an audio time via `setTimeout(when − currentTime)`, cancels
  pending work on `clock.onStop`, and keeps the heard `step`. Each machine's `onStep`
  reports the step's audio time. `wirePlayhead` decides *whether* to light the step
  when it is reported, because by the time a bar's last steps are heard the
  arrangement may have moved on. The ruler, readout and blink read the heard step
  while playing. Seek controls still act on `clock.step`, because a seek is made
  against the scheduler.

## Technical design

### Contract / public interface

```yaml
Clock:   # src/audio/transport/clock.ts — additions to transport.md's contract
  seek(step): void          # _cue = _step = clamp(step, 0, MAX_STEP)
                            # (transport.md REQ-the-step-counter-is-bounded-at-ingress);
                            # nextStepTime UNTOUCHED; fires onSeek synchronously
  get cue: number           # where a plain start() begins (0 until the first seek)
  start(fromStep = this.cue)
  onSeek(fn: () => void) -> unsubscribe

TickSubscriber:  # src/audio/transport/tick-source.ts
  onSeek(fn: () => void): () => void

Arrangement:  # src/audio/transport/arrangement.ts
  seekTo(step)   # onStart and onSeek both call seekTo(clock.step)

Engine / StudioApi:
  seekTo(step: number): boolean   # false = refused
  canSeek(): boolean              # same predicate, for disabling UI

buildPlayheadRuler(engine, lane, gate?, hooks?): PlayheadRuler  # src/ui/components/playhead-ruler.ts
  hooks: { getBank(): number; onBankChange(fn): () => void }
    # from laneHooks (getEdit/onEditChange) — the BankBar's accessor. The component
    # must not import the scaffold (the scaffold imports it).
PlayheadRuler:
  cellsEl: HTMLElement     # ONLY the cell strip (see alignment below)
  barEl: HTMLElement       # the readout group: BANK mode -> a label; BAR mode -> ‹ label ›
  destroy(): void
playheadRulerFor(engine, lane, gate?): PlayheadRuler      # src/ui/panels/step-panel-scaffold.ts
  # testids: ruler-<lane>-<0..15>, ruler-<lane>-bar, ruler-<lane>-bar-prev, ruler-<lane>-bar-next
  # state classes: `playing` (live step, playing only) + `cue`, both GLOBAL
```

### The reactions (REQ-every-relative-consumer-reacts-to-a-seek)

| Consumer | Position state that breaks | Reaction on `onSeek` |
| --- | --- | --- |
| `Arrangement` | lane positions advance `+1` per bar line, never derived from `clock.step`; a bar-aligned landing would double-advance | `seekTo(step)`: `laneSeek` per lane from `floor(step / barTicks)`, `expectFirstBar = step % barTicks === 0`, `recompute()`, `notify()` |
| `StepSequencer` | per-track `prevTied` / `lastPlayedNote` | release every track at **its last gate end** and clear `prevTied` ([sequencer](sequencer.md) REQ-a-seek-releases-every-tracks-note); subscribed in the constructor |
| `MotionMachine` | latched cells before and after the jump are not adjacent, so the loop would glide from a stale anchor | empty the latch only, **not** `restoreBaselines()` |
| `Performance` | `mapStep` clamps into the *old* stutter window | re-anchor while stutter is on |
| `DrumMachine`, `SamplerMachine` | none — stateless per tick | none |

### Layer touchpoints & ordering

```yaml
seek fan-out order (construction order, arrangement.md REQ-arrangement-is-built-before-the-machines):
  Clock.seek -> Arrangement.seekTo (play banks settle) -> machines -> UI ruler
engine: seekTo() guards on sync.activeMode / recorder.isExporting() / bank render,
        then clock.seek(step)
sync:   SyncController subscribes clock.onSeek -> announcePosition (a no-op unless master)
recorders: recorder-controller.ts and bank-render.ts call start(0) EXPLICITLY — a plain
        start() begins at the cue
ui ruler: driven by clock.onTick + clock.onSeek (NOT machine onStep); gated by the
        panel's VisibilityGate, re-synced on whenShown
```

### Ruler alignment

Every grid has a control column to its left, with a different shape per panel. So
`buildPlayheadRuler` returns **only** the cell strip plus a detached readout, and each
panel wraps them in a row built like its own track rows. The panel's CSS grid aligns
it, and no shared component knows four layouts. The ruler is not in the machine
header, which has almost no slack ([responsive-machine-header](responsive-machine-header.md)).

### Gesture inventory (ruler)

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| tap / click | seek to that cell of the current bar | DAW timeline click-to-locate |
| drag | — (would fire one seek per column crossed) | — |
| long-press | — | — |
| right-click | — | — |
| double-tap | — (tap already seeks) | — |
| wheel | — | — |
| `Home` | seek to bar 1 step 1 | DAW return-to-start |
| `Shift`+`←`/`→` | ∓/± one bar, column zeroed | DAW bar navigation |
| click `‹` / `›` | ∓/± one bar, **column preserved** | DAW bar-locate buttons |

No outcome depends on hidden state (law 2). The stepper is *absent* in `BANK` mode
rather than repurposed.

### Persistence

Nothing. The cue and the position are transient. `_cue` is not a `ParamBus` param, so
it never leaks into a preset or `SongFile`.

## Visual aids

Beat numbers print on the beat columns only.

```
No chain lane enabled (the default) — bars do not exist, so none is claimed:

  BANK A  ▏ 1 ▕   ▕   ▕   ▕ 2 ▕   ▕   ▕   ▕ 3 ▕   ▕   ▕   ▕ 4 ▕   ▕   ▕   ▏
  ruler-drum-bar    ▲ █ = playing (clock.step)   ▲ ◌ = cue (Play starts here)
  ┌──────────┬────────────────────────────────────────────────────────────┐
  │ KICK mute│ ■ · · · ■ · · · ■ · · · ■ · · ·                            │  the grid

A chain is enabled — the stepper appears and the bar wraps at song length:

  ‹ BAR 3/4 ›  ▏ 1 ▕   ▕   ▕   ▕ 2 ▕ █ ▕   ▕   ▕ 3 ▕   ▕   ▕   ▕ 4 ▕   ▕   ▕   ▏
  ▲ -bar-prev / -bar-next: same cell, previous/next bar
```

## Scenarios (BDD)

```gherkin
Scenario: Clicking the ruler moves the playhead while playing
  Given the transport is playing
  When the user clicks ruler column 7 on the drum tab
  Then clock.step % 16 is 7 and the transport is still playing
  And the tempo grid is unchanged (no retrigger, nextStepTime untouched)
# pinned by: tests/audio/transport/clock.test.ts, e2e/transport-position.spec.ts

Scenario: A seek while stopped cues the start point
  Given the transport is stopped
  When the user clicks ruler column 4 and then presses Play
  Then the first tick fires for step 4
# pinned by: tests/audio/transport/clock.test.ts, e2e/transport-position.spec.ts

Scenario: A plain start() begins at 0 when nothing was seeked (regression, REQ-one-position-number-not-two)
  Given the clock has never been seeked
  When start() is called
  Then it begins at step 0
# pinned by: tests/audio/transport/clock.test.ts

Scenario: Seeking re-seeks the arrangement lanes (REQ-every-relative-consumer-reacts-to-a-seek)
  Given seqChain = { enabled: true, steps: [0,0,1,0] } and the transport is playing
  When the playhead is seeked to bar 2
  Then seqPlayBank is B immediately, and A on the next bar
# pinned by: tests/audio/transport/arrangement.test.ts, e2e/transport-position.spec.ts

Scenario: A seek landing on a bar line does not double-advance (edge, REQ-every-relative-consumer-reacts-to-a-seek)
  Given an enabled chain and a seek to an exactly bar-aligned step
  Then that bar plays the slot the seek implies, and the NEXT bar line advances
       it by exactly one
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: Motion keeps its baselines across a seek (REQ-motion-baselines-survive-a-seek)
  Given the motion machine has automated filter cutoff and recorded its baseline
  When the playhead is seeked mid-play
  Then the tick latch is cleared and cutoff jumps to the curve's value at the new
       position — but the recorded baseline is unchanged
  And stopping afterwards still restores the ORIGINAL pre-automation value
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: A tied sequencer note does not slur across a seek (edge, REQ-every-relative-consumer-reacts-to-a-seek)
  Given a sequencer step tied into the next one is currently sounding
  When the playhead is seeked elsewhere
  Then the held note is released and the new position starts clean
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: Seeking under active stutter re-anchors (edge, REQ-every-relative-consumer-reacts-to-a-seek)
  Given stutter is engaged so mapStep is clamping to a window
  When the playhead is seeked backwards past the anchor
  Then the stutter window re-anchors to the new position instead of replaying
       the old one
# pinned by: tests/audio/transport/performance.test.ts

Scenario: A slaved instance refuses to seek (REQ-seeking-is-refused-in-three-states)
  Given sync mode is slave and a master is driving the clock
  When the user clicks the ruler
  Then nothing moves, seekTo returns false, and canSeek() is false
# pinned by: tests/audio/engine-seek.test.ts

Scenario: Seeking is refused while the song recorder is capturing (REQ-seeking-is-refused-in-three-states)
  Given an Export Song capture is in flight
  Then seekTo returns false, so the capture cannot be truncated
# pinned by: tests/audio/engine-seek.test.ts

Scenario: A master announces its seek so slaves follow (REQ-a-sync-master-announces-its-seek)
  Given sync mode is master and the transport is playing
  When the playhead is seeked
  Then songposition + continue are broadcast — and start is NOT
# pinned by: tests/audio/transport/sync/sync-master.test.ts

Scenario: The ruler shows the position when the grid highlight cannot
  Given the drum machine is switched off, or the edit bank differs from the play bank
  Then the ruler still tracks the transport, while the cell highlight stays dark
# pinned by: tests/ui/playhead-ruler.test.ts

Scenario: A hidden ruler does no per-tick work, and re-syncs on reveal (REQ-the-ruler-costs-nothing-off-screen)
  Given the transport is playing and a machine panel's tab is not the visible one
  Then its ruler is not touched at all
  When the tab is revealed
  Then the ruler jumps to the step playing NOW, not the one it was left on
# pinned by: tests/ui/playhead-ruler.test.ts

Scenario: Shift+Arrow moves a bar without shifting the keyboard octave (edge, REQ-home-and-shift-arrows-seek)
  Given the transport is playing
  When the user presses Shift+ArrowRight
  Then the playhead advances exactly one bar
  And the on-screen keyboard's octave is unchanged
# pinned by: e2e/transport-position.spec.ts

Scenario: A ruler tick lines up with the step beneath it (regression, REQ-a-tick-sits-over-the-step-it-marks)
  Given any machine tab
  When the ruler and the step grid are measured
  Then tick 0 and step 0 share a left edge
# pinned by: e2e/transport-position.spec.ts

Scenario: A stopped ruler shows a cue, never a playhead (REQ-the-cue-and-the-playhead-are-two-marks)
  Given the transport is stopped
  When the user clicks ruler column 6
  Then that tick carries the `cue` class
  And NO tick on the strip carries the `playing` class
  When the user presses Play
  Then a `playing` mark advances from column 6 while the cue ring stays there
# pinned by: tests/ui/playhead-ruler.test.ts, e2e/transport-position.spec.ts

Scenario: The readout names the bank when no chain is enabled (REQ-the-readout-never-invents-bars)
  Given no lane's chain is enabled and the drum edit bank is B
  Then the drum ruler's readout reads "BANK B" and shows no bar stepper
  When the edit bank changes to C
  Then the readout follows, agreeing with the BankBar beside it
# pinned by: tests/ui/playhead-ruler.test.ts, e2e/transport-position.spec.ts

Scenario: The readout wraps at song length once a chain exists (REQ-the-readout-never-invents-bars)
  Given seqChain = { enabled: true, steps: [0,0,1,0] }
  When the playhead is at absolute bar 6
  Then the readout reads "BAR 3/4" — the same bar the Song scrubber lights
# pinned by: tests/ui/playhead-ruler.test.ts

Scenario: The bar stepper keeps the cell (REQ-a-bar-stepper-only-where-bars-exist)
  Given a chain is enabled and the playhead is at bar 2, step 5 of that bar
  When the user clicks the ruler's next-bar arrow
  Then it seeks to bar 3 step 5 — unlike Shift+Arrow, which would zero the step
  And clicking prev-bar at bar 1 is clamped, never negative
# pinned by: tests/ui/playhead-ruler.test.ts

Scenario: A refused seek stops promising it will work (REQ-a-refused-seek-says-so)
  Given sync mode is slave, so canSeek() is false
  Then the ticks and the stepper are aria-disabled and their titles name the reason
# pinned by: tests/ui/playhead-ruler.test.ts

Scenario: The lit step waits for its sound (REQ-the-playhead-is-drawn-when-it-is-heard, regression)
  Given the transport is playing and a step is scheduled 80 ms ahead
  When the machine reports it
  Then the grid, the ruler and the readout still show the previous step
  And they move to it once the audio clock reaches its time
  And a stop cancels whatever was still pending
# pinned by: tests/ui/audible.test.ts, tests/ui/playhead-ruler.test.ts
```

## Tests & verification

- Unit: `tests/audio/transport/{clock,arrangement,sequencer,motion-machine,performance}.test.ts`,
  `tests/audio/engine-seek.test.ts`, `tests/ui/playhead-ruler.test.ts`,
  `tests/ui/audible.test.ts` — `npm test`. E2E: `e2e/transport-position.spec.ts`.
- Dev bridge: `window.__synth.engine.clock.step`,
  `window.__synth.engine.arrangement.seqPlayBank` (DEV only).

## Open questions / future

- **Scrub-drag** across the ruler is deferred: it would fire a seek per column, each a
  full arrangement re-seek plus a voice release. It needs coalescing (seek on
  pointerup, preview during the drag).
- Cancelling the in-flight look-ahead would need every machine to retain handles to
  its scheduled voices. Only worth it if the artefact ever proves audible.
