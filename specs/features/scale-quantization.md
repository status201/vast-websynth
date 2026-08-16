# Scale & key quantization

```yaml
id: scale-quantization
status: implemented
version: 3   # v3: the playable keyboard wears the key too — same roles, same
             #     palette, one resolver shared with the map (REQ-10); and the
             #     map's legend lists its states in dropdown order (REQ-9)
             # v2: the KEY tab draws a two-octave keyboard map of the current
             #     root, scale and chord (REQ-9)
owner: core
related:
  - architecture
  - sequencer
  - arpeggiator
  - voicing
  - chord-tools
  - input-control
  - runtime-performance
source:
  - src/utils/music.ts                        # pure theory: scale tables, quantize table, chords
  - src/audio/transport/scale-quantizer.ts    # the stateful holder, injected like Arrangement
  - src/audio/transport/sequencer.ts          # trigger site 1 (composes after transpose)
  - src/audio/transport/arpeggiator.ts        # trigger site 2 (the pool)
  - src/audio/engine.ts                       # trigger site 3 (keyboard/MIDI passthrough)
  - src/state/params.ts
  - src/ui/key-roles.ts                       # the one role resolver, shared by both surfaces
  - src/ui/panels/key-panel.ts                # surface 1 — the KEY tab map
  - src/ui/components/keyboard.ts             # surface 2 — the playable keyboard
```

A global key + scale that every pitched note passes through on its way to a voice,
applied **at trigger time and never written to stored data** — plus a destructive
"snap to scale" for when you do want it baked in.

## Background / Why

Before this the instrument had no music-theory layer at all: `SeqStep.note` is a bare
MIDI integer and the only pitch transform in the codebase was `transposeNote`. That had
a concrete musical cost. The authoring dialect already writes chord progressions as bar
transposes — `"seqChain": "A A+5 A+7 A+3"`, how the *First Light* demo is built
([song-authoring-dialect](song-authoring-dialect.md) REQ-15) — and those shifts are
**chromatic**, so a progression drifts out of key by construction. Quantizing *after*
the transpose fixes that with no new param and no song-format field.

The design follows [ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)'s
ordering, which applies to a pitch transform as much as to a worklet: **musical**
(nearest tone, ties resolved deliberately), **stable** (idempotent, and symmetric
between note-on and note-off so nothing can hang), **cheap** (one array index per note,
no allocation on the tick path).

## Requirements

- **REQ-1** (the key is two params, inert by default) — `scale.root` (0..11) and
  `scale.type` (index into `SCALE_LABELS`) are ordinary discrete `ParamBus` params.
  `scale.type` index **0 is `chromatic`**, which is a true no-op, so every preset,
  song and demo predating this feature loads without the keys and sounds
  byte-identical ([ADR-006](../decisions/adr-006-no-op-param-defaults.md)). They ride
  in `file.params` like any scalar, so **no `SONG_VERSION` bump is required** and
  `serialize.ts`, the JSON schema and `llms.txt` are untouched.

- **REQ-2** (nearest tone, ties break downward) — a note not in the scale snaps to the
  nearest scale tone by absolute semitone distance. When two tones are equidistant
  (C♯ in C major is 1 from C and 1 from D) the **lower** wins. This is a musical
  judgement, not an accident of implementation — it matches the convention on hardware
  quantizers and favours the more stable tone — so it is pinned by a test rather than
  left to emerge from the loop order.

  A consequence worth stating plainly, because it surprises: in **any 7-note scale**
  (major, the modes, harmonic minor) every step is 1 or 2 semitones, so *every*
  out-of-scale note is equidistant and the tie rule decides all of them — quantizing
  to major always flattens. Genuine nearest-tone choices only arise in the gapped
  scales (pentatonic, blues), which is where the "nearest" half of this rule earns
  its keep.

- **REQ-3** (idempotent, and bounded) — `q(q(n)) === q(n)`: a note already in the scale
  maps to itself. This is what lets [chord-tools](chord-tools.md) emit diatonic notes
  that pass through the live filter untouched, so the two features cannot fight. The
  result is always within `MIDI_NOTE_MIN..MIDI_NOTE_MAX`; near the extremes, where the
  nearest tone would fall outside, the nearest tone **inside** the range is used —
  clamped, never dropped, for the same reason `transposeNote` clamps
  ([sequencer](sequencer.md) REQ-16, [untrusted-input](untrusted-input.md) REQ-4).

