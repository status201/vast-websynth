# TRANSPORT window (Song-panel transport section)

```yaml
id: transport-window
status: implemented
version: 1
owner: core
related:
  - transport
  - transport-position
  - floating-window
  - live-fx-window
  - song-mode
  - arrangement
  - midi-clock-sync
  - onboarding
source:
  - src/ui/components/transport-controls.ts   # shared builder + window launcher
  - src/ui/panels/song-panel.ts               # hosts the compact row
  - src/ui/components/floating-window.ts      # the host window
  - src/audio/transport/arrangement.ts        # songBars — how long the scrubber is
```

## Background / Why

[transport-position](transport-position.md) gives every machine tab a ruler for
the 16th **within a bar**. What it cannot show is the song: with an `A A B A`
chain you still cannot see which bar of four you are on, or jump to bar 3
directly. The Song tab is where the chain lanes live, so that is where a
song-scale transport belongs.

It follows [live-fx-window](live-fx-window.md) exactly, for the same reason that
feature exists: transport controls are useless if they are only reachable on one
tab. A launcher opens a non-modal [FloatingWindow](floating-window.md) that, like
every floating window, mounts on `document.body` and therefore keeps working
while you edit a patch on the Synth tab.

It differs from LIVE FX in one deliberate way. LIVE FX renders the **same full
control set** in both places; this one keeps the Song-panel row **compact** — a
launcher, a return-to-start button, a position readout and the bar scrubber —
with Play/Stop, BPM and SWING living only in the window. The Song panel is
already the tallest tab in the app, and the point of undocking is to give that
space back, not to duplicate it.

## Requirements

- **REQ-1** — **Shared builder.** `buildTransportControls(engine, bus, bridge,
  opts?)` renders the transport control set from one source; `opts.testIdPrefix`
  namespaces every testid so two instances coexist (the Song row uses
  `transport`, the window `transportw`), the same mechanism
  [live-fx-window](live-fx-window.md) REQ-1 uses. `opts.compact` omits the
  controls the Song-panel row does not carry (Play/Stop, BPM, SWING).
- **REQ-2** — **TRANSPORT floating window.** A launcher (`transport-open`)
  toggles a `FloatingWindow` titled **TRANSPORT** (`testId: transport-window`),
  built lazily on first open and kept alive across closes. Contents in order:
  Play/Stop, ⏮ return-to-start, the `bar.step` readout, the bar scrubber, then
  BPM and SWING knobs.
- **REQ-3** — **The launcher doubles as the section title**, leading the Song
  panel's transport row and carrying the same ❐ "opens a new window" glyph as
  the LIVE FX launcher (aria-hidden; the button's `aria-label` carries the
  meaning). No separate text label — that is the space this feature gives back.
- **REQ-4** — **Compact Song-panel row**:
  `[TRANSPORT ❐] [⏮] [bar.step] [bar scrubber]`, placed **directly under the four
  machine lanes and above Live FX**. The scrubber is one cell per chain slot, so
  it reads as a ruler for the chains immediately above it — a bar number in the
  scrubber and a chip in a lane mean the same bar. Sitting it down by Sync (its
  first home) put the position readout at the bottom of the tallest panel in the
  app, several sections away from the only thing that gives it meaning.
- **REQ-5** — **Play/Stop is not a second source of truth.** It routes through
  `UiBridge.toggleTransport`, which clicks the *real* header button — so it
  inherits the [empty-play hint](empty-play-hint.md) intercept and the
  [Play-button blink](play-button-blink.md) state machine for free, and the two
  buttons can never disagree. It mirrors its own label/`.on` off
  `clock.onStart`/`onStop`, exactly as the header button does.
- **REQ-6** — **Position readout.** `bar.step`, 1-based (bar 1 step 1 at the
  top). Playing, it shows the live step; stopped, the **cue** — where Play will
  begin — matching the machine-tab rulers
  ([transport-position](transport-position.md) REQ-9), so the two surfaces can
  never disagree about "where are we?".
- **REQ-7** — **Bar scrubber.** One cell per bar of the song, current bar lit,
  click to seek to the top of that bar. Song length is
  `Arrangement.songBars()` — the longest **enabled** chain lane across all four
  lanes — falling back to a single bar when no lane is enabled. The DOM is
  rebuilt only when that length changes; the lit class moves in place otherwise,
  the same split-rendering rule the chain chips already follow.
- **REQ-8** — **Seeking respects the one guard.** Both the ⏮ and the scrubber go
  through `StudioApi.seekTo`, and both surfaces mark themselves inert when
  `canSeek()` is false ([transport-position](transport-position.md) REQ-6/REQ-8).
- **REQ-10** — **The row carries a help badge** on its launcher — which is also
  its section title, so the badge sits on the row's leading control. Topic
  `transport.song` ([onboarding](onboarding.md) REQ-16): the `bar.step` readout,
  the scrubber's one-cell-per-chain-slot correspondence, what the floating
  window adds, and the states where seeking is refused (REQ-8).
