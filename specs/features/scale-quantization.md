# Scale & key quantization

```yaml
id: scale-quantization
status: implemented
version: 4
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
applied **at trigger time and never written to stored data**, plus a destructive "snap
to scale" for when you do want it baked in.

## Background / Why

The dialect writes progressions as bar transposes (`"seqChain": "A A+5 A+7 A+3"`,
[song-authoring-dialect](song-authoring-dialect.md)
REQ-a-chain-letter-may-carry-a-transpose). Those are **chromatic**, so a progression
drifts out of key. Quantizing *after* the transpose fixes that with no new song field.
The design follows ADR-010: **musical** (nearest tone, deliberate ties), **stable**
(idempotent, symmetric on and off so nothing hangs), **cheap** (one array index per
note). A key may also admit **one extra note** (a blue note, a bebop passing tone),
which belongs to the melody, not the harmony. It plays as written but is not a scale
*degree*, so chord tools still count the mode's own seven.

## Requirements

- **REQ-the-key-is-two-inert-params** — `scale.root` (0..11), `scale.type` (index into
  `SCALE_LABELS`) and `scale.extra` are ordinary discrete params. `scale.type` 0 is
  `chromatic`, a true no-op, and `scale.extra` 0 is `none` (ADR-006). They ride in
  `file.params`: no `SONG_VERSION` bump, and no `serialize.ts`, schema or `llms.txt`
  change.
- **REQ-nearest-tone-ties-break-downward** — An out-of-scale note snaps to the nearest
  scale tone. When two are equidistant the **lower** wins: the hardware convention,
  pinned by a test. In any 7-note scale every out-of-scale note is equidistant, so
  quantizing to major always flattens. Genuine nearest-tone choices arise in the gapped
  scales (pentatonic, blues).
- **REQ-quantization-is-idempotent-and-bounded** — `q(q(n)) === q(n)`, so
  [chord-tools](chord-tools.md)' diatonic notes pass through untouched. Results stay in
  `MIDI_NOTE_MIN..MIDI_NOTE_MAX`. Near the extremes the nearest in-range tone is used,
  clamped and never dropped ([sequencer](sequencer.md)
  REQ-every-note-is-shifted-by-the-slot-transpose, [untrusted-input](untrusted-input.md)
  REQ-payload-values-are-bounded).
- **REQ-exactly-three-quantize-trigger-sites** — Quantization is applied where each
  source resolves its pitch: the [sequencer](sequencer.md)'s `tickTrack`, the
  [arpeggiator](arpeggiator.md)'s pool, and the keyboard/MIDI passthrough in `Engine`.
  It is **not** inside `Engine.playNote`: `SynthOutput` is a port and must not
  editorialize pitch. The drum machine and sampler are unpitched and unaffected.
- **REQ-transpose-first-then-quantize** — In the sequencer the slot transpose comes
  *before* quantization, so a `+5` bar lands back in key. Reversed, it would preserve
  the drift.
- **REQ-resolve-once-release-the-stored-note** — A note-off must release the note the
  note-on resolved, or a key change while holding strands the voice. The sequencer and
  arp store the resolved note (`st.lastPlayedNote`, `arp.lastTriggered`). The
  passthrough uses `Engine.heldIn` ([voicing](voicing.md)
  REQ-passthrough-remembers-what-it-played), cleared by panic / `killAll`.
- **REQ-the-scale-mapping-is-a-lookup-table** — A 128-entry `Uint8Array` (**not**
  `Int8Array`: 127 is its ceiling and would silently wrap if `MIDI_NOTE_MAX` moved),
  rebuilt only when a key param changes. While `chromatic` it is `null` and `get()`
  returns the input. One index, no allocation
  ([runtime-performance](runtime-performance.md) REQ-no-allocation-in-a-hot-loop).
- **REQ-snap-to-scale-is-the-destructive-opt-in** — The live filter never rewrites
  stored notes, so chromatic restores the pattern exactly. The sequencer panel's
  **SNAP** bakes the current key into the edit bank's notes on all four tracks as
  **one** undo entry (`{ kind: 'seq-copy', bank, before }`,
  [pattern-undo](pattern-undo.md)). It writes exactly what the live filter plays,
  extra note included. While `chromatic` it is a no-op, and the control says so.
- **REQ-the-key-is-drawn-not-just-named** — The KEY tab has a **two-octave keyboard
  map** in real piano topology (seven white slots per octave, the black keys inset)
  showing which notes the key admits.
  - It is stylised in muted panel tones, so colour is spent on meaning. Five exclusive
    roles, in falling precedence: **root**, **chord tone**, **in scale**, **extra
    note**, **out of scale**. It is keyed by **pitch class**, so both octaves match.
  - While `chromatic` every key shows in scale: the honest reading, and choosing a
    scale then visibly removes notes.
  - Chord tones are the **tonic** chord of `chord.voicing`
    ([chord-tools](chord-tools.md) REQ-chords-are-stacked-scale-degrees), so the
    voicing shows its effect before a key is played.
  - It is display-only (see the gesture inventory). Each key's `title` names the note
    and its role.
  - The legend lists roles **in the order of the dropdowns that set them** (*root · in
    scale · extra note · chord* against *Root · Scale · Extra note · Chord memory*). An
    entry nothing wears is **removed from the layout**.
  - Layout reads *keyboard → root → scale → extra note → chord memory → hint* in the
    **DOM**, not CSS `order`, so wrapping preserves it for keyboard and screen-reader
    traversal. The dropdowns share one wrapper.
- **REQ-the-key-is-shown-where-you-play** — The **playable keyboard**
  ([input-control](input-control.md)) wears the same roles, precedence and palette
  (`src/ui/key-roles.ts`, `--key-role-*` tokens), so the key is visible where the
  fingers are (ADR-014 law 5). It is an annotation, not a second map:
  - **a wash, not a repaint**: the role composites over the ivory/black key at low
    alpha;
  - **only while a scale is active**: chromatic leaves the keyboard untinted (the UI
    reading of ADR-006);
  - **out-of-scale keys are left alone**: they still sound, quantized;
  - **pressed beats annotated**: `.active` and `.seq` suppress the tint.

  It is keyed by pitch class, and `keyboard.transpose` moves whole octaves, so an OCT
  change repaints nothing. A repaint is at most 36 guarded attribute writes
  ([runtime-performance](runtime-performance.md)
  REQ-dom-writes-are-guarded-on-what-is-rendered), only on a key-param change.
- **REQ-an-extra-note-is-admitted-not-a-degree** — `scale.extra` (`EXTRA_LABELS`: `none ·
  blue b5 · blue b3 · b7 · maj 7 · bebop`) names **one** pitch class over the root.
  - The table admits `scaleTones ∪ {extra}`, so the note plays as written and neighbours
    may snap onto it. Idempotence and bounds hold over the union.
  - It is **not a degree**: `scaleTones`, `scaleSize`, `degreeOf`, `diatonicChord` and
    `degreeLabel` ignore it. A key held on it under chord memory plays that one note
    (`degreeOf` → -1, `ScaleQuantizer.chord` answers `[q]`), since a passing tone has no
    chord.
  - While `chromatic` the dropdown is **disabled with the reason shown**
    ([chord-tools](chord-tools.md) REQ-chord-tools-require-a-scale).
  - An extra note **already in the scale** changes nothing, and the hint says so. It
    stays selectable: switching scale must never rewrite a stored param.
  - `EXTRA_LABELS` is **append-only**. Flats are spelled with ASCII `b` (a `♭` glyph
    would fall through to a symbol face, [iconography](iconography.md)).
- **REQ-bebop-is-relative-to-the-mode** — Four extras are fixed intervals (`blue b5` +6,
  `blue b3` +3, `b7` +10, `maj 7` +11). `bebop` adds the passing tone that makes the
  mode's eight-note bebop scale (after David Baker):

  | Scale | bebop adds | Resulting scale |
  | --- | --- | --- |
  | major | ♯5 (+8) | major bebop |
  | mixolydian | maj 7 (+11) | dominant bebop |
  | dorian | maj 3 (+4) | dorian bebop (Baker; some texts add the maj 7 instead — a choice) |
  | minor | maj 7 (+11) | harmonic-minor bebop |
  | harm minor | ♭7 (+10) | harmonic-minor bebop |
  | phrygian | maj 3 (+4) | phrygian with both thirds (phrygian-dominant's third) |
  | lydian | ♯5 (+8) | by analogy with major bebop |
  | pent maj, pent min, blues | — | built on a seven-note scale; nothing is added |

  The table lives in `src/utils/music.ts` beside `SCALE_STEPS`.
- **REQ-the-extra-note-wears-its-own-role** — `extra` is a role in
  `src/ui/key-roles.ts`, between scale and out, with `--key-role-extra*`. Unlike `out`,
  the playable keyboard **tints** it, because it sounds as written. Its legend entry
  follows the dropdown order and leaves the layout while unused. Its dropdown sits
  between Scale and Chord memory in the same wrapper.

## Technical design

### Contract / public interface

```yaml
src/utils/music.ts:            # pure — imports only the MIDI bounds from state/limits.ts
  NOTE_LABELS: string[12]                          # 'C' .. 'B'
  noteName(midi): string                           # 60 → 'C4' (C-1 = 0); the one note namer
  SCALE_LABELS: string[]                           # APPEND-ONLY; index 0 === 'chromatic'
  EXTRA_LABELS: string[]                           # APPEND-ONLY; index 0 === 'none'
  buildQuantizeTable(root, scale, extra = 0): Uint8Array|null # 128 entries; null when chromatic
  scaleTones(root, scale): number[]                # pitch classes from the root — never the extra
  extraTone(root, scale, extra): number|null       # null when none, chromatic, or already in the scale
  diatonicChord(anchor, root, scale, degrees, base=0): number[]  # see chord-tools.md

