# Transport loop (loop a range of bars)

```yaml
id: transport-loop
status: implemented
version: 1
owner: core
related:
  - transport            # REQ-loop-discoverability: the step router the wrap runs through
  - transport-window     # the two surfaces the Loop button and the picks live on
  - transport-position   # the seek contract, its guard and its four reactions
  - arrangement
  - sequencer            # REQ-loop-costs-nothing-unless-engaged: a tie across a wrap releases at its gate end
  - midi-clock-sync      # REQ-23: a master announces every wrap
  - meter                # a bar is `barTicks`, not 16
  - song-mode            # REQ-loop-costs-nothing-unless-engaged: a load clears the loop
  - runtime-performance
  - onboarding
  - ../decisions/adr-014-dont-make-me-think
source:
  - src/audio/transport/transport-loop.ts     # the model + the pure wrap rule
  - src/audio/transport/loop-driver.ts        # wires the model to the clock
  - src/audio/transport/clock.ts              # setStepRouter (transport.md REQ-a-step-router-can-redirect-the-next-step)
  - src/audio/engine.ts                       # owns both; pushes barTicks
  - src/ui/components/transport-controls.ts   # the Loop button + scrubber picks
  - src/ui/panels/song-panel.ts               # a load clears the loop
```

Loop a range of bars: a **Loop** button on the song transport, and two clicks on
the bar timeline to choose which bars.

## Background / Why

Working on one part of a song means hearing that part again and again. The only
way to do that was to jump back by hand every time the bar ran out — the
scrubber ([transport-window](transport-window.md) REQ-the-bar-scrubber) moves the playhead once,
never repeatedly. Every DAW has a loop (Ableton's loop brace, Logic's cycle), and
it is the most-used transport control after Play.

The timing is the hard part, and the existing seek does not solve it. A seek is
applied whenever the user clicks, so up to `scheduleAheadS` of audio from the old
position still sounds after it ([transport-position](transport-position.md)
REQ-the-look-ahead-horizon-is-not-cancelled). That is fine once, but a loop jumps every few bars and has to land
exactly on the bar line. So the loop's jump happens **inside the clock's drain
loop**, at the moment the step counter moves past the loop's last step. The next
tick is then scheduled on the same tempo grid, with nothing left over from the
old position.

## Requirements

- **REQ-a-loop-button-on-both-surfaces** — **A Loop button on both transport
  surfaces.** `buildTransportControls` renders `<prefix>-loop` between the
  readout and the scrubber, so the Song-panel row and the TRANSPORT window each
  carry one ([transport-window](transport-window.md)
  REQ-one-transport-control-builder). Both mirror one shared model
  (`StudioApi.loop`), so they can never disagree. The button is lit (`on`,
  `aria-pressed="true"`) while Loop is on. Its `title` names the state: what
  clicking does when off, "Click the first and last bar" while waiting for a
  range, and "Looping bars A–B" once looping.

- **REQ-with-loop-on-a-click-picks-a-bar** — **While Loop is on, a scrubber
  click picks a bar instead of seeking.** The first click sets an **anchor**.
  The second sets the range from the anchor to that bar, inclusive, in either
  order — clicking bar 3 then bar 2 loops bars 2–3, and clicking the same bar
  twice loops that one bar. A new pick never interrupts playback: the old range
  keeps looping until the second click replaces it. With Loop off, a scrubber
  click seeks exactly as before.

  This is a **mode**, which [ADR-014](../decisions/adr-014-dont-make-me-think.md)
  law 2 prefers to avoid. The user asked for it (a button that, once on, lets you
  pick the range), and the laws' ordering allows it only because of these
  mitigations:
    - **The mode is visible on the target itself**, not only on the button (law 5).
      While Loop is on the scrubber carries a picking style, each cell's `title`
      says what a click will do ("Loop from bar N" / "Loop bars A–N"), and the
      anchor cell is marked.
    - **Seeking stays one gesture away.** ⏮, the machine-tab rulers, `Home` and
      `Shift`+arrows all still seek
      ([transport-position](transport-position.md) REQ-a-position-ruler-above-every-grid/REQ-home-and-shift-arrows-seek). Only the
      scrubber changes job, and only while its button is lit.
    - **The mode ends when you turn it off**, with the same button that started it.
  The DAW gesture, dragging a brace in a strip above the timeline, was rejected.
  It needs a second strip, which the row has no height for
  ([transport-window](transport-window.md) REQ-the-song-panel-transport-row/REQ-the-scrubber-presents-as-a-timeline), at touch size
  (law 6: 44 px). On a touch screen the drag would also collide with scrolling
  the timeline sideways.

