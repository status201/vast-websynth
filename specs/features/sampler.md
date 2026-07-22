# Sampler

```yaml
id: sampler
status: implemented
version: 1
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
  - dialog
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
voices for decoded audio buffers. Crucially, **decoded buffers are not persisted** —
they live only in `SamplerMachine`; a song saves only the filenames
(`patterns.sampleNames`), and after import the user re-loads the files (the UI shows
a `.needs-reload` hint). This keeps song files small and avoids embedding audio.

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
```

### Data shapes (registry + store)

```yaml
sampler.on:     { discrete, labels: [off, on], default: 0 }
sampler.master: { range: 0..1, default: 0.85 }
sampler.mute / sampler.solo:  # lane mixer (song-mode)
sampler.t{i}.mute: { discrete, labels: [on, mute], default: 0 }   # per slot 0..7
store:
  PatternStore.samplerBanks: SamplerStep[bank][slot][step]   # 4 × 8 × 16
  PatternStore.sampleNames:  (string | null)[8]              # persisted; buffers are NOT
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
  When the song is saved and reloaded
  Then only the filename persists; the slot shows a needs-reload hint until re-loaded
# pinned by: tests/state/song.test.ts (sampleNames round-trip), song-mode.md
```

## Tests & verification

- `tests/audio/transport/sampler-machine.test.ts`, `e2e/sampler.spec.ts`
  (WAV via `setInputFiles` + a Node-built fixture).
- `npm test` / `npm run e2e`.

## Open questions / future

- Per-slot pitch/start-offset would extend `SamplerStep`/the slot params; keep new
  fields optional for [song](song-mode.md) backward-compat.