- **REQ-4** (exactly three trigger sites; the port stays dumb) — quantization is applied
  where each note source resolves its pitch, **not** inside `Engine.playNote`. The three
  are the [sequencer](sequencer.md)'s `tickTrack`, the [arpeggiator](arpeggiator.md)'s
  pool, and the keyboard/MIDI passthrough in `Engine`. `SynthOutput`
  (`src/audio/transport/note-output.ts`) is a port and must not editorialize pitch: the
  sequencer and arp hand it notes they have already resolved and whose release they own.
  The drum machine and sampler have their own unpitched trigger paths and are
  **unaffected** — quantizing a kick is meaningless.

- **REQ-5** (transpose first, then quantize) — in the sequencer the arrangement slot's
  transpose is applied *before* quantization, so a `+5` bar lands back in key instead of
  leaving it. This ordering is the whole musical point of the feature (see Background);
  reversing it would preserve the chromatic drift it exists to remove.

- **REQ-6** (resolve once, release through the stored note) — `Polyphony.releaseNote`
  looks up `heldNotes` **keyed by the note number passed in**, so a note-on that was
  quantized and a note-off that re-derives the mapping after the key changed would miss
  the lookup and **strand the voice forever**. The sequencer and arp already obey this
  (`st.lastPlayedNote`, `arp.lastTriggered` store the resolved note). The passthrough is
  the one site that re-derived, and it gets `Engine.heldIn: Map<number, number[]>` —
  raw key → the notes actually sounded. Note-off replays that array and deletes the
  entry. This is what lets a player change key, or switch on chord memory, **while
  holding a chord** without stranding a voice. The map is bounded at 128 keys × ≤4
  notes and is cleared by panic / `killAll`.

- **REQ-7** (cheap enough for the tick path) — the mapping is a 128-entry `Uint8Array`
  (**not** `Int8Array`: 127 is exactly `Int8Array`'s ceiling, so it would work today
  and silently wrap the day `MIDI_NOTE_MAX` moved)
  rebuilt only when `scale.root` or `scale.type` changes, so a note costs one array
  index and allocates nothing. While `scale.type` is `chromatic` the table is `null` and
  `get()` early-returns the input, mirroring `transposeNote`'s
  `if (semitones === 0) return note; // the overwhelmingly common path`. This is
  [runtime-performance](runtime-performance.md) REQ-6 — cache the derivation, invalidate
  it from the store's existing change stream, never recompute per iteration.

- **REQ-8** (snap to scale is the destructive opt-in) — the live filter never rewrites
  stored notes, so turning the scale off restores the original pattern exactly. A
  separate explicit **SNAP** action in the [sequencer](sequencer.md) panel bakes the
  current scale into the edit bank's stored notes across all four tracks, as **one**
  undo entry reusing the existing batch shape `{ kind: 'seq-copy', bank, before }`
  ([pattern-undo](pattern-undo.md)) rather than 64 single-step entries. It is a no-op
  while `scale.type` is `chromatic`, and the control says so rather than silently doing
  nothing.