- **REQ-the-loop-wraps-only-on-a-bar-line** — **The loop wraps only on a bar
  line.** After each emitted step the clock asks the loop where to go next
  (REQ-loop-discoverability of [transport](transport.md)). For a range of bars
  `[start, end]`, with `s = start·barTicks` and `e = (end+1)·barTicks`, the next
  step `n` is kept unless **all** of these hold: `n % barTicks === 0`, the loop
  is engaged and not refused (REQ-a-loop-that-cannot-jump-does-not), and
  `n < s || n >= e`. When they do, the transport goes to `s` instead. One rule
  covers both cases:
    - **inside the range**, playback reaches `e` and goes back to `s`, a seamless loop;
    - **outside it** (Loop engaged while playing somewhere else, or a seek out of
      the range), playback finishes the current bar and moves to `s` at the next
      bar line. It never cuts in mid-bar.

  A wrap is a real jump for everything that tracks position. The clock fires
  `onSeek`, so the arrangement, sequencer, motion machine and stutter all catch
  up to the new position ([transport-position](transport-position.md) REQ-every-relative-consumer-reacts-to-a-seek). It
  does **not** move the cue: the cue is set by the user (seek, Pause), and
  moving it on every wrap would make Stop → Play start somewhere the user never
  chose.

- **REQ-turning-loop-on-moves-the-cue** — **Turning a loop on while stopped
  moves the cue into it.** When Loop turns on (or the second pick completes a
  range) while the transport is stopped, and the cue lies outside the range, the
  cue moves to the range's first bar through `StudioApi.seekTo`. Play then
  starts inside the loop instead of playing an unrelated bar first. A cue
  already inside the range is left alone, so a pause inside the loop still
  resumes where it paused. While playing,
  REQ-the-loop-wraps-only-on-a-bar-line's next-bar-line rule applies instead.

- **REQ-turning-loop-off-keeps-the-range** — **Turning Loop off keeps the
  range.** Off stops the wrapping and clears any half-made pick (the anchor),
  but the range stays and is drawn **dimmed** on the scrubber. Turning Loop on
  again uses that range immediately. This matches the loop switch in a DAW,
  which remembers its range. The range is lost only when a song is loaded or a
  new song is started (REQ-loading-a-song-clears-the-loop).

- **REQ-a-loop-that-cannot-jump-does-not** — **A loop that cannot jump does not
  jump.** A wrap is a seek, so it is refused in exactly the states where
  `canSeek()` is false ([transport-position](transport-position.md) REQ-seeking-is-refused-in-three-states):
    - **slave**: the remote transport owns the playhead;
    - **export or bank render in flight**: both must play the whole song from
      step 0, so an engaged loop is **suspended** for their duration, never
      applied. Otherwise it would render the loop in place of the song.
  In those same states the Loop button and the scrubber picks do nothing and
  are marked unavailable, just as the scrubber's seek already is
  ([transport-window](transport-window.md) REQ-seeking-respects-the-one-guard). Play/Pause stays available:
  *controls* stay live, *position* does not
  ([midi-clock-sync](midi-clock-sync.md) REQ-a-slave-refuses-to-seek-locally).

- **REQ-the-loop-range-is-limited-to-the-song** — **The range is limited to the
  song's length without being edited.** The saved range is not changed when the
  song gets shorter. The *effective* range, used by both the wrap and the
  drawing, is limited to
  `songBars() || 1` (`effectiveLoopRange`). If a chain is shortened below the
  range, the loop shrinks to the bars that still exist. Lengthening the chain
  again brings back the range the user picked. Bar indices are also limited at
  input to `0..MAX_CHAIN_STEPS - 1` (`src/state/limits.ts`), with non-finite
  input refused.

- **REQ-a-sync-master-announces-every-wrap** — **A sync master announces every
  wrap.** A wrap is a jump, and slaves count pulses from their own start, so a
  silent wrap would leave them one loop behind, then two. `SyncController`
  subscribes to `clock.onSeek` and sends `songposition` + `continue` while it is
  master ([midi-clock-sync](midi-clock-sync.md) REQ-a-midi-master-announces-its-seek). Moving the announce
  there from `Engine.seekTo` makes **every** jump announce itself, whether a
  user seek or a loop wrap, from one place.