src/audio/transport/scale-quantizer.ts:
  ScaleQuantizer:
    setRoot(r) / setScale(i) / setExtra(i)   # rebuild the table (invalidation point)
    get(note): number          # the hot path — one index, or an early return
    active: boolean            # false while chromatic; UI reads it to gate chord tools

src/ui/key-roles.ts:           # UI-only, pure; the one owner of the role vocabulary
  KeyRole: 'root' | 'chord' | 'scale' | 'extra' | 'out'
  KeyState: { root, tones, chord, extra, active }   # pitch classes; extra is number|null
  KEY_PARAMS: readonly ParamId[]             # scale.root, scale.type, scale.extra, chord.voicing
  readKeyState(bus): KeyState
  keyRole(pc, state): KeyRole                # root > chord > scale > extra > out
  onKeyChange(bus, fn): void                 # subscribes KEY_PARAMS; fires immediately

src/ui/components/keyboard.ts:
  Keyboard.setKeyRoles(state | null): void   # null clears (input-control.md REQ-a-third-highlight-layer)
```

`KeyState` is derived, never stored. `tones` is every pitch class while chromatic (the
map lights everything), and `active` tells the keyboard to show nothing then.

### Data shapes (registry)

```yaml
scale.root: { discrete, labels: NOTE_LABELS,  range: 0..11, default: 0 }   # C
scale.type: { discrete, labels: SCALE_LABELS, range: 0..N,  default: 0 }   # chromatic = no-op
scale.extra: { discrete, labels: EXTRA_LABELS, range: 0..M, default: 0 }   # none = no-op
EXTRA_LABELS: ['none', 'blue b5', 'blue b3', 'b7', 'maj 7', 'bebop']
```

### Gesture inventory — the keyboard map (ADR-014)

| Gesture | Outcome | Why |
| --- | --- | --- |
| hover a key | `title` names the note and its role (`E — chord tone`) | the colour code needs no memorising |
| tap / click a key | — **nothing**; the map is a readout | a second, sounding keyboard would make "which am I playing?" a question (law 2) |
| drag across keys | — nothing | — |
| wheel over the map | — nothing; root and scale are the dropdowns above | a wheel transposing the key would be an invisible edit |
| click a key to set the root | — rejected: it reads as "play this" | — |
| keyboard focus | — not focusable; it carries no action | — |

### Layer touchpoints & ordering

```yaml
engine (subscribeParams):
  scale.root -> quantizer.setRoot(round(x))
  scale.type -> quantizer.setScale(round(x))
  scale.extra -> quantizer.setExtra(round(x))
