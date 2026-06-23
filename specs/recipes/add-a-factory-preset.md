# Recipe — add a factory preset

```yaml
id: add-a-factory-preset
status: implemented
version: 1
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
  // … basic, bass, lead, pad, pluck, wobble …
  myPreset: {
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
  relying on whatever was loaded before.
- Stick to registered param ids — unknown ids are stored but do nothing.
- A factory preset is a *sound only* — patterns/banks/chains belong in a
  [song](../features/song-mode.md), not a preset.

## Acceptance (BDD)

```gherkin
Scenario: The factory preset seeds and loads
  Given a fresh localStorage
  When the app boots
  Then "myPreset" appears in the list and loading it restores its snapshot
# pinned by: tests/state/preset.test.ts
```

## Tests & verification

- `tests/state/preset.test.ts`, `e2e/presets.spec.ts`. `npm test`.
