# Machine status & tab navigation

```yaml
id: machine-status
status: implemented
version: 3  # v3: the lane-title ↗ glyph is dropped below 720px (REQ-6)
            # v2: Chain/Mute/Solo in every machine header, shared with the Song
            #     tab's lane cards (REQ-9)
owner: core
related:
  - song-mode
  - arrangement
  - motion-sequencer
  - responsive-machine-header
  - architecture
source:
  - src/ui/machine-status.ts              # the pure three-state rule + bus adapter
  - src/ui/components/chain-toggle.ts     # the Chain button, shared by both surfaces
  - src/ui/components/switch.ts           # testId override for the duplicated params
  - src/ui/panels/step-panel-scaffold.ts  # laneControlsFor (the header cluster)
  - src/ui/components/tabs.ts             # the tab LED + reveal()
  - src/ui/styles/tabs.module.css         # LED states
  - src/ui/panels/song-panel.ts           # clickable lane titles
  - src/ui/styles/song-panel.module.css   # title link affordance
  - src/ui/ui-bridge.ts                   # showTab hook
  - src/audio/transport/lane-mix.ts       # audibleLanes (reused, not reimplemented)
```

## Background / Why

Two gaps in the Song tab. First, the four lane cards are titled "Sequencer" /
"Drums" / "Sampler" / "Motion" but the titles were inert `<div>`s — reading a
chain and wanting to edit that machine meant hunting for its tab. Second, there
was no way to tell whether a machine was enabled without activating its tab, so
"why is there no sound?" required a tour of every machine.

The obvious fix for the second — a status light in the tab bar — risks an
**affordance collision**: a tab says "click me to navigate", a toggle inside it
says "click me to switch something off", and the user cannot tell the regions
apart. The wrong guess (silencing the drums mid-performance) is far more
punishing than an accidental navigation. So the light is a **pure indicator**,
never a control; clicking anywhere in the tab — dot included — navigates. The dot
answers "is this on?" and clicking it leads to where the real toggle lives.

## Requirements

- **REQ-1 (one source of truth)** — Machine state derives from one pure function,
  `machineStatus`, which **reuses** `audibleLanes` (`lane-mix.ts`) rather than
  re-deriving the mute/solo rule. Every consumer (tab LED, Song panel) reads
  through it.