construction: ScaleQuantizer is built BEFORE the transport modules, alongside Arrangement,
  so seq + arp take it by reference
trigger sites:
  sequencer.tickTrack:  quantizer.get(transposeNote(s.note, arrangement.seqTranspose))
  arpeggiator.fire:     quantizer.get(n + o * 12)     # after octave stacking
  engine bus.onNote:    quantizer.get(note) -> heldIn.set(raw, played)
ui: src/ui/panels/key-panel.ts (the KEY tab); src/ui/panels/seq-panel.ts (SNAP)
ui roles, both fed by src/ui/key-roles.ts and never by each other:
  key-panel.ts:  onKeyChange -> readKeyState -> keyMap.paint(state)      # always paints
  bottom.ts:     onKeyChange -> readKeyState -> keyboard.setKeyRoles(
                   state.active ? state : null)                          # null = chromatic
```

The keyboard is wired in `shell/bottom.ts`, so `Keyboard` takes only a `ParamBus` and
knows no theory. That is also why `key-roles.ts` sits in `ui/`, not in the pure
`utils/music.ts`.

### Persistence

The three key params persist as ordinary params. Not persisted: the quantize table
and `Engine.heldIn`.

## Scenarios (BDD)

```gherkin
Scenario: Chromatic is a true no-op
  Given scale.type is 0 (chromatic)
  When any note is triggered from any source
  Then the note sounds at exactly its unquantized pitch
