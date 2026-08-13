# Transport position (moving the playhead)

```yaml
id: transport-position
status: implemented
version: 3  # v3: only an EXPORT blocks a seek — a free manual take no longer
            #     locks the playhead (REQ-6)
            # v2: the ruler stops conflating cue with playhead and stops counting
            #     bars that don't exist — cue ring (REQ-14), mode-aware readout
            #     (REQ-15), bar stepper (REQ-16), refusal honesty (REQ-17)
owner: core
related:
  - architecture
  - typography          # REQ-15's readout is mono, not the faceplate serif
  - transport
  - arrangement
  - sequencer
  - motion-sequencer
  - performance
  - midi-clock-sync
  - onboarding
  - transport-window
  - audio-export
  - render-to-sampler
  - step-grid-editing
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
  - src/ui/shortcuts.ts
```

Moving the playhead: a **seek** on the running (or stopped) transport, and the two
UI surfaces that expose it — a clickable position ruler above every machine grid,
and keyboard shortcuts.

## Background / Why

The transport could only be **started** and **stopped**. `Clock.start(fromStep)`
seeds the step counter ([transport](transport.md) REQ-5) and `stop()` leaves it
where it landed, so the only way to reach bar 3 of an `A A B A` chain was to play
from the top and wait. `start()` early-returns while playing, so it cannot move a
running clock at all; the single existing caller of `start(fromStep)` is MIDI
Song-Position Pointer ([midi-clock-sync](midi-clock-sync.md) REQ-10), which works
by stop-and-restart. There was no cue point, no locate, no scrub.