- **REQ-9** (the key is drawn, not just named, v2) — the KEY tab carries a **two-octave
  keyboard map** showing which notes the current settings actually admit. Three
  dropdowns describe a key; a keyboard *shows* it, and where the semitones fall is the
  part that teaches — so the map keeps real **piano topology** (seven white slots per
  octave with the five black keys inset at their true positions) rather than an even
  twelve-bar strip.

  It is **stylised, not a literal piano**: both key rows are drawn in muted panel tones
  so that colour is spent entirely on meaning, never on being white-and-black. Four
  exclusive states, in falling precedence — **root**, **chord tone**, **in scale**,
  **out of scale** — so the root reads at a glance even though it is also a chord tone
  and a scale tone.

  Everything is keyed by **pitch class**, not absolute note: both octaves light
  identically. That is what makes it a *map* of the key rather than a picture of one
  register, and it keeps the panel symmetric.

  Two consequences worth stating because they look like bugs otherwise:
  - While `chromatic`, **every** key shows as in-scale. That is the honest reading —
    chromatically every note is admitted — and choosing a scale then visibly *removes*
    notes, which is the teaching moment the map exists for.
  - Chord tones are drawn for the **tonic** chord of the current `chord.voicing`
    ([chord-tools](chord-tools.md) REQ-1), because chord memory has no chord until a
    key is pressed. So the voicing control shows its effect before anything is played.

  The map is display-only: it has **no gestures** and sounds nothing (see the gesture
  inventory below). A legend names the three lit states, and each key carries its note
  name and role as a `title`, so the colour code needs no memorising.

  The legend lists those states **in the order of the dropdowns that set them** —
  *root · in scale · chord* against *Root · Scale · Chord memory* — because the legend
  sits directly under the same controls and a reader pairs them positionally. And an
  entry for a colour nothing is currently wearing is **removed from the layout**, not
  merely marked: the hide has to change what is on screen, or it is not a hide.

  **Layout** — the tab reads left to right as *keyboard → root → scale → chord memory →
  hint*: the picture first, then the three controls that set it, then the sentence that
  says what they add up to. On a wide panel that is one vertically centred row. It
  reflows by **wrapping, never by reordering**, so a narrow screen stacks keyboard,
  then the three dropdowns, then the hint, in that same reading order. That is why the
  order lives in the **DOM** and not in CSS `order`: a visual order that disagrees with
  the DOM order is the one thing wrapping cannot preserve, and it desynchronises
  keyboard and screen-reader traversal from what is on screen. The three dropdowns
  share a wrapper so they travel as one unit rather than splitting across rows.

- **REQ-10** (the key is shown where you play it, v3) — the **playable keyboard**
  ([input-control](input-control.md)) carries the same roles as the map, so the key is
  legible from where the fingers already are instead of only on a tab the user has to
  leave the performance to open ([ADR-014](../decisions/adr-014-dont-make-me-think.md)
  law 5: state is visible, not remembered).

  Same **roles**, same **precedence**, same **palette** as REQ-9 — resolved by one
  shared module, `src/ui/key-roles.ts`, and coloured from one shared set of
  `--key-role-*` tokens. Neither surface owns the vocabulary, so they cannot drift
  apart into two colour codes for one idea.

  Four things make it an *annotation* rather than a second map, and each is a decision:

  - **It is a wash, not a repaint.** The playable keyboard is a literal piano — ivory
    and black, unlike the map's muted panel tones (REQ-9) — and those key faces are
    load-bearing for playing it. So the role colour composites *over* the key at low
    alpha instead of replacing it.
  - **Only while a scale is active.** While `chromatic` the keyboard is exactly what it
    was before this feature, untinted. That is the opposite of the map, which lights
    everything — and deliberately so: the map's job is to *teach* that chromatic admits
    all twelve, while the keyboard's job is to mark a restriction, and "all twelve are
    special" marks nothing. It also keeps the app's default appearance unchanged, the
    UI reading of [ADR-006](../decisions/adr-006-no-op-param-defaults.md).
  - **Out-of-scale keys are left alone**, where the map draws an explicit *out of scale*
    state. On the keyboard they are not out of play: an out-of-scale key still sounds,
    quantized onto the nearest tone (REQ-2). Dimming them would claim otherwise.
  - **Pressed beats annotated.** The `.active` (finger / computer key) and `.seq`
    (sequencer playback) states outrank the tint and suppress it, so what a key is
    *doing* is never in competition with what it *is*.

  **Cost** — it is keyed by pitch class, and `keyboard.transpose` moves in whole
  octaves, so an element's own pitch class is always its sounding pitch class: an OCT
  change triggers **no repaint at all**. A repaint is at most 36 attribute writes (24
  on a phone), each guarded against writing the value already there
  ([runtime-performance](runtime-performance.md) REQ-7), and only ever on a
  `scale.root` / `scale.type` / `chord.voicing` change — a user-gesture path, never a
  per-frame or per-tick one.

## Technical design

### Contract / public interface

