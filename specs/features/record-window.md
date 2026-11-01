# Record window (free-form capture)

```yaml
id: record-window
status: implemented
version: 2
owner: core
related:
  - audio-export        # the phase machine this window drives
  - floating-window     # the close veto this window needs
  - dialog              # the discard confirm
  - transport-window    # the sibling window it follows
  - live-fx-window
  - song-mode
  - onboarding
  - input-control       # the Shift+R shortcut
  - runtime-performance # no work for an off-screen window
source:
  - src/ui/components/record-window.ts
  - src/ui/styles/record-window.module.css
  - src/audio/recorder/recorder-controller.ts
  - src/ui/panels/song-panel.ts
  - src/ui/shortcuts.ts
  - src/ui/ui-bridge.ts
```

A floating transport for the free-form recorder: record / pause / stop, a live
elapsed timer and peak meter, and an explicit save-or-discard before anything
reaches the disk.

## Background / Why

A take is performed on the machine tabs, so its controls must be reachable off
the Song tab. It must say plainly that it is recording (a red dot and a clock), it
must be pausable, and it must never write a file the user did not choose to keep.
A [floating window](floating-window.md) mounts on `document.body`, so once open it
stays live on every tab. The rest sits on [audio-export](audio-export.md)
REQ-capture-is-a-five-phase-machine.

## Requirements

- **REQ-record-window-is-a-floating-window** — Built like its siblings, following
  `createTransportWindowLauncher` ([transport-window](transport-window.md)
  REQ-transport-is-a-floating-window). One `FloatingWindow` is built lazily and
  kept across closes. The launcher toggles it, drops its `.on` in `onClose`, and
  carries the `popOut` icon ([iconography](iconography.md)) and an `aria-label`.
  It opens at its **own** initial offset, because windows share one default
  position and z-index with no bring-to-front.
- **REQ-the-window-renders-only-the-phase** — It owns no recorder state. Every
  control and glyph comes from `RecorderController.phase` through a single
  `render()`:

  | Phase | Status | Actions |
  | --- | --- | --- |
  | `idle` | `○` + `0:00`, dimmed | **Record** · Stop *(disabled)* |
  | `recording` | pulsing red `●` + `REC` + live timer | **Pause** · Stop |
  | `paused` | amber `❙❙` + `PAUSED` + frozen timer | **Resume** · Stop |
  | `review` | `✓` + `<len> captured` | **Save as `<FMT>`** · Discard |
  | `encoding` | `preparing your download…` | *(none — both disabled)* |

  One button reads `Record`/`Pause`/`Resume`. Its outcome is written on its face,
  as with Play/Stop (ADR-014).
- **REQ-pause-pauses-the-recorder-not-the-transport** — The music plays on while
  paused, so you drop out and punch back in. The status line and the button's
  `title` say so. Nothing here touches `Clock`.
- **REQ-the-timer-reports-the-take** — The timer reads `capturedSeconds()` (from
  `RecorderNode.capturedFrames`), so a pause never advances it and it equals the
  file's length. It is formatted `m:ss`. **It reads `0:00` whenever the phase is
  `idle`**: the node's counter is cleared only by `start()`, and a stale length
  would look like a take you still have.
- **REQ-the-timer-costs-nothing-when-hidden** — A single 200 ms interval runs only
  while the window is **open and the phase is `recording`**
  ([runtime-performance](runtime-performance.md) REQ-no-work-for-offscreen-dom).
  The value is derived, so reopening shows the right time at once. Each tick
  writes `textContent` only when the string changed.
- **REQ-the-red-dot-earns-its-animation** — In `recording` the dot pulses with a
  compositor-only `opacity` keyframe (~2 s). The class is removed the instant the
  phase leaves `recording`. "A capture is running" is exactly what a static glyph
  fails to carry.
- **REQ-the-meter-shows-what-reaches-the-recorder** (v2) — A thin bar
  (`record-meter`) shows the loudest captured sample since the last paint, from
  −60 dBFS (empty) to 0 dBFS, turning red at 0 dBFS (`data-clip`). The timer cannot
  tell music from silence (every lane muted). `RecorderNode` takes each batch's
  peak as it appends it (`takePeak()` reads and resets), so the worklet is
  unchanged. It paints on the timer's tick and shares its gating, and it is empty
  in every other phase. It moves by `transform: scaleX`, never a transition.
  `role="meter"` carries the dB.