- **REQ-a-tied-note-does-not-hang-across-a-wrap** — **A tied note does not hang
  across a wrap.** A wrap happens while the last step before it may still be
  waiting in the look-ahead. The sequencer's seek reaction used to release held
  notes *now*, which is before a pending note-on, and that note-on then
  cancelled the release. The seek reaction now releases at each track's own gate
  end, the same way its stop reaction already does ([sequencer](sequencer.md)
  REQ-a-seek-releases-every-tracks-note/REQ-a-stop-releases-every-tracks-note).

- **REQ-loading-a-song-clears-the-loop** — **Loading a song clears the loop.** A
  range is a set of bars in *this* song. Every load and New already moves the
  playhead to bar 1 ([song-mode](song-mode.md) REQ-a-load-lands-on-bar-one), and the same step now
  turns Loop off and forgets the range. A demo clicked while looping then plays
  from its first bar instead of looping bars that mean nothing in the new song.

- **REQ-loop-bars-are-the-songs-bars** — **Bars are the song's bars.** The wrap
  measures with `barTicks` ([meter](meter.md) REQ-bar-ticks-is-the-arrangement-bar-line), which the engine sends to
  the loop driver from `applyMeter` like every other bar counter. In 3/4 a loop
  of bars 2–3 is ticks 12..35. A machine whose own length is longer than a bar
  ([meter](meter.md) REQ-each-machine-has-a-loop-length) restarts with the loop, just as it does on a
  scrubber seek.

- **REQ-what-the-loop-scrubber-shows** — **What the scrubber shows.** Cells
  inside the effective range carry the global `loop` class, and the anchor
  carries the global `loop-anchor` class. Both are global for the same reason
  `playing` and `cue` are: E2E has no other way past CSS-Module hashing. The
  scrubber carries a module class while picking (Loop on) and another while a
  remembered range is dimmed (Loop off). A cell may be `playing` and `loop` at
  once and must still read clearly. There are **no transitions**, since the
  classes move on picks, which are rare, and the `playing` class beside them
  moves every bar ([transport-window](transport-window.md)
  REQ-the-scrubber-presents-as-a-timeline). Cell classes and titles are redrawn
  on a loop change, a rebuild or an arrangement change (a shorter chain limits
  the range, REQ-the-loop-range-is-limited-to-the-song), never per tick. The
  arrangement notifies on every bar line, so the redraw first compares what it
  would draw with what it last drew and does nothing when they match.

- **REQ-loop-discoverability** — **Discoverability.** The Loop button's `title`
  (REQ-a-loop-button-on-both-surfaces), the cells' pick titles
  (REQ-with-loop-on-a-click-picks-a-bar) and the `transport.song` help topic
  ([transport-window](transport-window.md)
  REQ-the-transport-row-carries-a-help-badge) cover it. The help topic explains
  Loop, the two picks, the dimmed remembered range and when looping is
  unavailable.

- **REQ-loop-costs-nothing-unless-engaged** — **Costs nothing unless engaged.**
  The clock's step router is `null` unless Loop is on **and** a range exists, so
  a transport that is not looping pays one null check per tick. When engaged, a
  tick that is not on a bar line costs one modulo. Only a bar line reads
  `songBars()` and `canSeek()` ([runtime-performance](runtime-performance.md)).

- **REQ-the-loop-is-never-saved** — **Nothing is saved.** Loop on/off, the range
  and the anchor exist only for the current session, like the cue
  ([transport-position](transport-position.md) → Persistence). None of them is a
  `ParamBus` param, so none can end up in a preset, a `SongFile` or the
  autosaved session.

## Technical design

### Contract / public interface