# pinned by: tests/utils/music.test.ts, tests/audio/transport/sequencer.test.ts

Scenario: An out-of-scale note snaps to the nearest tone (REQ-nearest-tone-ties-break-downward)
  Given scale.root is C and scale.type is pentatonic major
  When a step holding F# (66) is triggered
  Then G (67) sounds, because G is 1 semitone away and E is 2
# pinned by: tests/utils/music.test.ts

Scenario: An equidistant note breaks downward (REQ-nearest-tone-ties-break-downward, musical judgement)
  Given scale.root is C and scale.type is major
  When a step holding C# (61) is triggered
  Then C (60) sounds, not D (62)
# pinned by: tests/utils/music.test.ts

Scenario: Quantizing is idempotent (REQ-quantization-is-idempotent-and-bounded, stability)
  Given any root and scale
  When a note is quantized twice
  Then the second pass returns the first pass unchanged
# pinned by: tests/utils/music.test.ts

Scenario: A note near the MIDI ceiling is clamped, not dropped (REQ-quantization-is-idempotent-and-bounded, edge)
  Given a scale whose nearest tone above note 127 would be 128
  When note 127 is quantized
  Then the nearest in-range scale tone is returned and it is <= 127
# pinned by: tests/utils/music.test.ts

Scenario: A transposed bar stays in key (REQ-transpose-first-then-quantize, the reason this feature exists)
  Given scale.root is C, scale.type is major, and the arrangement slot transposes +5
  When a step holding C (60) fires
  Then the transpose is applied first (65) and the result is quantized into C major
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: Changing key while a key is held does not hang the voice (REQ-resolve-once-release-the-stored-note, regression)
  Given a note is held from the keyboard and sounding quantized
  When scale.root changes and the key is then released
  Then the voice that was started is the voice that is released, and nothing hangs
# pinned by: tests/audio/engine-scale.test.ts

Scenario: A tie across a transposed bar releases the note it started (REQ-resolve-once-release-the-stored-note, edge)
  Given a tied step started in a bar transposed +5 and quantized
  When the next bar carries a different transpose
  Then the held note is released at the pitch it actually started
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: The live filter never rewrites stored notes (REQ-snap-to-scale-is-the-destructive-opt-in)
  Given a pattern holding out-of-scale notes and an active scale
  When the transport plays them
  Then the stored notes are untouched, so chromatic restores the line exactly
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: SNAP bakes the scale into the bank as one undo (REQ-snap-to-scale-is-the-destructive-opt-in)
  Given an active scale and a bank of out-of-scale notes
  When SNAP is used and then undone once
  Then every note in all four tracks is restored
# pinned by: tests/state/patterns-chord.test.ts

Scenario: The map lights the scale's notes and dims the rest (REQ-the-key-is-drawn-not-just-named)
  Given scale.root is C and scale.type is major
  Then C D E F G A B are lit in both octaves
  And C# D# F# G# A# are shown out of scale
# pinned by: tests/ui/key-panel.test.ts

