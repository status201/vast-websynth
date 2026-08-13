# Sampler

```yaml
id: sampler
status: implemented
version: 4   # v4: a transport stop cuts in-flight one-shots (REQ-8)
owner: core
related:
  - architecture
  - drum-machine
  - step-settings
  - step-grid-editing
  - banks
  - sample-recorder
  - song-mode
  - project-export
  - sample-persistence
  - dialog
  - transport
  - effects
source:
  - src/audio/transport/sampler-machine.ts
  - src/state/patterns.ts
  - src/audio/engine.ts
  - src/ui/panels/sampler-panel.ts
```

An 8-slot one-shot sampler — structurally a sibling of the
[drum machine](drum-machine.md), but each slot plays a user-loaded `AudioBuffer`.

## Background / Why

The sampler reuses the drum machine's grid/bank/step model — including the
shared [grid gestures](step-grid-editing.md) — but swaps synthesised
voices for decoded audio buffers. Crucially, **buffers are not part of a song** —
they live in `SamplerMachine`; a song saves only the filenames
(`patterns.sampleNames`), and after import the user re-loads the files (the UI shows
a `.needs-reload` hint). This keeps song files small and avoids embedding audio.
Device-locally the buffers *do* outlive a reload: they are mirrored into
IndexedDB by [sample-persistence](sample-persistence.md), which is invisible to
the song format.

## Requirements

- **REQ-1** — 8 slots (`SAMPLER_SLOT_COUNT`), each plays a loaded `AudioBuffer`
  one-shot, honouring the shared [per-step settings](step-settings.md).
- **REQ-2** — Slots filled by **Load** (WAV/MP3) or the
  [record-sound modal](sample-recorder.md).
- **REQ-3** — Reads `patterns.samplerBank(arrangement.samplerPlayBank)` each tick;
  buffers live in the machine, **not** in `PatternStore`.
- **REQ-4** — Only filenames persist in a song; buffers are reloaded after a
  song import (`.needs-reload` hint). A [project-zip](project-export.md) import
  repopulates the buffers directly — the hint clears without a manual reload.
- **REQ-5** — Gate < 1 chokes the per-hit velocity gain (same choke model as drums).
- **REQ-6** — `setBuffer` emits `onBufferChange(slot)`. It is the **one** place
  every slot-filling path converges, which is what lets
  [sample-persistence](sample-persistence.md) mirror slots to storage without a
  single caller knowing.
- **REQ-7** — **A slot's audio never disagrees with its label.** A buffer
  belongs to the name beside it, so a song load that renames a slot evicts that
  slot's buffer (`Song.apply`'s optional `sampler` handle — see
  [song-mode](song-mode.md) REQ-3b). The `.needs-reload` hint is therefore
  trustworthy: it appears whenever a named slot has no matching audio, and a
  slot showing no hint really is playing what it says.
- **REQ-8** (v4) — **A transport stop cuts in-flight one-shots.** Unlike a drum
  voice, a slot plays a user-supplied buffer of arbitrary length, and a **tied**
  cell gets no choke at all (`chokeAt` returns `undefined` when the hit holds), so
  a long sample kept playing to its end after Stop — with no way to silence it,
  since Panic only kills synth voices. `SamplerMachine` therefore keeps a handle
  on every hit still in flight (`{src, g}`, added in `play` and removed by the
  `onended` it already installs) and `stopAll()` fades each one out over the same
  5 ms the choke uses before `src.stop()` — no click, and a hit still scheduled
  inside the look-ahead simply never plays. The fade is on the per-hit gain,
  upstream of `samplerBus`, so the [FX](effects.md) tails ring out untouched: Stop
  silences the *source*, never the room.
  **`stopAll` is public and `Engine` subscribes `clock.onStop`, not the machine**
  ([ADR-008](../decisions/adr-008-components-self-wire-params.md)) — because the one
  exception is Engine's to know. A stop that *ends a capture*
  ([audio-export](audio-export.md), [render-to-sampler](render-to-sampler.md)) is
  deliberately rendering the tail, so the cut is skipped while
  `recorder.isCapturing()` or `bankRender.isRendering()`. Note this is
  **deliberately not** the pair `canSeek()` guards on: `canSeek()` tests
  `recorder.isExporting()`, because an offline export may be seeked while a live
  capture may not (`Engine`, with a code comment saying so). Chopping the last bar's one-shots out of an
  export would be a worse bug than the hang this fixes.
  **Drums need no equivalent**: every drum voice already schedules a finite
  `src.stop()` via `chokeRoute(...).stopAt(natural)`, so a tied drum cell decays
  naturally and terminates. Cutting that decay would remove a tail, not a hang.

