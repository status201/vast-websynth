# Recipe — add a factory preset

```yaml
id: add-a-factory-preset
status: implemented
version: 2                     # v2: banks spread PLAIN_VOICE first (presets.md v14)
owner: core
related:
  - presets
source:
  - src/state/preset.ts                  # the FACTORY bank
```

How to add a built-in sound preset. A near one-file change.

## Background / Why

A [preset](../features/presets.md) is just a `Snapshot` (`Record<string, number>`)
of params. The `FACTORY` bank in `preset.ts` is seeded into `localStorage` on boot
by `ensureFactoryPresets()` (only if absent, so user edits to a factory name are not
clobbered) and merged into `Presets.list()`.

## Steps

### 1. Add a named `Snapshot` to `FACTORY` — `src/state/preset.ts`

```ts
const FACTORY: FactoryBank = {
  // … basic, bass, lead, pad, …, upright, wobble …
  myPreset: {
    ...PLAIN_VOICE,             // cross-mod, sync, pulse widths, every mod row off
    'osc1.wave': 2, 'osc1.level': 0.7,
    'filter.cutoff': 90, 'filter.resonance': 1.0,
    'env.amp.attack': 0.005, 'env.amp.release': 0.4,
    // … set every param that defines the sound …
    'master.volume': 0.8, 'voicing.mode': 1,
  },
};
```

### 2. Verify

It shows up in the preset dropdown after a reload (the boot seeder runs
`ensureFactoryPresets()`). `npm run typecheck` + `npm test`.

## Gotchas

- **Set the full sound.** A preset is applied over the current bus, so include
  every param that defines the patch (mirror the existing entries) rather than
  relying on whatever was loaded before. Spread `PLAIN_VOICE` first. It turns
  off the oscillators' FM, ring, sync and pulse width, every mod-matrix row and
  every effect but the reverb, and it sets the values most banks share (no sub,
  one unison voice, both LFOs parked). List only what defines your sound, plus
  `fx.reverb.on`, which every bank sets explicitly. A row you switch on also needs its
  `dst` and `amt`, and `osc2.sync` needs `osc2.syncPitch`.
  `tests/state/preset.test.ts` fails on a bank that misses any of these
  ([presets](../features/presets.md) REQ-a-factory-preset-sets-the-full-sound).
- **A new param that a preset can engage joins `PLAIN_VOICE`** (or the per-bank
  list the tests pin), at its no-op value. A load resets it anyway
  (REQ-loading-a-preset-starts-from-the-default-sound), but a bank file should say what it means.
- Changing an existing bank is safe for returning users: a stored copy that is
  only an older seed is refreshed on boot (REQ-an-older-factory-seed-is-refreshed).
  A retuned *value* is not, because it looks like an edit.
- Stick to registered param ids — unknown ids are stored but do nothing.
- A factory preset is a *sound only* — patterns/banks/chains belong in a
  [song](../features/song-mode.md), not a preset.

## Scenarios (BDD)

```gherkin
Scenario: The factory preset seeds and loads
  Given a fresh localStorage
  When the app boots
  Then "myPreset" appears in the list and loading it restores its snapshot
# pinned by: tests/state/preset.test.ts
```

## Tests & verification

- `tests/state/preset.test.ts`, `e2e/presets.spec.ts`. `npm test`.