Nor was there anywhere on screen showing **where the transport is**. The grid
playhead is not a position display: it is hidden whenever the edit bank differs
from the play bank or the lane is resting ([banks](banks.md) REQ-5,
[arrangement-rest](arrangement-rest.md) REQ-4), and it is driven by each machine's
`onStep`, which is silent while that machine is disabled and while the transport is
stopped. Those are the states in which a user most wants to know the position. This
spec separates the two facts: the **ruler** shows the transport position
unconditionally, and the cell highlight keeps its narrower existing meaning ("this
bank's step is sounding").

The hard part is not the seek itself — it is that positions in this codebase are
counted **relatively**. The [arrangement](arrangement.md) advances its lane
positions by `+1` per bar line, the [motion machine](motion-sequencer.md)
interpolates between two latched ticks, the [sequencer](sequencer.md) carries tie
state between steps, and [stutter](performance.md) remaps steps against a captured
anchor. None of them derive their position from `clock.step`, so moving that
counter silently desynchronises all four.

## Requirements

- **REQ-1** — **`Clock.seek(step)` moves *which* step, never *when* the grid
  ticks.** It sets the step counter and does **not** touch `nextStepTime`, so the
  tempo grid is preserved: a live jump stays in time, with no retrigger and no
  phase discontinuity. (Contrast `start()`, which re-origins `nextStepTime` to
  `ctx.currentTime + 0.05`; reusing it for a live seek would restart the grid under
  the player's feet.) `seek` works both while playing and while stopped.

- **REQ-2** — **One position number, not two.** `seek(step)` sets the step counter
  *and* a **cue** (`_cue`), and `start(fromStep = cue)` begins there. A start point
  held separately from the current position would be invisible state, which
  [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 5 forbids. Two
  consequences are load-bearing:
    - with no seek ever performed the cue is `0`, so a plain `start()` is
      **bit-identical** to v3 ([transport](transport.md) REQ-5's regression);
    - `stop()` leaves both alone, so Stop → Play resumes from the last seeked
      position rather than the position playback happened to reach.

- **REQ-3** — **Seek has its own listener channel, fired before the next tick.**
  `Clock.onSeek(fn)` is emitted **synchronously** inside `seek()`, modelled on
  `startListeners`. The [arrangement](arrangement.md) is constructed before the
  machines ([arrangement](arrangement.md) REQ-5), so it subscribes first and its
  play banks are settled before anything else reacts — the same ordering guarantee
  `onTick` and `onStart` already carry.

- **REQ-4** — **Every relative-position consumer reacts.** A seek is not complete
  until all four have re-based; see the table in *Technical design*. Specifically:
  the arrangement re-seeks its four lanes from `floor(step / SEQ_LENGTH)` and
  re-arms `expectFirstBar`; the sequencer releases held notes and clears `prevTied`
  per track; the motion machine drops its `prev`/`curr` latch pair **without**
  restoring baselines; and `Performance` re-anchors stutter. The drum and sampler
  machines hold no position state and need nothing.

- **REQ-5** — **Motion baselines survive a seek.** `MotionMachine.baselines` is the
  whole-session record of each automated param's pre-automation value. A seek must
  clear the tick latch **only**; calling `restoreBaselines()` would snap every
  automated param and then re-capture baselines *from automated values*, so the
  original values would be lost for the rest of the session. This is the one
  place where copying `onStart`'s reset wholesale is wrong.

- **REQ-6** — **Seeking is refused in three states**, through one guard so every
  surface can disable itself consistently:
    - **sync slave** (`sync.activeMode === 'slave'`) — the remote transport owns
      the playhead, and a local jump would fight the slave's phase tracking into a
      re-anchor. Precedent: `Performance.clockRampAllowed`.
    - **a song *export* is in flight** and **a bank render is in flight** — both
      bound their capture by an **absolute step number**
      ([audio-export](audio-export.md) REQ-2,
      [render-to-sampler](render-to-sampler.md)), so a jump truncates or unbounds
      the capture.
  A refused seek is a **silent no-op returning `false`**, never an error.
  (v3) A **free-form manual take does not take this guard.** Until
  [audio-export](audio-export.md) v7 the predicate was `recorder.isRecording()`,
  which could not tell an export from a manual take and so locked the playhead for
  both. Only the export has step bounds to protect; a manual capture is bounded by
  nothing, and jumping around the arrangement mid-take is what free-form recording
  is *for*. The guard therefore reads `recorder.isExporting()`, not
  `isCapturing()` — the sampler-choke suppression on `clock.onStop` still reads
  the wider `isCapturing()`, because that one really does mean "samples are being
  taken, do not cut them".

- **REQ-7** — **A sync master announces its seek.** While `master`, a seek
  broadcasts `songposition` + `continue` (reusing `SyncMaster.announceTo`), or
  every slave drifts by the jump distance for the rest of the session. It must
  **not** send `start`, which realigns slaves to bar 0
  ([midi-clock-sync](midi-clock-sync.md) REQ-10).

- **REQ-8** — **One entry point.** `Engine.seekTo(step): boolean` owns the guard
  (REQ-6) and the broadcast (REQ-7); `Engine.canSeek(): boolean` reports whether a
  seek would be accepted. Both are on `StudioApi`, so no UI surface reaches past
  them to `clock.seek` directly.

- **REQ-9** — **A position ruler above every machine grid.** 16 columns aligned to
  the step columns, showing the transport position **unconditionally** — while
  stopped, on a disabled machine, and whatever the edit/play bank relationship —
  plus a readout naming where you are (REQ-15). Clicking column `i` seeks to that
  16th of the current bar. It is built once (`playhead-ruler.ts`, wired from
  `step-panel-scaffold.ts`) and inherited by all four machines, and it is driven by
  the **clock**, not by the machines' `onStep` (which is silent exactly when the
  ruler is most needed).

- **REQ-10** — **The ruler costs nothing off screen.** It obeys the panel's
  `VisibilityGate` like `wirePlayhead` does
  ([runtime-performance](runtime-performance.md) REQ-4,
  [step-grid-editing](step-grid-editing.md) REQ-12): no DOM writes while hidden,
  and a re-sync to the live position on reveal — never a stale column. The ticks
  also carry **no CSS transition**: the lit class moves every 16th, so a
  cross-fade would repaint two ticks ~9 times a second per visible ruler and make
  the playhead read as lagging. Same rule as the song scrubber
  ([transport-window](transport-window.md) REQ-11).

- **REQ-11** — **Keyboard: `Home` and `Shift`+arrows.** `Home` returns to bar 1
  step 1; `Shift+ArrowLeft`/`Shift+ArrowRight` move ∓/± one bar. The shifted
  arrows must be handled **before** the existing bare-arrow octave shift, which
  currently also fires when Shift is held. A refused seek (REQ-6) does not
  `preventDefault`, so the key falls through — the `boolean`-returning idiom
  `UiBridge.undoActiveMachine` / `clearSelectedStep` already use.

- **REQ-12** — **The look-ahead horizon is not cancelled.** Ticks are scheduled up
  to `scheduleAheadS` ahead (0.1 s; 0.2 s on the weak perf tier) and the machines
  commit hits to absolute AudioContext times with no retained handles, so roughly
  100 ms of old-position audio always sounds after a jump — about a fifth of a
  16th at 120 BPM. This is **accepted and documented**, not worked around:
  retaining and cancelling every scheduled voice would cost more than the artefact.

- **REQ-13** — **Discoverability.** Every tick carries a `title` naming the
  gesture, each machine tab's ruler carries a help badge
  (`transport.ruler.<lane>` — [onboarding](onboarding.md) REQ-16, four ids over
  one shared topic because a hidden tab's badge hides), and the keys are listed
  in the About modal's shortcut table ([onboarding](onboarding.md) REQ-17) and
  the README. That is the [recipe](../recipes/design-an-interaction.md)'s
  discoverability triple: a gesture with none of them does not exist for the
  user, and clicking a ruler is not self-evident the way tapping a step is.

- **REQ-14** (v2) — **The cue and the live playhead are two marks, not one.** v1
  painted both with the global `playing` class, picked by
  `playing ? clock.step : clock.cue`, so a stopped ruler sitting on its cue was
  pixel-identical to a running one on the live step. Clicking a tick while stopped
  therefore gave no "Play starts here" feedback — the single most-reported
  confusion about this feature. So:
  - **`AT_CLASS = 'playing'`** marks `clock.step` and is applied **only while
    playing**. A stopped ruler carries it nowhere: nothing may look like it is
    playing when it is not.
  - **`CUE_CLASS = 'cue'`** marks `clock.cue` whenever it differs from the live
    mark, playing or stopped — so you can also see where Stop → Play will resume,
    and the recorders' explicit `start(0)` (REQ-2) becomes legible rather than a
    mystery jump back on stop.
  - Both are **global** (un-hashed) classes, the existing `AT_CLASS` rationale:
    every other class here is CSS-Module hashed, so E2E has nothing else to
    select. `cue` is already a global state class in this app (the Play button's
    demo cue — [play-button-blink](play-button-blink.md)), so the vocabulary is
    reused, not invented.
  - One tick may carry **both** (stopped, then played from that exact step); the
    style must stay legible in that case.

- **REQ-15** (v2) — **The readout names where you are, and never invents bars.**
  v1 printed `Bar floor(step/16)+1`, absolute and unwrapped. With **no chain lane
  enabled** — the default, and how pattern editing is done — a disabled lane plays
  the **edit bank** ([arrangement](arrangement.md) `resolveLane`), so the song is
  one bank looping: that counter climbed 1, 2, 3 … 37 for a song with one bar, and
  disagreed with the Song scrubber, which wraps at `songBars()`. Two modes:
  - `arrangement.songBars() === 0` (no lane chained) → **`BANK A`**, naming *this
    machine's* bank via the same `laneHooks` accessor the `BankBar` uses, so the two
    can never disagree. Bars are musically meaningless here, so none is shown. The
    ruler's job in this mode is the **cue** — exactly what the grid cannot show.
    Read the **edit** bank, not `Arrangement.<lane>PlayBank`: the latter is the
    semantic-looking choice and the wrong one, because it is a cached field
    recomputed only on tick / seek / chain change and therefore reads **stale**
    after a bank click while stopped. A disabled lane plays its edit bank
    (`resolveLane`), so edit *is* what sounds in this mode.
  - Otherwise → **`BAR n/N`** with `n = bar % songBars() + 1`, agreeing with the
    Song scrubber ([transport-window](transport-window.md)) instead of
    contradicting it.
  - The readout is set in **`--mono`**, not the faceplate serif
    ([typography](typography.md) REQ-3): `n` counts while the transport runs, and
    Georgia's proportional old-style figures made the trailing `/N` shuffle
    sideways on every bar. Same finding as
    [transport-window](transport-window.md) REQ-6's `bar.step`.

- **REQ-16** (v2) — **A bar stepper, only where bars exist.** In `BAR` mode the
  readout becomes `‹ BAR n/N ›`; the arrows seek ∓/± one bar **preserving the
  16th** (`(bar ± 1) * SEQ_LENGTH + pos % SEQ_LENGTH`), clamped to
  `[0, songBars())`. That is the one move `Shift`+arrows cannot make — they zero
  the column (REQ-11) — and it is why the ruler previously could not change bar at
  all: its bar term is implicit in the click arithmetic, so bar navigation lived
  only on the Song tab and the keyboard.
  In `BANK` mode the arrows are **hidden**. They must **not** double as a bank
  switcher there: one button whose outcome depends on invisible state is
  [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2 inverted, and
  switching the *edit* bank is a pattern-editing act, not a transport one — the
  `BankBar` beside it already owns that, with its own play-bank dot and Follow.

- **REQ-17** (v2) — **A refused seek says so.** REQ-6's refusal only dimmed the
  strip (`opacity: .4`) while every tick's `title` still promised "Move the
  playhead to step N". While `!canSeek()` the ticks and the stepper carry
  `aria-disabled` and a title naming the reason. The ticks stay un-`disabled`
  (the silent-no-op path is unchanged), so nothing about the seek contract moves.
  Related honesty fix: ticks print beats `1 2 3 4` while the old title said
  "step N", two numbering systems on one control — the title now names the beat.

## Technical design

### Contract / public interface

```yaml
Clock:   # src/audio/transport/clock.ts — additions to transport.md's contract
  seek(step): void          # _cue = _step = step & 0xffff; nextStepTime UNTOUCHED;
                            # fires onSeek synchronously. Valid playing or stopped.
  get cue: number           # where a plain start() begins (0 until the first seek)
  start(fromStep = this.cue)  # was `= 0`; identical while cue is 0
  onSeek(fn: () => void) -> unsubscribe

TickSubscriber:  # src/audio/transport/tick-source.ts
  onSeek(fn: () => void): () => void     # added alongside onStart/onStop

Arrangement:  # src/audio/transport/arrangement.ts
  # `seekTo(step)` is the body previously inlined in the onStart closure; onStart
  # now calls seekTo(clock.step), and clock.onSeek calls it too.

Engine / StudioApi:
  seekTo(step: number): boolean   # false = refused (REQ-6); guards + master announce
  canSeek(): boolean              # same predicate, for disabling UI

buildPlayheadRuler(engine, lane, gate?, hooks?): PlayheadRuler  # src/ui/components/playhead-ruler.ts
  hooks: { getBank(): number; onBankChange(fn): () => void }   # v2, REQ-15
    # Supplied by playheadRulerFor from `laneHooks` (getEdit/onEditChange) — the
    # SAME accessor BankBar uses, so the letter can never disagree with the bank
    # bar beside it. The EDIT bank, not <lane>PlayBank, which is cached and stale
    # while stopped (REQ-15). The component must not import the scaffold (the
    # scaffold imports it).
PlayheadRuler:
  cellsEl: HTMLElement     # ONLY the 16-column strip (see alignment below)
  barEl: HTMLElement       # the readout group, for the panel's label slot:
                           #   BANK mode -> a label; BAR mode -> ‹ label ›
  destroy(): void
playheadRulerFor(engine, lane, gate?): PlayheadRuler      # src/ui/panels/step-panel-scaffold.ts
  # testids: ruler-<lane>-<0..15>, ruler-<lane>-bar (the label — text asserted),
  #          ruler-<lane>-bar-prev, ruler-<lane>-bar-next (v2, REQ-16)
  # state classes: `playing` (live step, playing only) + `cue` (v2, REQ-14),
  #          both GLOBAL so E2E can select them past CSS-Module hashing
```

### The four reactions (REQ-4)

| Consumer | Position state that breaks | Reaction on `onSeek` |
| --- | --- | --- |
| `Arrangement` | `seqPos`/`drumPos`/`samplerPos`/`motionPos` advance `+1` per bar line and are never derived from `clock.step`, so a jump leaves the chain off by (bars jumped − 1) — plus a spurious double-advance when the jump lands exactly on a bar line. | `seekTo(step)`: `laneSeek` per lane, `expectFirstBar = step % SEQ_LENGTH === 0`, `recompute()`, `notify()`. |
| `StepSequencer` | Per-track `prevTied` / `lastPlayedNote`: a note tied at the old position slurs into the new one, or a held note is never released. | Release every track's held note and clear `prevTied`. Subscribed inside the constructor so `releaseAll` stays private. |
| `MotionMachine` | `prev`/`curr` become non-adjacent, so the frame loop interpolates from a stale anchor for up to `scheduleAheadS` — an audible param glide to the wrong value. | `curr = prev = null` only. **Not** `restoreBaselines()` (REQ-5). |
| `Performance` | `mapStep` returns `anchor + ((step - anchor) mod n)`, so with stutter engaged a jump is clamped into the *old* window and a backwards jump replays it forever. | Re-anchor to the new step while stutter is on. |
| `DrumMachine`, `SamplerMachine` | none — stateless per tick. | none. |

### Layer touchpoints & ordering

```yaml
seek fan-out order (guaranteed by construction order, arrangement.md REQ-5):
  Clock.seek -> Arrangement.seekTo (play banks settle) -> machines -> UI ruler
engine: seekTo() guards on sync.activeMode / recorder capture / bank render,
        then clock.seek(step), then (master only) sync announce
recorders: recorder-controller.ts and bank-render.ts must call start(0)
        EXPLICITLY — both rely on "start() resets the step to 0", which REQ-2's
        cue default breaks. Silently truncated exports otherwise.
ui ruler: driven by clock.onTick + clock.onSeek (NOT machine onStep); gated by the
        panel's VisibilityGate, re-synced on whenShown
shortcuts.ts: the Shift+Arrow branch goes ABOVE the bare-arrow octave shift
```

### Ruler alignment

The strip must line up with the step columns, and every grid puts a control column
to its left (the drum/sampler rows are `.rowCtrls` + a 16-column `.cells`; the seq
and motion panels have their own row shapes). So `buildPlayheadRuler` returns
**only** the 16-column strip plus a detached bar readout, and each panel wraps them
in a row built exactly like its own track rows — the panel's existing CSS grid then
does the alignment, and no shared component has to know four layouts.

The ruler is deliberately **not** in the machine header:
[responsive-machine-header](responsive-machine-header.md) records only ~57 px of
slack in the sampler header at 1280 px and none on Linux CI.

### Gesture inventory (ruler)

Per [design-an-interaction](../recipes/design-an-interaction.md) step 1. "`—`" is a
decision, not an omission.

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| tap / click | seek to that 16th of the current bar | Ableton / Logic / Pro Tools timeline click-to-locate |
| drag | — (would fire one seek per column crossed) | — |
| long-press | — | — |
| right-click | — | — |
| double-tap | — (tap already seeks) | — |
| wheel | — | — |
| `Home` | seek to bar 1 step 1 | DAW return-to-start |
| `Shift`+`←`/`→` | ∓/± one bar, column zeroed | DAW bar navigation |
| click `‹` / `›` (v2) | ∓/± one bar, **column preserved** | DAW bar-locate buttons |

No row's outcome depends on hidden state, so the inventory satisfies
[ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2. The stepper is
*absent* in `BANK` mode rather than repurposed (REQ-16) — hiding a control keeps
law 2; giving it a second meaning would break it.

### Persistence

Nothing. The cue and the transport position are transient, exactly like the
selection cursor and the paint latch ([step-grid-editing](step-grid-editing.md)) —
a song does not carry "where you last were", and `_cue` is not a `ParamBus` param,
so it can never leak into a preset or a `SongFile`.

## Visual aids

The strip prints beat numbers (`1 2 3 4`) on columns 0/4/8/12 and nothing on the
rest — sixteen numerals do not fit at tick width.

```
No chain lane enabled (the default) — bars do not exist, so none is claimed:

  BANK A  ▏ 1 ▕   ▕   ▕   ▕ 2 ▕   ▕   ▕   ▕ 3 ▕   ▕   ▕   ▕ 4 ▕   ▕   ▕   ▏
  ruler-drum-bar    ▲ █ = playing (clock.step)   ▲ ◌ = cue (Play starts here)
  ┌──────────┬────────────────────────────────────────────────────────────┐
  │ KICK mute│ ■ · · · ■ · · · ■ · · · ■ · · ·                            │  the grid

A chain is enabled — the stepper appears and the bar wraps at song length:

  ‹ BAR 3/4 ›  ▏ 1 ▕   ▕   ▕   ▕ 2 ▕ █ ▕   ▕   ▕ 3 ▕   ▕   ▕   ▕ 4 ▕   ▕   ▕   ▏
  ▲ -bar-prev / -bar-next: same 16th, previous/next bar
```

The ruler shows position while stopped and on a disabled machine; the cell
highlight below it does not — that one still means "this bank's step is sounding".
While stopped the ruler carries **no** `playing` mark at all (REQ-14): only the cue
ring, because nothing is playing.

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

Scenario: A plain start() is unchanged when nothing was seeked (regression, REQ-2)
  Given the clock has never been seeked
  When start() is called
  Then it begins at step 0, bit-identical to v3
# pinned by: tests/audio/transport/clock.test.ts

Scenario: Seeking re-seeks the arrangement lanes (REQ-4)
  Given seqChain = { enabled: true, steps: [0,0,1,0] } and the transport is playing
  When the playhead is seeked to bar 2
  Then seqPlayBank is B immediately, and A on the next bar
# pinned by: tests/audio/transport/arrangement.test.ts, e2e/transport-position.spec.ts

Scenario: A seek landing on a bar line does not double-advance (edge, REQ-4)
  Given an enabled chain and a seek to an exactly bar-aligned step
  Then that bar plays the slot the seek implies, and the NEXT bar line advances
       it by exactly one
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: Motion keeps its baselines across a seek (REQ-5)
  Given the motion machine has automated filter cutoff and recorded its baseline
  When the playhead is seeked mid-play
  Then the tick latch is cleared and cutoff jumps to the curve's value at the new
       position — but the recorded baseline is unchanged
  And stopping afterwards still restores the ORIGINAL pre-automation value
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: A tied sequencer note does not slur across a seek (edge, REQ-4)
  Given a sequencer step tied into the next one is currently sounding
  When the playhead is seeked elsewhere
  Then the held note is released and the new position starts clean
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: Seeking under active stutter re-anchors (edge, REQ-4)
  Given stutter is engaged so mapStep is clamping to a window
  When the playhead is seeked backwards past the anchor
  Then the stutter window re-anchors to the new position instead of replaying
       the old one
# pinned by: tests/audio/transport/performance.test.ts

Scenario: A slaved instance refuses to seek (REQ-6)
  Given sync mode is slave and a master is driving the clock
  When the user clicks the ruler
  Then nothing moves, seekTo returns false, and canSeek() is false
# pinned by: tests/audio/engine-seek.test.ts

Scenario: Seeking is refused while the song recorder is capturing (REQ-6)
  Given an Export Song capture is in flight
  Then seekTo returns false, so the capture cannot be truncated
# pinned by: tests/audio/engine-seek.test.ts

Scenario: A master announces its seek so slaves follow (REQ-7)
  Given sync mode is master and the transport is playing
  When the playhead is seeked
  Then songposition + continue are broadcast — and start is NOT
# pinned by: tests/audio/transport/sync/sync-master.test.ts

Scenario: The ruler shows the position when the grid highlight cannot
  Given the drum machine is switched off, or the edit bank differs from the play bank
  Then the ruler still tracks the transport, while the cell highlight stays dark
# pinned by: tests/ui/playhead-ruler.test.ts

Scenario: A hidden ruler does no per-tick work, and re-syncs on reveal (REQ-10)
  Given the transport is playing and a machine panel's tab is not the visible one
  Then its ruler is not touched at all
  When the tab is revealed
  Then the ruler jumps to the step playing NOW, not the one it was left on
# pinned by: tests/ui/playhead-ruler.test.ts

Scenario: Shift+Arrow moves a bar without shifting the keyboard octave (edge, REQ-11)
  Given the transport is playing
  When the user presses Shift+ArrowRight
  Then the playhead advances exactly one bar
  And the on-screen keyboard's octave is unchanged
# pinned by: e2e/transport-position.spec.ts

Scenario: A stopped ruler shows a cue, never a playhead (v2, REQ-14)
  Given the transport is stopped
  When the user clicks ruler column 6
  Then that tick carries the `cue` class
  And NO tick on the strip carries the `playing` class
  When the user presses Play
  Then a `playing` mark advances from column 6 while the cue ring stays there
# pinned by: tests/ui/playhead-ruler.test.ts, e2e/transport-position.spec.ts

Scenario: The readout names the bank when no chain is enabled (v2, REQ-15)
  Given no lane's chain is enabled and the drum edit bank is B
  Then the drum ruler's readout reads "BANK B" and shows no bar stepper
  When the edit bank changes to C
  Then the readout follows, agreeing with the BankBar beside it
# pinned by: tests/ui/playhead-ruler.test.ts, e2e/transport-position.spec.ts

Scenario: The readout wraps at song length once a chain exists (v2, REQ-15)
  Given seqChain = { enabled: true, steps: [0,0,1,0] }
  When the playhead is at absolute bar 6
  Then the readout reads "BAR 3/4" — the same bar the Song scrubber lights
# pinned by: tests/ui/playhead-ruler.test.ts

Scenario: The bar stepper keeps the 16th (v2, REQ-16)
  Given a chain is enabled and the playhead is at bar 2, step 5 of that bar
  When the user clicks the ruler's next-bar arrow
  Then it seeks to bar 3 step 5 — unlike Shift+Arrow, which would zero the step
  And clicking prev-bar at bar 1 is clamped, never negative
# pinned by: tests/ui/playhead-ruler.test.ts

Scenario: A refused seek stops promising it will work (v2, REQ-17)
  Given sync mode is slave, so canSeek() is false
  Then the ticks and the stepper are aria-disabled and their titles name the reason
# pinned by: tests/ui/playhead-ruler.test.ts
```

## Tests & verification

- Unit: `tests/audio/transport/clock.test.ts` (seek/cue + the `start()`
  regression), `arrangement.test.ts` (lane re-seek, bar-line edge),
  `sequencer.test.ts`, `motion-machine.test.ts`, `performance.test.ts` (the four
  reactions), `tests/audio/engine-seek.test.ts` (the guard),
  `tests/ui/playhead-ruler.test.ts` — `npm test`
- E2E: `e2e/transport-position.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.engine.clock.step`,
  `window.__synth.engine.arrangement.seqPlayBank` (DEV only)

## Open questions / future

- **Scrub-drag** across the ruler (one continuous locate rather than one click) is
  deliberately deferred: it would fire a seek per column crossed, and each seek
  costs a full arrangement re-seek plus a sequencer voice release. It needs a
  coalescing pass (seek on pointerup, preview during the drag) before it is worth
  the gesture row.
- **Loop brackets** (locate points that also set a loop range) are the natural
  neighbour and would reuse the ruler's geometry entirely.
- Cancelling the in-flight look-ahead (REQ-12) would need every machine to retain
  handles to its scheduled voices — a much larger change to the audio layer, and
  only worth it if the ~100 ms artefact ever proves audible in practice.