```yaml
LoopRange: { start: number, end: number }   # bar indices, inclusive, start <= end

TransportLoop:   # src/audio/transport/transport-loop.ts — model only, no clock
  get enabled: boolean
  get range: LoopRange | null      # the stored range (REQ-turning-loop-off-keeps-the-range), unclamped (REQ-the-loop-range-is-limited-to-the-song)
  get anchor: number | null        # the first pick, awaiting the second
  get engaged: boolean             # enabled && range !== null
  setEnabled(on): void             # off also drops the anchor (REQ-turning-loop-off-keeps-the-range)
  toggle(): void
  pick(bar): void                  # no-op unless enabled; 1st -> anchor,
                                   # 2nd -> range = sorted(anchor, bar), anchor = null
                                   # bar: non-finite refused, clamped 0..MAX_CHAIN_STEPS-1
  clear(): void                    # off + range null + anchor null (REQ-loading-a-song-clears-the-loop)
  onChange(fn: () => void): () => void   # fires only when something changed

effectiveLoopRange(range, songBars): LoopRange | null   # REQ-the-loop-range-is-limited-to-the-song; songBars 0 -> 1
routeLoopStep(next, range, barTicks): number            # REQ-the-loop-wraps-only-on-a-bar-line, pure; `range`
                                                        # is the effective one

LoopDriver:      # src/audio/transport/loop-driver.ts
  new LoopDriver(deps: {
    clock: Pick<Clock, 'setStepRouter' | 'playing' | 'cue'>,
    loop: TransportLoop,
    songBars(): number,          # arrangement.songBars()
    canSeek(): boolean,          # Engine.canSeek (REQ-a-loop-that-cannot-jump-does-not)
    seekTo(step): boolean,       # Engine.seekTo (REQ-turning-loop-on-moves-the-cue)
  })
  setBarTicks(ticks): void       # pushed from Engine.applyMeter (REQ-loop-bars-are-the-songs-bars)
  # on loop.onChange: install the router iff engaged (REQ-loop-costs-nothing-unless-engaged); if it just
  # became engaged (or its range changed) while stopped, REQ-turning-loop-on-moves-the-cue's cue move

StudioApi:
  readonly loop: TransportLoop   # the UI reads and writes it; the wrap's guard
                                 # lives in the driver, where the jump happens
```

### Wrap rule (REQ-the-loop-wraps-only-on-a-bar-line)

```yaml
routeLoopStep(n, {start, end}, t):
  n % t !== 0                 -> n          # only a bar line decides
  start*t <= n < (end+1)*t    -> n          # inside: keep playing
  otherwise                   -> start*t    # at the end, or outside: go in
driver route(n):
  r = effectiveLoopRange(loop.range, songBars())
  to = routeLoopStep(n, r, barTicks)
  return to !== n && canSeek() ? to : n     # REQ-a-loop-that-cannot-jump-does-not, checked only when jumping
```

### Layer touchpoints & ordering

```yaml
engine: loop = new TransportLoop(); loopDriver = new LoopDriver({...}) after
  the machines and sync (it needs seekTo/canSeek); applyMeter pushes barTicks.
clock (transport.md REQ-a-step-router-can-redirect-the-next-step): after `_step++`, router(_step); a different result
  sets _step, fires onSeek (each listener isolated), cue + nextStepTime untouched
wrap fan-out (same order as a seek, transport-position REQ-seek-has-its-own-listener-channel):
  Arrangement.seekTo -> sequencer (release at gate end) -> motion latch ->
  stutter re-anchor -> SyncController announce (master) -> UI rulers/scrubber
ui (transport-controls.ts):
  Loop click:  canSeek() ? loop.toggle() : no-op
  cell click:  loop.enabled ? (canSeek() && loop.pick(bar)) : seekTo(bar*barTicks)
  repaint: loop.onChange -> classes + titles; also after a structure rebuild
song-panel toTop: loop.clear() THEN seekTo(0)   # clear first, so REQ-turning-loop-on-moves-the-cue cannot
                                                 # re-cue into the old range
```

### Gesture inventory

Per [design-an-interaction](../recipes/design-an-interaction.md). "`—`" is a
decision, not an omission.

| Target | Gesture | Outcome | Precedent |
| --- | --- | --- | --- |
| Loop button | tap / click | toggle Loop; on reuses the remembered range | DAW loop/cycle switch (Ableton, Logic) |
| Loop button | long-press / right-click / double-tap / drag / wheel | — | — |
| scrubber cell, Loop off | tap / click | seek to the top of that bar (unchanged) | DAW timeline click-to-locate |
| scrubber cell, Loop on | tap / click | pick: 1st = anchor, 2nd = range | latched function key + two presses on a key row |
| scrubber cell | drag | — (touch scrolls the timeline) | — |
| scrubber cell | long-press / right-click / double-tap / wheel | — | — |