- **REQ-9** — **The chain chips are left alone.** A chip click already toggles
  the edit selection that ◀ ▶ ✕ act on ([song-mode](song-mode.md)); adding a
  seek to it would give one gesture two outcomes, which
  [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2 forbids. The
  scrubber is a separate target sitting above them.

## Technical design

### Contract / public interface

```yaml
buildTransportControls(engine, bus, bridge, opts?): HTMLElement[]
  # opts: { testIdPrefix?: string (default 'transport'), compact?: boolean }
  # full:    [Play/Stop, ⏮, readout, scrubber, BPM, SWING]
  # compact: [⏮, readout, scrubber]
  # testids: `${p}-toggle`, `${p}-tostart`, `${p}-readout`, `${p}-scrub`,
  #          `${p}-scrub-<bar>`
  # NOT `${p}-play`: the header's own Play button is `transport-play`, and a
  # default-prefixed instance would mint a duplicate of it.

createTransportWindowLauncher(engine, bus, bridge): HTMLButtonElement
  # the `transport-open` toggle; owns the TRANSPORT FloatingWindow lazily

Arrangement:                                  # src/audio/transport/arrangement.ts
  songBars(lanes?): number    # longest ENABLED lane length; 0 when none enabled.
                              # `lanes` narrows which lanes count — the scrubber
                              # asks about all four, audio export about the three
                              # audible ones (audio-export.md REQ-2 unchanged).
```

### Layer touchpoints & ordering

```yaml
song-panel: transport row = createTransportWindowLauncher(engine, bus, bridge)
  -> buildTransportControls(engine, bus, bridge, { compact: true })
  section order: chain lanes -> TRANSPORT -> Live FX -> Song I/O -> Audio -> Sync
  (REQ-4: it belongs against the chains it scrubs, not against Sync)
window body: buildTransportControls(engine, bus, bridge, { testIdPrefix:'transportw' })
play: UiBridge.toggleTransport -> the header button's click (REQ-5) — never
  clock.toggle() directly, or the empty-play hint and the LED blink are bypassed
seek: StudioApi.seekTo only (REQ-8)
repaint: clock.onTick / onSeek / onStart / onStop for the readout + scrubber lit
  class; arrangement.onChange for the scrubber's structure
```

`buildTransportControls` takes the `UiBridge` because REQ-5 forbids it owning a
transport toggle of its own — that is the same seam `shortcuts.ts` uses to drive
Play from the space bar.

### Persistence

Nothing. The window's open state and position are ephemeral, as with every
[floating window](floating-window.md).

## Visual aids

```
Song panel, top down — the transport row sits against the chains it scrubs
(REQ-4), so a scrubber cell and a chain chip name the same bar:

  ┌ SEQUENCER ┐ ┌ DRUMS ┐ ┌ SAMPLER ┐ ┌ MOTION ┐
  │ A A B A   │ │ …     │ │ …       │ │ …      │   the four lane cards
  └───────────┘ └───────┘ └─────────┘ └────────┘
  [TRANSPORT ❐] [⏮] 3.01  ▏1▕2▕3▕4▏               <- this row
   transport-open  -tostart  -readout  -scrub-<bar>
  [LIVE FX ❐] [DJ FLT] [Fill] [Stutter] …          Live FX, then Song I/O,
                                                    Audio, Sync

FloatingWindow "TRANSPORT"
 ┌────────────────────────────────────────┐
 │ −  TRANSPORT                          ✕ │
 │ [Play] [⏮] 3.09  ▏1▕2▕3▕4▏ (BPM) (SWING)│   transportw-*
 └────────────────────────────────────────┘
```

## Scenarios (BDD)

```gherkin
Scenario: The launcher opens a floating transport usable off the Song tab
  Given the Song tab is open
  When the user clicks TRANSPORT (transport-open)
  Then a transport-window appears with Play, ⏮, a readout, a scrubber, BPM and SWING
  And switching to the Synth tab leaves it visible and live
# pinned by: e2e/transport-window.spec.ts

Scenario: The window's Play button and the header's stay in sync (REQ-5)
  Given the transport is stopped
  When the user clicks the window's Play
  Then the transport starts and BOTH buttons read Stop
  When the user clicks the header's Stop
  Then both read Play again
# pinned by: e2e/transport-window.spec.ts

Scenario: The readout shows the cue while stopped (REQ-6)
  Given the transport is stopped and the user seeks to bar 3 step 9
  Then the readout reads 3.09 — where Play will begin
# pinned by: tests/ui/transport-controls.test.ts

Scenario: Clicking a scrubber bar jumps the song there (REQ-7)
  Given an enabled seq chain of four bars
  When the user clicks the third scrubber cell
  Then the playhead moves to the top of bar 3 and the chain follows
# pinned by: tests/ui/transport-controls.test.ts, e2e/transport-window.spec.ts

Scenario: The scrubber grows and shrinks with the song (REQ-7)
  Given no chain lane is enabled
  Then the scrubber shows a single bar
  When a six-bar drum chain is enabled
  Then it shows six, rebuilt once — not on every tick
# pinned by: tests/ui/transport-controls.test.ts

Scenario: Transport controls go inert while slaved (REQ-8)
  Given canSeek() is false
  Then ⏮ and the scrubber are marked inert and clicking them moves nothing
# pinned by: tests/ui/transport-controls.test.ts

Scenario: The row carries a help badge on its launcher (REQ-10)
  Given help mode is on and the Song tab is open
  Then a `transport.song` badge anchors to the TRANSPORT launcher
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts
```

## Tests & verification

- Unit: `tests/ui/transport-controls.test.ts` — `npm test`
- E2E: `e2e/transport-window.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.engine.clock.step` / `.cue` (DEV only)

## Open questions / future

- A **header** entry point would make the window reachable without visiting the
  Song tab first — the same open question [live-fx-window](live-fx-window.md)
  records, and it should be answered for both at once rather than growing two
  header buttons.
- `Arrangement.songBars()` counts the motion lane; [audio export](audio-export.md)
  deliberately still asks only about the three audible lanes, so a motion chain
  longer than every audio chain lengthens the scrubber but not the export. That
  asymmetry is arguably an export bug, but changing export length is its own
  change with its own regression surface.