## Technical design

### Contract / public interface

```yaml
SamplerMachine:  # src/audio/transport/sampler-machine.ts
  slotGains: GainNode[]; buffers: (AudioBuffer | null)[]; muted: boolean[]
  setEnabled(on)
  setBuffer(slot, buf | null)
  setSlotMute(slot, muted)
  triggerSlot(slot, velocity?)     # manual audition
  onStep(fn) -> unsubscribe
  onBufferChange(fn) -> unsubscribe   # slot's buffer replaced/cleared
  stopAll()                        # v4, REQ-8: fade + stop every in-flight hit
engine (init):                     # v4 — the POLICY, so the capture exception fits
  clock.onStop(() => { if (recorder.isCapturing() || bankRender.isRendering()) return;
                       sampler.stopAll(); })
  # canSeek() guards on isExporting(), NOT isCapturing() — different questions.
```

### Data shapes (registry + store)

```yaml
sampler.on:     { discrete, labels: [off, on], default: 0 }
sampler.master: { range: 0..1, default: 0.85 }
sampler.mute / sampler.solo:  # lane mixer (song-mode)
sampler.t{i}.mute: { discrete, labels: [on, mute], default: 0 }   # per slot 0..7
store:
  PatternStore.samplerBanks: SamplerStep[bank][slot][step]   # 4 × 8 × 16
  PatternStore.sampleNames:  (string | null)[8]              # in the song; buffers are NOT
  SamplerMachine.buffers:    (AudioBuffer | null)[8]         # device-local (sample-persistence.md)
```

### Layer touchpoints

```yaml
engine (subscribeParams):
  sampler.on -> setEnabled; sampler.master -> laneMixer.setSamplerVol
  sampler.t{i}.mute -> sampler.setSlotMute(i, ...)
graph: slotGain -> samplerBus (+ sampler dist/phaser/delay/reverb) -> preMaster
ui: src/ui/panels/sampler-panel.ts
  sampler-step-<slot>-<s> grid; sampler-load/name/edit/file-<slot>; per-slot mute
  Load decode failure reports via the custom alertDialog (see dialog.md), not alert()
```

## Scenarios (BDD)

```gherkin
Scenario: Load a WAV and trigger it from the grid
  Given a WAV is loaded into slot 0
  When a step for slot 0 fires
  Then the decoded buffer plays one-shot at the step velocity
# pinned by: tests/audio/transport/sampler-machine.test.ts, e2e/sampler.spec.ts

Scenario: Buffers are not embedded in a saved song (edge)
  Given slot 0 has a loaded sample
  When the song file is exported and imported elsewhere
  Then only the filename travels; the slot shows a needs-reload hint until re-loaded
# pinned by: tests/state/song.test.ts (sampleNames round-trip), song-mode.md

Scenario: Loading another song does not leave the old song's audio behind (regression)
  Given slot 0 plays "beep.wav"
  When a song naming slot 0 differently (or not at all) is loaded
  Then slot 0 is empty and its label reverts to the placeholder — never the new
    name over the old audio
# pinned by: e2e/song.spec.ts, tests/state/song.test.ts

Scenario: Stopping the transport cuts a long tied sample (v4, REQ-8, regression)
  Given a tied step is playing a long sample, so no choke was ever scheduled
  When the transport stops
  Then the hit fades out over the choke fade and its source is stopped
  And the FX tails keep ringing, because the fade is upstream of the sampler bus
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A song export keeps its final one-shot (v4, REQ-8, edge)
  Given the last bar of a song triggers a long sample
  When the export's own clock.stop ends the rendered pass
  Then the one-shot is NOT cut, so the render tail captures it as it always did
# pinned by: engine.ts clock.onStop guard (recorder.isRecording / bankRender.isRendering)

Scenario: Filling a slot notifies exactly once
  Given a listener registered via onBufferChange
  When setBuffer(3, buf) runs
  Then the listener fires once with slot 3
# pinned by: tests/audio/transport/sampler-machine.test.ts
```

## Tests & verification

- `tests/audio/transport/sampler-machine.test.ts`, `e2e/sampler.spec.ts`
  (WAV via `setInputFiles` + a Node-built fixture).
- `npm test` / `npm run e2e`.

## Open questions / future

- Per-slot pitch/start-offset would extend `SamplerStep`/the slot params; keep new
  fields optional for [song](song-mode.md) backward-compat.
