# Record window (free-form capture)

```yaml
id: record-window
status: implemented
version: 1
owner: core
related:
  - audio-export        # REQ-4 there: the phase machine this window drives
  - floating-window     # REQ-9 there: the close veto this window needs
  - dialog              # the discard confirm
  - transport-window    # the sibling window this copies wholesale
  - live-fx-window
  - song-mode
  - onboarding
  - input-control       # the Shift+R shortcut
  - runtime-performance # REQ-4 there: no work for an off-screen window
source:
  - src/ui/components/record-window.ts
  - src/ui/styles/record-window.module.css
  - src/audio/recorder/recorder-controller.ts
  - src/ui/panels/song-panel.ts
  - src/ui/shortcuts.ts
  - src/ui/ui-bridge.ts
```

A floating transport for the free-form recorder: record / pause / stop, a live
elapsed timer, and an explicit save-or-discard before anything reaches the disk.

## Background / Why

Free-form recording used to be a single button on the Song tab (`song-record`)
whose entire vocabulary was a `.on` class and a text flip to `Stop`. Three things
were wrong with it, and they compound:

1. **It was trapped on one tab.** Starting a take meant navigating to the Song
   tab, and so did stopping one — while the whole point of a free take is to
   perform, which happens on the Synth, Sequencer and Drums tabs.
2. **It told you nothing.** No elapsed time, no way to tell a running capture from
   a button someone left highlighted. The one affordance that says "this is
   recording" in every other tool — a red dot and a clock — was absent.
3. **It wrote the file whether you wanted it or not.** `toggleManual` encoded and
   downloaded the moment you stopped, so a fluffed take was already in the
   downloads folder. There was no pause either: a phone call meant one long take
   with a hole in it, or starting over.

A [floating window](floating-window.md) fixes (1) structurally — it mounts on
`document.body`, so once open it stays live on every tab, exactly as LIVE FX and
TRANSPORT do. (2) and (3) are what this spec adds on top of
[audio-export](audio-export.md) REQ-4's phase machine.

## Requirements

- **REQ-1** — **A floating window, built like its two siblings.** The launcher
  ceremony is copied verbatim from `createTransportWindowLauncher`
  ([transport-window](transport-window.md) REQ-2): lazily construct one
  `FloatingWindow`, keep it alive across closes, toggle it from the launcher, drop
  the launcher's `.on` in `onClose`, ❐ glyph + `aria-label`. The window opens at
  its **own** initial offset: `floating-window.module.css` gives every window the
  same default position and z-index 950 with no bring-to-front, so a fourth window
  would otherwise open exactly on top of the other three.
- **REQ-2** — **The window renders the phase, and only the phase.** It owns no
  recorder state of its own — which is also why the timer reset in REQ-4 belongs
  to the controller rather than being papered over here; every control and every
  glyph is derived from
  `RecorderController.phase` by a single `render()`, the one-authority idiom
  `export-song-modal.ts` uses. The four phases
  ([audio-export](audio-export.md) REQ-4):

  | Phase | Status | Actions |
  | --- | --- | --- |
  | `idle` | `○` + `0:00`, dimmed | **Record** · Stop *(disabled)* |
  | `recording` | pulsing red `●` + `REC` + live timer | **Pause** · Stop |
  | `paused` | amber `❙❙` + `PAUSED` + frozen timer | **Resume** · Stop |
  | `review` | `✓` + `<len> captured` | **Save as `<FMT>`** · Discard |
  | `encoding` | `preparing your download…` | *(none — both disabled)* |

  The `encoding` row is why that phase exists ([audio-export](audio-export.md)
  REQ-4): an MP3 of a long take spends seconds in lamejs, and reporting `idle`
  across it left the window looking like it had simply stopped responding.

  One button changes label across `Record`/`Pause`/`Resume`, which is
  [ADR-014](../decisions/adr-014-dont-make-me-think.md)-legal because its outcome
  is written on its face — the Play/Stop precedent — not inferred from hidden
  state.
- **REQ-3** — **Pause pauses the recorder, not the transport**, and the UI must
  say so. The music keeps playing while paused (that is the whole point: you drop
  out of the take and punch back in), so the status line names what is paused and
  the button's `title` spells it out. Nothing here touches `Clock`.
- **REQ-4** — **The timer reports the take, not the wall clock.** It reads
  `capturedSeconds()`, which derives from `RecorderNode.capturedFrames` — so a
  paused stretch never advances it and the number always equals the length of the
  file you will get. Formatted `m:ss` (seconds precision is enough; a
  centisecond field would repaint 100×/s to tell you nothing).
  **It reads `0:00` whenever the phase is `idle`**, because there is no take
  then. The node's frame counter is cleared only by `start()`, so a plain
  read-through left the window showing the *previous* take's length after a save
  or discard — a stale number is worse than no number, since it looks like a
  recording you still have.