Scenario: The root outranks its other roles (REQ-the-key-is-drawn-not-just-named, precedence)
  Given a scale is chosen and chord.voicing is a triad
  Then the root key reads as the root, not as a chord tone or a scale tone
# pinned by: tests/ui/key-panel.test.ts

Scenario: Choosing a scale visibly removes notes (REQ-the-key-is-drawn-not-just-named)
  Given scale.type is chromatic, so every key shows as in scale
  When a scale is chosen
  Then the notes outside it stop being lit
# pinned by: tests/ui/key-panel.test.ts

Scenario: The voicing control shows its effect before a key is played (REQ-the-key-is-drawn-not-just-named)
  Given a scale is chosen and chord.voicing is off
  When chord.voicing becomes a triad
  Then the tonic triad's pitch classes light as chord tones in both octaves
# pinned by: tests/ui/key-panel.test.ts

Scenario: The tab reads keyboard, controls, hint — in the DOM (REQ-the-key-is-drawn-not-just-named, layout)
  Given the KEY tab
  Then the keyboard comes first, then root, scale, extra note and chord memory, then the hint
  And that order is the DOM order, so wrapping to a narrow screen preserves it
# pinned by: tests/ui/key-panel.test.ts

Scenario: The map cannot be played (REQ-the-key-is-drawn-not-just-named, gesture inventory)
  Given the KEY tab is open
  When a key of the map is clicked
  Then no note sounds and nothing is selected
# pinned by: tests/ui/key-panel.test.ts

Scenario: The legend reads in the order of the dropdowns (REQ-the-key-is-drawn-not-just-named, regression)
  Given the KEY tab, whose dropdowns read Root, Scale, Extra note, Chord memory
  Then the legend under the map reads root, in scale, extra note, chord — in that order
# pinned by: tests/ui/key-panel.test.ts

Scenario: A legend entry nothing is wearing leaves the layout (REQ-the-key-is-drawn-not-just-named, regression)
  Given a scale is chosen and chord.voicing is off, so no key is a chord tone
  Then the chord legend entry is not rendered, not merely marked hidden
# pinned by: tests/ui/key-panel.test.ts

Scenario: The playable keyboard wears the key (REQ-the-key-is-shown-where-you-play)
  Given scale.root is C and scale.type is major
  Then every C key on the playable keyboard reads as the root
  And D E F G A B read as in scale in every drawn octave
  And C# D# F# G# A# carry no role at all
# pinned by: tests/ui/keyboard.test.ts, e2e/key.spec.ts

Scenario: Chromatic leaves the playable keyboard untouched (REQ-the-key-is-shown-where-you-play)
  Given a scale is chosen and the keyboard is showing it
  When scale.type returns to chromatic
  Then no key on the playable keyboard carries a role
# pinned by: tests/ui/keyboard.test.ts, e2e/key.spec.ts

Scenario: The root outranks its other roles on the keyboard too (REQ-the-key-is-shown-where-you-play)
  Given scale.root is C, scale.type is major and chord.voicing is a triad
  Then C reads as the root, E and G read as chord tones, and D F A B as in scale
# pinned by: tests/ui/keyboard.test.ts

Scenario: An OCT change does not repaint the roles (REQ-the-key-is-shown-where-you-play, cost)
  Given the keyboard is showing C major
  When keyboard.transpose moves by an octave
  Then every key carries exactly the role it carried before
# pinned by: tests/ui/keyboard.test.ts

Scenario: A pressed key is not in competition with its tint (REQ-the-key-is-shown-where-you-play)
  Given a key that reads as in scale
  When it is pressed, or the sequencer plays it
  Then the lit state is what shows, and the tint gets out of its way
# pinned by: tests/ui/keyboard.test.ts (the classes coexist); the suppression itself is
#   CSS, checked by eye per "Tests & verification" below

Scenario: An old song loads with no scale keys and is unchanged (REQ-the-key-is-two-inert-params, back-compat)
  Given a committed demo with no scale keys
  When it is loaded
  Then scale.type is 0 and the rendered notes are identical
# pinned by: tests/state/patterns-scale.test.ts

Scenario: A blue note plays as written (REQ-an-extra-note-is-admitted-not-a-degree)
  Given scale.root is E, scale.type is dorian and scale.extra is blue b5
  When a step holding Bb2 (46) is triggered
  Then Bb2 sounds, where with scale.extra none it would snap down to A2 (45)