- **REQ-the-launcher-shows-capture-state** — The launcher carries `.on` while
  `isCapturing()`, so a take behind a closed window is never invisible.
- **REQ-closing-mid-take-asks-first** — Via [floating-window](floating-window.md)
  REQ-a-window-may-veto-its-close's `confirmClose`, supplied **only when `phase !==
  'idle'`**. Confirming **discards** (capture stopped, buffer dropped, window
  closed); cancelling changes nothing. It is `danger`-styled with a `Discard`
  affirmative ([dialog](dialog.md) REQ-danger-confirm-is-red). It guards every door
  (✕, launcher, shortcut), because the check lives inside `close()`.
- **REQ-shift-r-toggles-the-record-window** — `Shift`+`R` toggles the window from
  anywhere. A bare `r` is a note key, so the branch sits **above** `keyToMidi`,
  beside the `Shift`+arrow branch ([transport-position](transport-position.md)
  REQ-home-and-shift-arrows-seek). It routes through a late-bound
  `UiBridge.toggleRecordWindow`. It is listed in the About shortcut table
  ([onboarding](onboarding.md) REQ-about-key-symbols-are-drawn), and the launcher
  carries the `song.record` badge ([onboarding](onboarding.md)
  REQ-the-song-audio-buttons-keep-their-badges).
- **REQ-the-record-format-is-seeded-not-owned** — The window's WAV/MP3 segmented is
  seeded from the Song tab's default and overridable per take **without writing
  back** ([audio-export](audio-export.md) REQ-export-opens-an-options-modal). Save
  echoes it (`Save as WAV`).
- **REQ-an-export-is-named-as-an-export** — An [Export Song](audio-export.md) pass
  walks the same phases on the same node. While `isExporting()`, the status reads
  *"Exporting the song…"*, the dot does not pulse, the timer holds `0:00`, and both
  actions are `disabled` with a `title` naming the reason.

## Technical design

### Contract / public interface

```yaml
record-window.ts:   # src/ui/components/record-window.ts
  createRecordWindowLauncher(engine: StudioApi,
                             defaultFormat: () => ExportFormat): RecordWindowLauncher
RecordWindowLauncher:
  el: HTMLButtonElement    # the Song-panel launcher (popOut icon, aria-label, .on while capturing)
  toggle(): void           # what UiBridge.toggleRecordWindow is bound to

UiBridge:            # src/ui/ui-bridge.ts — late-bound, like toggleInfoBadges
  toggleRecordWindow(): void

testids:
  song-record         # the launcher (help badge + song-mode REQ-sync-and-audio-pair-up probe)
  record-window       # the FloatingWindow root
  record-toggle       # Record / Pause / Resume
  record-stop         # Stop  (disabled while idle)
  record-save         # Save as <FMT>   (review only)
  record-discard      # Discard         (review only)
  record-status       # the phase word: REC / PAUSED / captured
  record-timer        # m:ss
  record-meter        # peak meter (role=meter, data-clip at 0 dBFS)
  record-fmt-<wav|mp3>
```

### Layer touchpoints & ordering

```yaml
state:    NONE of its own; every render reads RecorderController.phase + capturedSeconds()
subscribe: engine.recorder.onPhase(render) — taken by the LAUNCHER, so `.on` works while closed
meter:    RecorderNode.takePeak() / RecorderController.takePeak()   # 0 unless recording a take
timer:    one setInterval(200ms) while (open && phase==='recording')
close:    confirmClose only while phase !== 'idle'; confirming calls discardTake()
shortcut: shortcuts.ts Shift+R -> bridge.toggleRecordWindow(), ABOVE keyToMidi
build order: buildSongPanel creates the launcher and assigns the bridge hook;
          installShortcuts runs after mountApp in main.ts