The two rows for a scrubber-cell click depend on Loop's state, which is law 2's
defect. REQ-with-loop-on-a-click-picks-a-bar records why this one exception is accepted and what keeps the state
visible on the target itself.

### Persistence

Nothing (REQ-the-loop-is-never-saved).

## Visual aids

```
Song-panel transport row, Loop on, looping bars 2–3, playhead in bar 3:

  [TRANSPORT ❐] [Pause] [⏮]  3.05  [Loop]  ▏ 1 ▕▔2▔▕▓3▓▕ 4 ▏
                 -toggle  -tostart -readout -loop   ▲ `loop` on 2 and 3,
                                                      `playing` on 3

Loop off: the range is remembered but dimmed.       ▏ 1 ▕┄2┄▕┄3┄▕ 4 ▏
Loop on, first pick made on bar 4 (the anchor):     ▏ 1 ▕▔2▔▕▔3▔▕[4]▏
  (bars 2–3 keep looping until the second pick lands)

Bar-line wrap, range bars 2–3 in 4/4 (s = 16, e = 48):

  step: … 45 46 47 │ 16 17 …          next = 48 is a bar line, >= e -> 16
  started at 5 (outside):  5 6 … 15 │ 16 17 …   next = 16 is a bar line, inside
  started at 53 (outside): 53 … 63 │ 16 17 …    next = 64 is a bar line, outside -> 16
```

## Scenarios (BDD)

```gherkin
Scenario: Two picks loop the bars between them (REQ-with-loop-on-a-click-picks-a-bar, REQ-the-loop-wraps-only-on-a-bar-line)
  Given a four-bar chain, Loop on, and the transport playing
  When the user clicks scrubber bar 2 and then bar 3
  Then after the last step of bar 3 the next tick is the first step of bar 2
  And that tick sits on the same tempo grid (no retrigger)
# pinned by: tests/audio/transport/loop-driver.test.ts, e2e/transport-loop.spec.ts

Scenario: Picks are order-independent, and one bar is a valid loop (REQ-with-loop-on-a-click-picks-a-bar)
  Given Loop is on
  When bar 3 is picked and then bar 2
  Then the range is bars 2–3
  When bar 1 is picked twice
  Then the range is bar 1 alone
# pinned by: tests/audio/transport/transport-loop.test.ts

Scenario: The old range keeps looping until the second pick lands (REQ-with-loop-on-a-click-picks-a-bar)
  Given Loop is on with range 2–3
  When the user makes a first pick on bar 4
  Then the range is still 2–3 and the transport still wraps there
  And bar 4 carries `loop-anchor`
# pinned by: tests/audio/transport/transport-loop.test.ts, tests/ui/transport-controls.test.ts

Scenario: Loop on turns a scrubber click into a pick, not a seek (REQ-with-loop-on-a-click-picks-a-bar)
  Given Loop is on
  When the user clicks a scrubber cell
  Then seekTo is not called and the loop's anchor is that bar
  And each cell's title says it will set the loop
# pinned by: tests/ui/transport-controls.test.ts

Scenario: Engaged while playing outside the range, it goes in at the bar line (REQ-the-loop-wraps-only-on-a-bar-line, edge)
  Given the transport is playing at step 5 and the range is bars 2–3
  Then steps 6..15 still play
  And the tick after step 15 is step 16, the loop's first step, not a jump mid-bar
  And started at step 53 instead, it plays to 63 and then goes to 16
# pinned by: tests/audio/transport/transport-loop.test.ts, tests/audio/transport/loop-driver.test.ts

Scenario: A wrap does not move the cue (REQ-the-loop-wraps-only-on-a-bar-line)
  Given the cue is 0 and a loop of bars 2–3 is playing
  When the transport wraps several times
  Then clock.cue is still 0
# pinned by: tests/audio/transport/loop-driver.test.ts

Scenario: Engaging while stopped cues the loop (REQ-turning-loop-on-moves-the-cue)
  Given the transport is stopped with the cue at bar 1
  When Loop is turned on with the range bars 3–4
  Then seekTo is called for the top of bar 3
  And with the cue already inside the range, it is left where it is
# pinned by: tests/audio/transport/loop-driver.test.ts

Scenario: Off remembers the range; on reuses it (REQ-turning-loop-off-keeps-the-range)
  Given a range of bars 2–3 and Loop on
  When Loop is turned off
  Then the transport no longer wraps, the anchor is gone, and the range is kept
  And the scrubber shows those cells dimmed
  When Loop is turned on again
  Then the transport wraps at bars 2–3 without new picks
# pinned by: tests/audio/transport/transport-loop.test.ts, tests/ui/transport-controls.test.ts

Scenario: A refused loop is suspended, never applied (REQ-a-loop-that-cannot-jump-does-not)
  Given a loop is engaged
  When an export is in flight, or the instance is slaved
  Then the step router keeps the next step (no wrap)
  And the Loop button and the scrubber picks do nothing
# pinned by: tests/audio/transport/loop-driver.test.ts, tests/ui/transport-controls.test.ts

Scenario: A shorter song limits the loop without editing the range (REQ-the-loop-range-is-limited-to-the-song, edge)
  Given a range of bars 3–5 in a six-bar song
  When the chain is shortened to four bars
  Then the effective range is bars 3–4 and the stored range is still 3–5
  And with no chain enabled the song is one bar, so the effective range is bar 1
# pinned by: tests/audio/transport/transport-loop.test.ts

Scenario: A sync master announces each wrap (REQ-a-sync-master-announces-every-wrap)
  Given sync mode is master and the clock fires onSeek
  Then songposition + continue are broadcast
  And Engine.seekTo no longer announces on its own, so a user seek announces once
# pinned by: tests/audio/transport/sync/sync-controller.test.ts, tests/audio/engine-seek.test.ts

Scenario: A tie into the wrap releases at its gate end (REQ-a-tied-note-does-not-hang-across-a-wrap, regression)
  Given the last step of the loop is tied and its note-on is still in the look-ahead
  When the wrap fires onSeek
  Then the held note is released at that step's gate end, not at now
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: Loading a song clears the loop (REQ-loading-a-song-clears-the-loop)
  Given Loop is on with a range
  When a song is loaded, or New is confirmed
  Then Loop is off and no range is remembered
# pinned by: e2e/transport-loop.spec.ts

Scenario: The wrap measures the song's bar (REQ-loop-bars-are-the-songs-bars)
  Given a 3/4 meter (barTicks 12) and the range bars 2–3
  Then the loop runs over steps 12..35 and step 36 goes back to 12
# pinned by: tests/audio/transport/transport-loop.test.ts

Scenario: No router unless engaged (REQ-loop-costs-nothing-unless-engaged)
  Given Loop is on but no range has been picked
  Then the clock's step router is null
  When the second pick lands it is installed, and turning Loop off removes it
# pinned by: tests/audio/transport/loop-driver.test.ts
```