```yaml
src/utils/music.ts:            # pure — imports nothing from audio/, state/ or ui/
  NOTE_LABELS: string[12]                          # 'C' .. 'B'
  SCALE_LABELS: string[]                           # APPEND-ONLY; index 0 === 'chromatic'
  buildQuantizeTable(root, scale): Uint8Array|null # 128 entries; null when chromatic
  scaleTones(root, scale): number[]                # pitch classes, ascending from root
  diatonicChord(anchor, root, scale, degrees, base=0): number[]  # see chord-tools.md

src/audio/transport/scale-quantizer.ts:
  ScaleQuantizer:
    setRoot(r) / setScale(i)   # rebuild the table (invalidation point)
    get(note): number          # the hot path — one index, or an early return
    active: boolean            # false while chromatic; UI reads it to gate chord tools

src/ui/key-roles.ts:           # UI-only, pure; the one owner of the role vocabulary
  KeyRole: 'root' | 'chord' | 'scale' | 'out'
  KeyState: { root, tones, chord, active }   # all pitch classes; see below
  KEY_PARAMS: readonly ParamId[]             # scale.root, scale.type, chord.voicing
  readKeyState(bus): KeyState                # reads the three params, derives the sets
  keyRole(pc, state): KeyRole                # falling precedence root > chord > scale
  onKeyChange(bus, fn): void                 # subscribes KEY_PARAMS; fires immediately

src/ui/components/keyboard.ts:
  Keyboard.setKeyRoles(state | null): void   # null clears; see REQ-10 and
                                             #   input-control.md REQ-14
```

`KeyState` is derived, never stored: `tones` is every pitch class while chromatic (so
the map lights everything, REQ-9) and `active` is the flag that tells the *keyboard*
to show nothing in that same case (REQ-10). `chord` holds the **tonic** chord of the
current `chord.voicing` ([chord-tools](chord-tools.md) REQ-1), empty when it is off.

### Data shapes (registry)

```yaml
scale.root: { discrete, labels: NOTE_LABELS,  range: 0..11, default: 0 }   # C
scale.type: { discrete, labels: SCALE_LABELS, range: 0..N,  default: 0 }   # chromatic = no-op
```

`SCALE_LABELS` is **append-only**, like `WAVE_LABELS` and `LFO_DEST_LABELS`: a saved
song stores the *index*, so reordering or inserting would silently re-key every song
that predates the change.

### Gesture inventory — the keyboard map (ADR-014)

A keyboard that cannot be played is a strong claim, so every gesture it could receive
is decided here rather than left to whatever the DOM does by default.

| Gesture | Outcome | Why |
| --- | --- | --- |
| hover a key | `title` names the note and its role (`E — chord tone`) | the colour code should never need memorising |
| tap / click a key | — **nothing.** The map is a readout, not an instrument | the app already has a keyboard, at the bottom of the screen, and it is always visible. A second one that sounded notes would make "which keyboard am I playing?" a question the user has to answer (law 2) |
| drag across keys | — nothing, for the same reason | — |
| wheel over the map | — nothing; the root and scale are the two dropdowns directly above it | a wheel that transposed the key would be an invisible, undoable edit |
| click a key to set the root | — rejected: it reads as "play this", and the Root dropdown is 20px away and unambiguous | — |
| keyboard focus | — the map is not focusable; it carries no action, so a tab stop would be a dead end for keyboard and screen-reader users | — |

### Layer touchpoints & ordering

```yaml
engine (subscribeParams):
  scale.root -> quantizer.setRoot(round(x))
  scale.type -> quantizer.setScale(round(x))
construction: ScaleQuantizer is built BEFORE the transport modules, alongside
  Arrangement, so seq + arp can take it by reference (same reason Arrangement is
  constructed first — architecture.md, ordering).
trigger sites:
  sequencer.tickTrack:  quantizer.get(transposeNote(s.note, arrangement.seqTranspose))
  arpeggiator.fire:     quantizer.get(n + o * 12)     # after octave stacking
  engine bus.onNote:    quantizer.get(note) -> heldIn.set(raw, played)
ui: src/ui/panels/key-panel.ts (the KEY tab); src/ui/panels/seq-panel.ts (SNAP)
ui roles (REQ-10), both fed by src/ui/key-roles.ts and never by each other:
  key-panel.ts:  onKeyChange -> readKeyState -> keyMap.paint(state)      # always paints
  app.ts:        onKeyChange -> readKeyState -> keyboard.setKeyRoles(
                   state.active ? state : null)                          # null = chromatic
```

The keyboard is wired in `app.ts` rather than inside `Keyboard` so the component keeps
taking only a `ParamBus` and stays ignorant of music theory — the same split as the
Engine's trigger sites, and the reason `key-roles.ts` sits in `ui/` next to its two
consumers instead of in `utils/music.ts`, which is pure theory with no `ParamBus`.

### Persistence