```

### Visual aid

```
┌ RECORD ──────────────────────────── − ✕ ┐
│  ● REC   0:34  ▮▮▮▮▯  [Pause]  [Stop]   │   recording (● pulses)
│  ❙❙ PAUSED 0:34       [Resume] [Stop]   │   paused — the transport plays on
│  ✓ 0:34 captured   [Save as WAV] [Discard]   review — nothing on disk yet
│                              WAV | MP3   │
└─────────────────────────────────────────┘
```

### Persistence

Nothing. Open state, position and collapse are ephemeral, and the take lives in
memory until Save. A take is not rescued across a reload: that would mean writing
tens of MB to IndexedDB on every pause.

## Scenarios (BDD)

```gherkin
Scenario: The window records, pauses and stops without writing a file
  Given the Record window is open and idle
  When the user clicks Record, then Pause, then Resume, then Stop
  Then the phase walks idle -> recording -> paused -> recording -> review
  And nothing has downloaded
  And the timer never advanced while paused
# pinned by: tests/ui/record-window.test.ts, e2e/record-window.spec.ts

Scenario: The timer resets once the take is gone (REQ-the-timer-reports-the-take, regression)
  Given a take of 1:34 has just been saved (or discarded)
  Then the window reads 0:00, not the length of the take it no longer holds
# pinned by: tests/audio/recorder/recorder-controller.test.ts,
#            tests/ui/record-window.test.ts

Scenario: Save writes the take; Discard throws it away
  Given a take in review
  When the user clicks Save as WAV
  Then one RIFF/WAVE file downloads and the window returns to idle
  When another take is taken and Discarded instead
  Then nothing downloads and the phase returns to idle
# pinned by: e2e/record-window.spec.ts

Scenario: Closing with an unsaved take asks first (REQ-closing-mid-take-asks-first)
  Given a take that is paused or in review
  When the user clicks the window's ✕
  Then a danger confirm appears
  And cancelling leaves the window open with the take intact
  And confirming discards the take and closes
# pinned by: tests/ui/record-window.test.ts, e2e/record-window.spec.ts

Scenario: An idle window closes without a dialog (REQ-closing-mid-take-asks-first, edge)
  Given the Record window is open and idle
  When the user clicks the ✕
  Then it closes immediately — no confirm is raised
# pinned by: tests/ui/record-window.test.ts

Scenario: The window stays live off the Song tab (REQ-record-window-is-a-floating-window)
  Given the Record window is open and recording
  When the user switches to another tab
  Then the window is still visible and the timer is still advancing
# pinned by: e2e/record-window.spec.ts

Scenario: The meter shows what reaches the recorder (REQ-the-meter-shows-what-reaches-the-recorder)
  Given the Record window is open and a take is recording
  When batches arrive whose loudest sample is 0.5
  Then the meter fills to about 90% (-6 dBFS on a 60 dB scale)
  When a batch peaks at 1.0 or above
  Then the meter is marked clipping
  When the take is paused or stopped
  Then the meter is empty
# pinned by: tests/audio/recorder/node.test.ts, tests/ui/record-window.test.ts, e2e/record-window.spec.ts

Scenario: Shift+R toggles it from any tab (REQ-shift-r-toggles-the-record-window)
  Given the Sequencer tab is active and the Record window is closed
  When the user presses Shift+R
  Then the Record window opens
  And a bare `r` still plays its note rather than toggling anything
# pinned by: e2e/record-window.spec.ts, tests/ui/shortcuts.test.ts

Scenario: The launcher shows a capture running behind a closed window (REQ-the-launcher-shows-capture-state)
  Given a take is recording and the window has been closed
  Then the Song tab's Record launcher still carries the `on` class
# pinned by: tests/ui/record-window.test.ts

Scenario: An export is not shown as your recording (REQ-an-export-is-named-as-an-export)
  Given an Export Song pass is in flight, which moves the same phases
  Then the window says it is exporting rather than "REC"
  And the dot does not pulse, the timer stays 0:00, and both actions are
    disabled with a title naming the reason
# pinned by: tests/ui/record-window.test.ts
```

## Tests & verification

- `tests/ui/record-window.test.ts` (jsdom), `e2e/record-window.spec.ts` (real
  recorder end to end, a downloaded WAV, the meter rising on a note),
  `tests/audio/recorder/recorder-controller.test.ts`, `tests/audio/recorder/node.test.ts`
  — `npm test` / `npm run e2e`.

## Open questions / future

- A **header entry point** for floating windows is deferred for all of them at once
  ([live-fx-window](live-fx-window.md), [transport-window](transport-window.md)). If
  one lands, this window's shortcut and launcher fold into it.