- **REQ-2 (three states)** — Each machine is `off` (its `<m>.on` param is 0),
  `muted` (enabled but inaudible — its own mute, or another lane's solo), or `on`
  (enabled and audible). Motion has no solo and makes no sound, so its `muted`
  state is driven by `motion.mute` alone (`params.ts` documents its active rule as
  `motion.on && !motion.mute`).
- **REQ-3 (the LED is not a control)** — The tab indicator is `pointer-events:
  none` with no hover, focus or cursor styling of its own. The tab highlights as
  one uniform unit; every click in the tab navigates. There is no code path by
  which the LED mutates a param.
- **REQ-4 (not colour-only)** — The tab button carries a `title`/`aria-label`
  naming the machine and its state (e.g. "Drums — muted"), so the state survives
  colour-blindness and screen readers.
- **REQ-5 (titles navigate)** — Each Song-panel lane title is a `<button>`
  (testid `song-lane-title-<seq|drum|sampler|motion>`) that reveals that
  machine's tab via `UiBridge.showTab`. The lane prefix `drum` maps to the tab id
  `drums`; the other three are identity.
- **REQ-6 (the link is visible at rest)** — The title carries a `↗` glyph that is
  legible without hover. A hover-only affordance is invisible on touch, and this
  ships as an installable PWA used on phones. The glyph is `aria-hidden` — the
  button's `aria-label` already names the destination, so it must not be
  announced as "north east arrow".
  (v3) **It is dropped below 720 px**, the app's phone breakpoint. The four lane
  cards are already two-up by 992 px, so on a phone each title shares a very
  narrow card with its Chain/Mute/Solo controls, and the glyph costs width the
  machine's *name* needs more. Nothing is lost there that the arrow was carrying:
  the affordance it exists to replace is hover, which a touch device does not
  have, and the whole card is visibly a control surface. `display: none`, not
  `visibility: hidden` — the point is to give the width back.
- **REQ-7 (reveal beats activate)** — `TabContainer.reveal(id)` expands a
  collapsed tab bar *then* activates, matching what a real tab click does. Plain
  `activate()` does not expand and must not be the external entry point.
- **REQ-8 (no new dim behaviour)** — The Song panel's existing "silenced" dimming
  continues to key off audibility only. A machine whose `<m>.on` is 0 does **not**
  dim its card; that state is carried by the LED alone.
- **REQ-9 (the lane controls live on both surfaces, v2)** — **Chain, Mute and
  Solo** sit in every machine header, immediately after that machine's on/off
  switch (`SEQ` / `DRUMS` / `SAMPLER` / `MOTION`) — the same three controls the
  Song tab's lane card carries, in the same order.
  The LED indicator (REQ-3) answers *"is this on?"* but the fix for it was always
  "go to where the toggle lives", and for mute/solo/chain that meant the Song tab.
  Reading a machine's own tab and wanting to silence it, or to hear it in
  isolation while editing, meant a round trip. Duplicating the controls where the
  work happens removes it.
  - **Motion gets no Solo**, exactly as on the Song tab: it is not an audio lane,
    so there is nothing to solo (`audibleLanes` has no motion entry —
    [motion-sequencer](motion-sequencer.md) REQ-6/REQ-12). Volume stays off the
    machine headers entirely: each already has its own `MASTER` knob.
  - **One implementation, two hosts.** Mute/Solo are the same `Switch` bound to
    the same `<lane>.mute` / `.solo` params, so the two surfaces stay in lock-step
    for free — each instance subscribes to the bus. Chain goes through a shared
    `createChainToggle` (`src/ui/components/chain-toggle.ts`) rather than a second
    hand-rolled button, so behaviour, LED state and looks cannot drift. It is a
    switch-styled `<button>`, not a `Switch`, because a chain's `enabled` flag is
    `Arrangement` state, not a `ParamBus` param — which also means its LED must be
    refreshed from `arrangement.onChange`, not a bus subscription.
  - **Testids must differ per surface**: `switch-<lane>.mute` stays on the Song
    tab, the header copies are `machine-<lane>-mute` / `-solo` / `-chain` (and the
    Song tab's Chain button gains `song-chain-<lane>`, which it never had). Two
    elements sharing a testid break Playwright's strict mode.
  - Sizing is the one deliberate difference: the Song tab's compact `.ctl` padding
    exists for its cramped lane cards, so the header copies take the default
    switch size and match the switches beside them.

## Technical design

### Contract / public interface

```yaml
machine-status:  # src/ui/machine-status.ts (pure core + bus adapter)
  type MachineId = 'seq' | 'drum' | 'sampler' | 'motion'
  type MachineState = 'off' | 'muted' | 'on'
  MACHINE_IDS: readonly MachineId[]
  MACHINE_TAB: Record<MachineId, string>        # 'drum' -> 'drums'; others identity
  machineStatus(on, mute, solo): Record<MachineId, MachineState>   # PURE
  laneFlags(bus, suffix): LaneFlags             # shared bus reader (seq/drum/sampler)
  readMachineStatus(bus): Record<MachineId, MachineState>
  subscribeMachineStatus(bus, fn): () => void   # returns a disposer

TabContainer:  # src/ui/components/tabs.ts
  Tab { id, label, content, indicator?: boolean }
  reveal(id): void                              # expand-then-activate (REQ-7)
  setIndicator(id, state: MachineState): void   # writes led.dataset.state + aria-label
                                                # no-op for tabs without `indicator`

UiBridge:
  showTab(id: string): void                     # assigned in buildPatternRow
```

### The state rule

```yaml
per machine:
  on-param below 0.5              -> 'off'
  else seq/drum/sampler:
    audibleLanes(mute, solo)[m]   -> 'on'  else 'muted'   # solo wins over mute
  else motion:
    motion.mute >= 0.5            -> 'muted' else 'on'
params read: seq|drum|sampler .on/.mute/.solo  (9) + motion.on/.mute  (2) = 11
```

### Layer touchpoints & ordering

```yaml
construction (src/ui/app.ts buildPatternRow):
  buildSongPanel(...)      # line ~377 — BEFORE the TabContainer exists
  new TabContainer([...])  # the song panel's el is itself a tab's content
why: the Song panel cannot hold a `tabs` reference — it is a construction cycle.
     UiBridge is the established hook for exactly this (cf. undoActiveMachine,
     cuePlay), and buildChainLane already receives `bridge`.
wiring (after `tabs` exists, beside bridge.undoActiveMachine):
  bridge.showTab = (id) => tabs.reveal(id)
  refreshStatus() -> readMachineStatus(bus) -> tabs.setIndicator(MACHINE_TAB[m], s[m])
  subscribeMachineStatus(bus, refreshStatus); refreshStatus()   # initial paint
```

### Visual language

The state rides on `data-state`, **not** a class: CSS selects it via
`.led[data-state='…']`, and both unit tests and E2E can read it without knowing
the hashed CSS-Module name (CSS Modules resolve to `undefined` under Vitest, so a
class-based state would be untestable at the unit level).

One lamp at three brightnesses, reusing the switch LED's red (`switch.module.css`)
so the tab dots read as the same hardware as every other indicator in the app:

```yaml
on:    --led-on  + 8px red glow    # fully lit — enabled and audible
muted: #8c2414, no glow            # half lit  — enabled but silent
off:   --led-off + inset shadow    # unlit     — disabled (the .led base)
```

## Scenarios (BDD)

```gherkin
Scenario: A disabled machine reads off
  Given drum.on is 0
  Then the drum machine's state is 'off' regardless of its mute/solo
# pinned by: tests/ui/machine-status.test.ts

Scenario: Solo elsewhere mutes an enabled machine (REQ-1)
  Given drum.on is 1, drum is not muted, and the seq lane is soloed
  Then the drum machine's state is 'muted' and seq's is 'on'
# pinned by: tests/ui/machine-status.test.ts

Scenario: Motion has no solo (edge)
  Given motion.on is 1 and another lane is soloed
  Then motion's state is 'on' — solo does not silence a non-audio lane
  And setting motion.mute to 1 makes it 'muted'
# pinned by: tests/ui/machine-status.test.ts

Scenario: A lane title opens its machine tab (REQ-5)
  Given the Song tab is active
  When the user clicks song-lane-title-drum
  Then panel-drums becomes visible
# pinned by: e2e/machine-status.spec.ts

Scenario: reveal expands a collapsed tab bar (REQ-7)
  Given the pattern row is collapsed
  When reveal('seq') runs
  Then the body is no longer collapsed and tab-seq is active
# pinned by: tests/ui/tabs.test.ts

Scenario: The LED tracks the bus without being clickable (REQ-3)
  Given the app is booted
  When drum.on is set to 0 via the bus
  Then tab-drums' LED carries the 'off' state and its aria-label says so
  And the LED element is not an event target (pointer-events: none)
# pinned by: e2e/machine-status.spec.ts, tests/ui/tabs.test.ts

Scenario: Every machine header carries Chain, Mute and Solo (v2, REQ-9)
  Given the Sequencer, Drums and Sampler tabs
  Then each header holds machine-<lane>-chain, -mute and -solo, in that order,
    directly after that machine's on/off switch
# pinned by: e2e/machine-status.spec.ts

Scenario: Motion's header has no Solo (edge, v2, REQ-9)
  Given the Motion tab
  Then its header holds machine-motion-chain and machine-motion-mute
  And machine-motion-solo does not exist — motion is not an audio lane
# pinned by: e2e/machine-status.spec.ts

Scenario: The header controls and the Song tab stay in lock-step (v2, REQ-9)
  Given help of neither surface — both bind the same params
  When the user mutes from the Drums header
  Then the Song tab's drum lane Mute reads muted too, and the tab LED goes amber
  When the user enables the chain from the Drums header
  Then the Song tab's drum Chain button lights, because both share one toggle
# pinned by: e2e/machine-status.spec.ts

Scenario: A tab without an indicator renders no LED (edge)
  Given a tab registered without `indicator`
  Then its button contains no LED span and setIndicator on it is a no-op
# pinned by: tests/ui/tabs.test.ts
```

## Tests & verification

- Unit: `tests/ui/machine-status.test.ts` (the pure truth table),
  `tests/ui/tabs.test.ts` (reveal + setIndicator + no-indicator tabs) — `npm test`
- E2E: `e2e/machine-status.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.bus.set('drum.on', 0)` (DEV only)

## Open questions / future

- The Song panel's lane cards could carry the same LED next to their titles. Left
  out for now: the cards already dim when silenced (REQ-8), so a second signal in
  the same place would be redundant.
