# Play-button LED blink states

```yaml
id: play-button-blink
status: implemented
version: 2
owner: core
related:
  - transport
  - song-mode
  - onboarding
source:
  - src/ui/app.ts                       # buildHeader — blink state machine
  - src/ui/ui-bridge.ts                 # cuePlay hook
  - src/ui/panels/song-panel.ts         # demo loads fire the cue
  - src/ui/styles/layout.module.css     # attract / cue keyframes
```

The header Play button's LED as a discoverability affordance: it always shows
*something* — beat-synced red while playing, a slow orange pulse while stopped,
and a fast green cue after any stopped-state action that needs Play to be heard
(demo/song load, import, enabling a machine or chain).

## Background / Why

New users routinely missed the header Play button entirely — they'd load a demo
and hear nothing, not realising the transport had to be started. The LED was
dark whenever the transport was stopped, i.e. exactly when the button most
needed attention. The fix keeps the existing playing-state beat blink and adds
two stopped-state blinks: a subtle standing "attract" pulse, and a stronger
"press play now" cue after any action that is silent until the transport runs.

## Requirements

- **REQ-1 (beat blink, pre-existing)** — While the transport plays, the LED is
  red (`.on`) and blinks with the beat: lit for steps 0–1 of each beat, dimmed
  (`.blink` class) for steps 2–3, driven by `clock.onTick`.
- **REQ-2 (idle attract)** — While the transport is stopped, the LED pulses
  **orange, slowly** (~2 s cycle, CSS animation via the `attract` class) so the
  transport is discoverable. Active from boot.
- **REQ-3 (silent-action cue, v2)** — Any action that stays *audibly inert
  until the transport runs* arms a **fast green blink** (~0.4 s cycle, `cue`
  class) — a "press play" call to action — when it happens while the transport
  is **stopped**. Cueing actions:
  - loading a **demo** (any demo button, JSON or zip; also the tour's `loadDemo`);
  - the Song panel's **Load** button (localStorage slot);
  - a successful song/project **import** (Import button, OS file launch,
    share link — all funnel through `applyProjectBundle`/`importBytes`);
  - turning a **step machine on** (`seq.on` / `drum.on` / `sampler.on` rising
    to on, observed on the ParamBus). The **arp is excluded**: it auto-starts
    the transport on a held key, so there is no silent dead-end;
  - **enabling an arrangement chain lane** (the Song tab's per-lane Chain
    button, user click).
  The same action while already playing does *not* arm the cue. The signal
  travels via `UiBridge.cuePlay` (callers → header), assigned in `buildHeader`
  before any UI can fire it.
- **REQ-4 (exclusivity & lifecycle)** — At most one blink state at a time:
  `attract` and `cue` are only present while stopped (cue wins while armed);
  starting the transport clears both and consumes the cue; stopping returns to
  `attract`. The beat blink runs only while playing (unchanged).
- **REQ-5 (reduced motion)** — Under `prefers-reduced-motion: reduce` the
  animations are disabled; the LED holds the steady state colour instead
  (orange for attract, green for cue).

## Technical design

### Contract / public interface

```yaml
UiBridge:
  cuePlay(): void          # no-op default; buildHeader assigns the real handler
buildSongPanel(bus, engine, session, xy, bridge)   # bridge threaded (new param)
state classes on the play button (global, like `.on`/`.blink`):
  attract  # stopped, no cue armed  -> slow orange LED pulse
  cue      # stopped, cue armed     -> fast green LED blink
```

### Layer touchpoints & ordering

```yaml
buildHeader (app.ts): owns the cueArmed flag + refreshIdleBlink(); subscribes
  clock.onStart (clear + consume cue) / onStop (back to attract); assigns
  bridge.cuePlay AND subscribes bus 'seq.on'/'drum.on'/'sampler.on' (value on
  -> cuePlay). Runs before buildPatternRow, so the hook is live before any
  cueing UI exists.
song-panel.ts: applyDemo (the tail EVERY demo branch ends on — built-in,
  fetched JSON drop-in, and the tour), the Load button, applyProjectBundle
  (imports + zip demos + share links + OS launches) and buildChainLane's
  Chain-enable click call bridge.cuePlay().
layout.module.css: .playBtn:global(.attract)/.playBtn:global(.cue) animate
  the :global(.switch-led) dot; keyframes are module-scoped.
```

Note the machine-switch trigger listens on the **bus**, so any surface that
flips `seq.on`/`drum.on`/`sampler.on` (panel switch, song apply, author-dialect
auto-enable) cues — the load/import call sites stay explicit because a song can
cue without changing any machine switch.

Nothing persists; the cue is session-transient by design.

## Scenarios (BDD)

```gherkin
Scenario: The Play LED attracts while stopped
  Given the app has booted and the transport is stopped
  Then the play button carries the `attract` class (slow orange pulse)
# pinned by: e2e/song.spec.ts

Scenario: A demo click arms the green cue
  Given the transport is stopped
  When a demo button is clicked
  Then the play button swaps `attract` for `cue` (fast green blink)
# pinned by: e2e/song.spec.ts

Scenario: Enabling a machine while stopped arms the cue (v2)
  Given the transport is stopped
  When drum.on (or seq.on / sampler.on) rises to on
  Then the play button carries `cue`
# pinned by: e2e/song.spec.ts

Scenario: Loading or importing a song while stopped arms the cue (v2)
  Given the transport is stopped
  When the Load button applies a slot, or an import/share link applies successfully
  Then the play button carries `cue`
# by design: explicit cuePlay() at each apply site

Scenario: Starting the transport consumes the cue
  Given the cue is armed
  When the transport starts
  Then `cue` and `attract` are removed and the beat blink takes over
   And a later stop returns the button to `attract`, not `cue`
# pinned by: e2e/song.spec.ts

Scenario: A cueing action during playback does not cue (edge)
  Given the transport is playing
  When a demo is loaded (or a machine enabled, a song imported, …)
  Then no `cue` class appears, now or after the next stop
# by design: cuePlay ignores the call while playing
```

## Tests & verification

- E2E: `e2e/song.spec.ts` (attract on boot, cue after a demo click, cue on a
  machine-enable via the dev bridge) — `npm run e2e`.
- Visual (blink timing, reduced motion): manual.
- `npm run typecheck`.

## Open questions / future

- v2 widened the cue from demos to every silent-while-stopped action (load,
  import, machine/chain enables). Candidates deliberately left out: the arp
  switch (auto-starts on a held key), unmute/solo (the lane may already be
  audible), and step edits (too noisy).