`scale.root` / `scale.type` persist as ordinary params inside a preset's or song's
`params` bag — no new file section, no version bump. **Not** persisted: the quantize
table (derived), and `Engine.heldIn` (live voice state).

## Scenarios (BDD)

```gherkin
Scenario: Chromatic is a true no-op
  Given scale.type is 0 (chromatic)
  When any note is triggered from any source
  Then the note sounds at exactly the pitch it would have before this feature existed
# pinned by: tests/utils/music.test.ts, tests/audio/transport/sequencer.test.ts

Scenario: An out-of-scale note snaps to the nearest tone (REQ-2)
  Given scale.root is C and scale.type is pentatonic major
  When a step holding F# (66) is triggered
  Then G (67) sounds, because G is 1 semitone away and E is 2
# pinned by: tests/utils/music.test.ts

Scenario: An equidistant note breaks downward (REQ-2, musical judgement)
  Given scale.root is C and scale.type is major
  When a step holding C# (61) is triggered
  Then C (60) sounds, not D (62)
# pinned by: tests/utils/music.test.ts

Scenario: Quantizing is idempotent (REQ-3, stability)
  Given any root and scale
  When a note is quantized twice
  Then the second pass returns the first pass unchanged
# pinned by: tests/utils/music.test.ts

Scenario: A note near the MIDI ceiling is clamped, not dropped (REQ-3, edge)
  Given a scale whose nearest tone above note 127 would be 128
  When note 127 is quantized
  Then the nearest in-range scale tone is returned and it is <= 127
# pinned by: tests/utils/music.test.ts

Scenario: A transposed bar stays in key (REQ-5, the reason this feature exists)
  Given scale.root is C, scale.type is major, and the arrangement slot transposes +5
  When a step holding C (60) fires
  Then the transpose is applied first (65) and the result is quantized into C major
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: Changing key while a key is held does not hang the voice (REQ-6, regression)
  Given a note is held from the keyboard and sounding quantized
  When scale.root changes and the key is then released
  Then the voice that was started is the voice that is released, and nothing hangs
# pinned by: tests/audio/engine-scale.test.ts

Scenario: A tie across a transposed bar releases the note it started (REQ-6, edge)
  Given a tied step started in a bar transposed +5 and quantized
  When the next bar carries a different transpose
  Then the held note is released at the pitch it actually started
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: The live filter never rewrites stored notes (REQ-8)
  Given a pattern holding out-of-scale notes and an active scale
  When the transport plays them
  Then the stored notes are untouched, so chromatic restores the line exactly
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: SNAP bakes the scale into the bank as one undo (REQ-8)
  Given an active scale and a bank of out-of-scale notes
  When SNAP is used and then undone once
  Then every note in all four tracks is restored
# pinned by: tests/state/patterns-chord.test.ts

Scenario: The map lights the scale's notes and dims the rest (v2, REQ-9)
  Given scale.root is C and scale.type is major
  Then C D E F G A B are lit in both octaves
  And C# D# F# G# A# are shown out of scale
# pinned by: tests/ui/key-panel.test.ts

Scenario: The root outranks its other roles (v2, REQ-9, precedence)
  Given a scale is chosen and chord.voicing is a triad
  Then the root key reads as the root, not as a chord tone or a scale tone
# pinned by: tests/ui/key-panel.test.ts

Scenario: Choosing a scale visibly removes notes (v2, REQ-9)
  Given scale.type is chromatic, so every key shows as in scale
  When a scale is chosen
  Then the notes outside it stop being lit
# pinned by: tests/ui/key-panel.test.ts

Scenario: The voicing control shows its effect before a key is played (v2, REQ-9)
  Given a scale is chosen and chord.voicing is off
  When chord.voicing becomes a triad
  Then the tonic triad's pitch classes light as chord tones in both octaves
# pinned by: tests/ui/key-panel.test.ts

Scenario: The tab reads keyboard, controls, hint — in the DOM (v2, REQ-9, layout)
  Given the KEY tab
  Then the keyboard comes first, then root, scale and chord memory, then the hint
  And that order is the DOM order, so wrapping to a narrow screen preserves it
# pinned by: tests/ui/key-panel.test.ts

Scenario: The map cannot be played (v2, REQ-9, gesture inventory)
  Given the KEY tab is open
  When a key of the map is clicked
  Then no note sounds and nothing is selected
# pinned by: tests/ui/key-panel.test.ts

Scenario: The legend reads in the order of the dropdowns (v3, REQ-9, regression)
  Given the KEY tab, whose dropdowns read Root, Scale, Chord memory
  Then the legend under the map reads root, in scale, chord — in that order
# pinned by: tests/ui/key-panel.test.ts

Scenario: A legend entry nothing is wearing leaves the layout (v3, REQ-9, regression)
  Given a scale is chosen and chord.voicing is off, so no key is a chord tone
  Then the chord legend entry is not rendered, not merely marked hidden
# pinned by: tests/ui/key-panel.test.ts

Scenario: The playable keyboard wears the key (v3, REQ-10)
  Given scale.root is C and scale.type is major
  Then every C key on the playable keyboard reads as the root
  And D E F G A B read as in scale in every drawn octave
  And C# D# F# G# A# carry no role at all
# pinned by: tests/ui/keyboard.test.ts, e2e/key.spec.ts

Scenario: Chromatic leaves the playable keyboard untouched (v3, REQ-10)
  Given a scale is chosen and the keyboard is showing it
  When scale.type returns to chromatic
  Then no key on the playable keyboard carries a role
# pinned by: tests/ui/keyboard.test.ts, e2e/key.spec.ts

Scenario: The root outranks its other roles on the keyboard too (v3, REQ-10)
  Given scale.root is C, scale.type is major and chord.voicing is a triad
  Then C reads as the root, E and G read as chord tones, and D F A B as in scale
# pinned by: tests/ui/keyboard.test.ts

Scenario: An OCT change does not repaint the roles (v3, REQ-10, cost)
  Given the keyboard is showing C major
  When keyboard.transpose moves by an octave
  Then every key carries exactly the role it carried before
# pinned by: tests/ui/keyboard.test.ts

Scenario: A pressed key is not in competition with its tint (v3, REQ-10)
  Given a key that reads as in scale
  When it is pressed, or the sequencer plays it
  Then the lit state is what shows, and the tint gets out of its way
# pinned by: tests/ui/keyboard.test.ts (the classes coexist); the suppression itself is
#   CSS, checked by eye per "Tests & verification" below

Scenario: An old song loads with no scale keys and is unchanged (REQ-1, back-compat)
  Given a committed demo saved before this feature
  When it is loaded
  Then scale.type is 0 and the rendered notes are identical to before
# pinned by: tests/state/patterns-scale.test.ts
```