- **REQ-5** — **The timer costs nothing when it cannot be seen.** A single
  interval is started only while the window is **open and the phase is
  `recording`**, and cleared on every other transition and on close
  ([runtime-performance](runtime-performance.md) REQ-4). Because the value is
  *derived* rather than accumulated, a window closed for ten minutes and reopened
  shows the correct elapsed time immediately — no catch-up, no drift.
  It ticks at 200 ms rather than 1 s so the displayed second turns over promptly;
  that is one `textContent` write per tick against a cached last-rendered string,
  and it is skipped entirely when the text has not changed.
- **REQ-6** — **The red dot is the one animation that earns its cost.** The
  `recording` state pulses via a CSS `opacity` keyframe (compositor-only, ~2 s
  cycle) on one small element, and the class is removed the instant the phase
  leaves `recording`. "A capture is running" is precisely the message a static
  glyph fails to carry across a tab switch, which is the standard this repo holds
  animation to.
- **REQ-7** — **The launcher shows capture state with the window closed.** It
  carries `.on` while `isCapturing()`, so a take running behind a closed window is
  never invisible from the Song tab.
- **REQ-8** — **Closing with a take in flight asks first.** Via
  [floating-window](floating-window.md) REQ-9's `confirmClose`, which is supplied
  **only when `phase !== 'idle'`** — an idle window closes instantly, with no
  dialog to dismiss for nothing. Confirming **discards**: the capture stops, the
  buffer is dropped and the window closes; cancelling leaves both the window and
  the take exactly as they were. The dialog is `danger`-styled with a `Discard`
  affirmative ([dialog](dialog.md) REQ-4), because that is what it does — a
  confirm that silently *saved* would be a close button that downloads a file.
  It guards every door at once (the ✕, the launcher, the shortcut), because the
  check lives inside `close()`.
- **REQ-9** — **`Shift`+`R` toggles the window from anywhere.** Reach was the
  original complaint, and a floating window only solves it once opened. A bare `r`
  is a note key (`shortcuts.ts` `UPPER`), so the branch sits **above**
  `keyToMidi` — beside the `Shift`+arrow branch, which is there for the same
  reason ([transport-position](transport-position.md) REQ-11) — and `Shift`+`R`
  therefore cannot be typed by accident while playing. It routes through a
  late-bound `UiBridge.toggleRecordWindow`, the `toggleInfoBadges`/`cuePlay` seam,
  so `shortcuts.ts` never reaches into a panel. Listed in the About modal's
  shortcut table ([onboarding](onboarding.md) REQ-17) and carrying a help badge on
  the launcher (REQ-16 there) — the discoverability triple a non-obvious gesture
  needs.
- **REQ-10** — **The format is seeded, not owned.** The window shows its own
  WAV/MP3 segmented, initialised from the Song tab's global default and
  overridable for that take **without writing back**
  ([audio-export](audio-export.md) REQ-9). The Save button echoes it
  (`Save as WAV`), which is where REQ-8 of that spec now lives.
- **REQ-11** — **An export is named as an export, never mistaken for your take.**
  There is one `RecorderNode` and one transport, and an [Export
  Song](audio-export.md) pass walks the *same* phases — so a window rendering the
  phase alone (REQ-2) would read `REC` with a climbing timer for a capture that
  is not the user's and that none of its buttons can touch. While
  `isExporting()`: the status reads *"Exporting the song…"*, the dot does not
  pulse, the timer holds `0:00` (there is no take), and both actions are
  `disabled` with a `title` naming the reason — rather than buttons that silently
  do nothing (`exportSong` and `stopManual` both early-return here anyway).

## Technical design

### Contract / public interface

```yaml
record-window.ts:   # src/ui/components/record-window.ts
  createRecordWindowLauncher(engine: StudioApi,
                             defaultFormat: () => ExportFormat): RecordWindowLauncher
RecordWindowLauncher:
  el: HTMLButtonElement    # the Song-panel launcher (❐, aria-label, .on while capturing)
  toggle(): void           # what UiBridge.toggleRecordWindow is bound to (REQ-9)

UiBridge:            # src/ui/ui-bridge.ts — late-bound, like toggleInfoBadges
  toggleRecordWindow(): void

testids:
  song-record         # the launcher — UNCHANGED id (help badge + song-mode REQ-13 probe)
  record-window       # the FloatingWindow root
  record-toggle       # Record / Pause / Resume (label names its own outcome)
  record-stop         # Stop  (disabled while idle)
  record-save         # Save as <FMT>   (review only)
  record-discard      # Discard         (review only)
  record-status       # the phase word: REC / PAUSED / captured
  record-timer        # m:ss
  record-fmt-<wav|mp3>
```