## Tests & verification

- Unit: `tests/audio/transport/transport-loop.test.ts` (model + pure rule),
  `tests/audio/transport/loop-driver.test.ts` (real `Clock` on the injected
  `TimeoutTimer`), `tests/audio/transport/clock.test.ts` (the router),
  `tests/audio/transport/sequencer.test.ts`,
  `tests/audio/transport/sync/sync-controller.test.ts`,
  `tests/audio/engine-seek.test.ts`, `tests/ui/transport-controls.test.ts` — `npm test`
- E2E: `e2e/transport-loop.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- By ear ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)): a loop across a
  bar with a tied seq note and a drum fill. The wrap must be inaudible as a
  seam, with no hanging voice. Check Chromium and Firefox.
- Dev-bridge assertions: `window.__synth.engine.loop.range`,
  `window.__synth.engine.clock.step` (DEV only)

## Open questions / future

- **The machine-tab rulers do not show the loop.** A loop brace on the ruler,
  or a 16th-resolution loop set there, would reuse its geometry
  ([transport-position](transport-position.md) → Open questions), but it is a
  separate, step-level feature.
- ~~**A slave follows a wrap by re-joining.**~~ Resolved by midi-clock-sync v8:
  a slave that is already following jumps in place on `continue`
  (REQ-a-following-slave-jumps-in-place), timed to the wrap's first pulse
  (REQ-a-join-is-timed-by-its-first-pulse). The restart it used to do had also
  been leaving the slave a 16th off after a few wraps.
- **Keyboard shortcuts** for Loop and Pause are not assigned. Most letter keys
  already play the on-screen keyboard ([keyboard-layout](keyboard-layout.md)).