# pinned by: tests/utils/music.test.ts, tests/audio/engine-scale.test.ts

Scenario: Quantizing stays idempotent with an extra note (REQ-an-extra-note-is-admitted-not-a-degree, stability)
  Given any root, any scale and any extra note
  When a note is quantized twice
  Then the second pass returns the first pass unchanged, and both are within 0..127
# pinned by: tests/utils/music.test.ts

Scenario: The extra note is not a degree (REQ-an-extra-note-is-admitted-not-a-degree)
  Given scale.root is E, scale.type is dorian, scale.extra is blue b5 and chord.voicing is triad
  When Bb is held on the keyboard in poly
  Then Bb alone sounds — no chord is stacked on a passing tone
  And the chord writer still lists seven degrees
# pinned by: tests/audio/engine-scale.test.ts, tests/utils/music.test.ts

Scenario: An extra note already in the scale changes nothing (REQ-an-extra-note-is-admitted-not-a-degree, edge)
  Given scale.type is dorian and scale.extra is b7
  Then the quantize table equals the one for scale.extra none
  And the KEY tab hint says the note is already in the scale
# pinned by: tests/utils/music.test.ts, tests/ui/key-panel.test.ts

Scenario: The extra note is inert without a scale (REQ-an-extra-note-is-admitted-not-a-degree)
  Given scale.type is chromatic
  Then the Extra note dropdown's real options are disabled and the hint names why
  And the quantize table is null whatever scale.extra holds
# pinned by: tests/utils/music.test.ts, tests/ui/key-panel.test.ts

Scenario: Bebop adds the mode's own passing tone (REQ-bebop-is-relative-to-the-mode)
  Given scale.root is C and scale.extra is bebop
  Then major admits G# (8), mixolydian admits B (11), dorian admits E (4)
  And pentatonic major admits nothing extra
# pinned by: tests/utils/music.test.ts

Scenario: SNAP keeps the extra note (REQ-an-extra-note-is-admitted-not-a-degree, REQ-snap-to-scale-is-the-destructive-opt-in)
  Given E dorian with blue b5 and a bank holding Bb2
  When SNAP is used
  Then Bb2 is still Bb2, because SNAP writes exactly what the live filter plays
# pinned by: tests/state/patterns-chord.test.ts

Scenario: The extra note wears its own role on both surfaces (REQ-the-extra-note-wears-its-own-role)
  Given scale.root is E, scale.type is dorian and scale.extra is blue b5
  Then A# reads as an extra note on the map and on the playable keyboard
  And the legend shows an extra note entry between in scale and chord
  And with scale.extra none that entry leaves the layout
# pinned by: tests/ui/key-roles.test.ts, tests/ui/key-panel.test.ts, tests/ui/keyboard.test.ts

Scenario: An old song loads with no extra note and is unchanged (REQ-an-extra-note-is-admitted-not-a-degree, back-compat)
  Given a song with no scale.extra key
  When it is loaded
  Then scale.extra is 0 (none)
# pinned by: tests/state/patterns-scale.test.ts
```

## Tests & verification

- Unit: `tests/utils/music.test.ts`, `tests/audio/transport/{sequencer,arpeggiator}.test.ts`,
  `tests/audio/engine-scale.test.ts`, `tests/state/patterns-scale.test.ts`,
  `tests/ui/{key-roles,key-panel,keyboard}.test.ts` — `npm test`. E2E: `e2e/key.spec.ts`.
- **By eye**: the wash is a look. On `npm run dev`, check that in-scale **black** keys
  stay legible and a pressed key still reads as pressed beside a tinted neighbour.
- **By ear** (ADR-010, [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)), A/B
  against `scale.type: 0` with other lanes muted: *First Light* in C major must stay
  in key through `A+5 A+7 A+3`; *1979* in E dorian turns its Bb walk-down into B–A–G,
  while E dorian + **blue b5** renders identical to chromatic.

## Open questions / future

- **Per-bar key modulation** needs a `SongFile` field and touches
  [arrangement](arrangement.md). Deferred until songs want a bridge in another key.
- Transposing bars by scale *degrees* is not planned: transpose-then-quantize already
  keeps them in key.