### Layer touchpoints & ordering

```yaml
state:    NONE of its own. Every render reads RecorderController.phase +
          capturedSeconds(); the window is a pure view (REQ-2).
subscribe: engine.recorder.onPhase(render) — one subscription, taken by the
          LAUNCHER not the window, so `.on` (REQ-7) keeps working while closed.
timer:    one setInterval(200ms), started only when (open && phase==='recording'),
          cleared on every other transition and on close (REQ-5).
close:    confirmClose supplied only while phase !== 'idle' (REQ-8); confirming
          calls discardTake() — the window never saves on the way out.
shortcut: shortcuts.ts Shift+R -> bridge.toggleRecordWindow(), bound by the Song
          panel when it builds the launcher. Branch order: ABOVE keyToMidi (REQ-9).
build order: buildSongPanel creates the launcher and assigns the bridge hook;
          installShortcuts runs after mountApp in main.ts, so the hook is set.
```

### Visual aid

```
┌ RECORD ──────────────────────────── − ✕ ┐
│  ● REC   0:34      [Pause]  [Stop]      │   recording (● pulses)
│  ❙❙ PAUSED 0:34    [Resume] [Stop]      │   paused — the transport plays on
│  ✓ 0:34 captured   [Save as WAV] [Discard]   review — nothing on disk yet
│                              WAV | MP3   │
└─────────────────────────────────────────┘
```

### Persistence

Nothing. The window's open state, position and collapse state are ephemeral like
every floating window, and the take lives only in memory until Save. A take is
deliberately **not** rescued across a reload: it would mean writing tens of MB to
IndexedDB on every pause, and a recording nobody chose to keep is not worth that.

## Scenarios (BDD)

```gherkin
Scenario: The window records, pauses and stops without writing a file
  Given the Record window is open and idle
  When the user clicks Record, then Pause, then Resume, then Stop
  Then the phase walks idle -> recording -> paused -> recording -> review
  And nothing has downloaded
  And the timer never advanced while paused
# pinned by: tests/ui/record-window.test.ts, e2e/record-window.spec.ts

Scenario: The timer resets once the take is gone (REQ-4, regression)
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

Scenario: Closing with an unsaved take asks first (REQ-8)
  Given a take that is paused or in review
  When the user clicks the window's ✕
  Then a danger confirm appears
  And cancelling leaves the window open with the take intact
  And confirming discards the take and closes
# pinned by: tests/ui/record-window.test.ts, e2e/record-window.spec.ts

Scenario: An idle window closes without a dialog (REQ-8, edge)
  Given the Record window is open and idle
  When the user clicks the ✕
  Then it closes immediately — no confirm is raised
# pinned by: tests/ui/record-window.test.ts

Scenario: The window stays live off the Song tab (REQ-1)
  Given the Record window is open and recording
  When the user switches to the Synth tab
  Then the window is still visible and the timer is still advancing
# pinned by: e2e/record-window.spec.ts

Scenario: Shift+R toggles it from any tab (REQ-9)
  Given the Sequencer tab is active and the Record window is closed
  When the user presses Shift+R
  Then the Record window opens
  And a bare `r` still plays its note rather than toggling anything
# pinned by: e2e/record-window.spec.ts, tests/ui/shortcuts.test.ts

Scenario: The launcher shows a capture running behind a closed window (REQ-7)
  Given a take is recording and the window has been closed
  Then the Song tab's Record launcher still carries the `on` class
# pinned by: tests/ui/record-window.test.ts

Scenario: An export is not shown as your recording (REQ-11)
  Given an Export Song pass is in flight, which moves the same phases
  Then the window says it is exporting rather than "REC"
  And the dot does not pulse, the timer stays 0:00, and both actions are
    disabled with a title naming the reason
# pinned by: tests/ui/record-window.test.ts
```

## Tests & verification

- `tests/ui/record-window.test.ts` (jsdom — phases, timer formatting, close guard,
  launcher state), `e2e/record-window.spec.ts` (the real recorder end to end,
  including a downloaded WAV), `tests/audio/recorder/recorder-controller.test.ts`
  (the phase machine underneath).
- `npm test` / `npm run e2e`.

## Open questions / future

- [live-fx-window](live-fx-window.md) and [transport-window](transport-window.md)
  both defer the same question — a **header entry point** for floating windows,
  explicitly to be answered for all of them at once rather than growing one header
  button per window. This is now the third window, and the first with a keyboard
  shortcut; if a header cluster ever lands, the shortcut and the Song-tab launcher
  should fold into it rather than becoming a fourth way in.
- A level meter in the window would answer "is anything actually reaching the
  recorder?", which the timer does not. It needs a metering tap the recorder
  worklet does not currently post.