## Tests & verification

- Unit: `tests/utils/music.test.ts`, `tests/audio/transport/sequencer.test.ts`,
  `tests/audio/transport/arpeggiator.test.ts`, `tests/audio/engine-scale.test.ts`,
  `tests/state/patterns-scale.test.ts` — `npm test`
- Unit (v3, the two role surfaces): `tests/ui/key-roles.test.ts` (the resolver),
  `tests/ui/key-panel.test.ts` (the map + the legend), `tests/ui/keyboard.test.ts`
  (`setKeyRoles`, and that it does not disturb the lit bookkeeping)
- E2E: `e2e/key.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- **By eye** (v3, REQ-10) — the wash is a *look*, and no assertion can tell you whether
  it is subtle enough to live under your hands all day. The same argument
  [ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md) makes for sound applies to
  pixels here: what a test can pin is the role on the element, not whether the colour
  reads. Run `npm run dev` and check, at minimum, that in-scale **black** keys are
  legible (they are the hard case, being dark already), and that a pressed key still
  reads unmistakably as pressed against a tinted neighbour.
- **By ear** ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md),
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)) — this changes *pitch*, so a
  green suite proves nothing about whether it is musical. Render with `npm run
  bench:audio`, always A/B against a `scale.type: 0` baseline with the untested lanes
  muted. The real check is *First Light*: with its `A+5 A+7 A+3` chain and C major set,
  the progression should stay in key where it previously drifted.
- Dev bridge: `window.__synth.bus.get('scale.type')` (DEV only).

## Open questions / future

- **Per-bar key modulation** was considered and deliberately deferred: it needs a
  `SongFile` field and touches [arrangement](arrangement.md), where a global key needs
  neither. Revisit if songs start wanting a bridge in a different key.
- Making bar transposes shift by scale *degrees* rather than semitones is **not**
  planned — transpose-then-quantize (REQ-5) already keeps them in key without a second
  mechanism or a new param.
