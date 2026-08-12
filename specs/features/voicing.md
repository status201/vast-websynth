# Voicing, unison, glide & drift (voice management)

```yaml
id: voicing
status: implemented
version: 4   # v3: the passthrough stores what it played, so a re-pitched or
             #     chord-expanded key still releases correctly (REQ-8)
             # v4: a stolen voice is evicted from its old note's held list, so
             #     releasing that key no longer cuts the new note (REQ-9)
owner: core
related:
  - architecture
  - oscillators
  - scale-quantization
  - chord-tools
source:
  - src/audio/polyphony.ts     # voice pool, alloc, unison, glide, drift (ADR-008)
  - src/audio/engine.ts        # builds voices; thin playNote/releaseNote delegators
  - src/audio/voice.ts
  - src/state/params.ts
  - src/ui/app.ts
```

How notes become voices: poly vs mono, unison stacking, glide between notes,
analogue drift, pitch bend, and keyboard transpose. These are the engine-level
"how it plays" controls, distinct from per-voice tone ([oscillators](oscillators.md)).

## Background / Why

A real analogue synth's character is as much about *voice allocation* as about the
oscillators: mono with glide for basslines and leads, poly for chords, unison for
a fat detuned stack, and subtle per-voice pitch **drift** for an un-digital,
"alive" quality. `glide.mode` defaults to `always` (1) because `always` with glide
time 0 reproduces the pre-song-mode behaviour, keeping existing presets unchanged.

## Requirements

- **REQ-1** — `voicing.mode` toggles mono/poly; switching **kills all voices** so
  no notes hang across the mode change.
- **REQ-2** — Unison stacks `1..4` detuned copies per note (`unison.detune` cents).
- **REQ-3** — Glide time + mode control portamento; defaults reproduce the legacy
  no-glide behaviour.
- **REQ-4** — Analogue drift adds subtle per-voice pitch wander (default 0 = off).
  The 110 ms drift interval runs **only while drift > 0** (v2): `setDrift`
  starts it on a 0→>0 transition and on >0→0 clears it after settling the
  detune source back to 0 — at the default there is no recurring main-thread
  timer (pinned by `tests/audio/polyphony.test.ts`).
- **REQ-5** — Pitch bend (`±` cents) and keyboard transpose (`±2` oct) shift pitch
  globally.
- **REQ-6** — Note events flow `bus.onNote → Engine.playNote / releaseNote` unless
  `passthroughSuppressed` (arp/sequencer own triggering then).

- **REQ-8 (the passthrough remembers what it played, v3)** — a raw key no longer maps
  1:1 to a sounding note: it may be re-pitched by the key or expanded into a chord
  ([scale-quantization](scale-quantization.md), [chord-tools](chord-tools.md)). Since
  `Polyphony.releaseNote` looks up `heldNotes` **by the note number passed in**, a
  note-off that re-derived that mapping after the key or voicing changed would miss the
  lookup and **strand the voice forever**.

  So the passthrough keeps `Engine.heldIn: Map<number, number[]>` — raw key → the notes
  actually sounded. Note-on stores; note-off replays that array and deletes the entry.
  This is the same "resolve once, release through the stored note" rule the sequencer
  states at [sequencer](sequencer.md) REQ-16, now applied to the one note source that
  previously had nowhere to store it. It is what lets a player change key, or switch on
  chord memory, **while holding a chord**. The map is bounded at 128 keys × ≤4 notes and
  is cleared alongside `killAll` — REQ-1's mode switch and panic both go through it, so
  no entry outlives the voices it names.

  *Accepted consequence:* two raw keys can quantize onto the same note, so releasing one
  stops it while the other is still held. That is inherent to quantization and is how
  hardware quantizers behave; it is not to be "fixed" by refcounting, which would make a
  legato retrigger stop working.
- **REQ-9 (a stolen voice leaves its old note's held list, v4)** — `heldNotes` maps a
  sounding note to the voices playing it, and `releaseNote` sends `noteOff` to whatever
  that entry names. When the pool is full, `pickVoice` **steals** the oldest playing
  voice — so that voice is now sounding a *new* note while the old note's entry still
  claims it. Releasing the old key then stopped the new note.

  The bug is reachable with nothing exotic: hold eight notes (`VOICE_COUNT = 8`), play a
  ninth, and let go of the first — the ninth stops, the first was never sounding. Unison
  reaches it sooner still, since every copy takes a voice, and a chord-expanded or
  sequenced passage reaches it without a ninth finger.

  So allocation is the point where the bookkeeping is repaired: taking a voice
  **evicts it from whatever note currently holds it**, and an entry left with no voices
  is dropped. The invariant is *a voice appears in at most one `heldNotes` entry* —
  which is what makes REQ-8's "release through the stored note" rule sound, since that
  rule assumes the stored note still owns the voice it names.

  This is deliberately **not** refcounting, and not a change to the stealing order:
  the oldest playing voice is still the one taken, and the note it was playing is simply
  no longer claimed. The old note goes silent when it is stolen — that is what voice
  stealing *is*, and it is what a player expects from a polyphonic instrument.
- **REQ-7** — (v2) The voice lifecycle drives the ladder filter's **idle gating**:
  voices boot inactive, `noteOn` activates the filter unconditionally, and
  release-completion / `kill` deactivate it — see
  [ladder-filter](ladder-filter.md) REQ-10 for the protocol and its safety
  asymmetry (pinned by `tests/audio/voice.test.ts`).

## Technical design

### Data shapes (registry)

```yaml
voicing.mode:      { discrete, labels: VOICING_LABELS, range: 0..1, default: 1 }
unison.voices:     { discrete, labels: UNISON_LABELS, range: 1..4, default: 1 }   # no-op default
unison.detune:     { range: 0..50, default: 12, unit: cents }
mixer.glide:       { range: 0..1, default: 0, format: ms }
glide.mode:        { discrete, labels: GLIDE_MODE_LABELS, range: 0..2, default: 1 }  # 'always'
analog.drift:      { range: 0..1, default: 0 }                                       # no-op default
master.pitchBend:  { range: -1..1, default: 0, unit: semitones }
keyboard.transpose:{ discrete, range: -2..2, default: 0 }
```

### Layer touchpoints

```yaml
engine (subscribeParams) -> Polyphony setters (poly/unison/glide/drift live there):
  voicing.mode  -> polyphony.setPoly(v >= 0.5)        # kills all voices on change
  unison.voices -> polyphony.setUnisonCount(x)        # max(1, round(x))
  unison.detune -> polyphony.setUnisonDetune(x)
  mixer.glide   -> all((v, x) => v.setGlide(x))        # per-voice, stays in Engine
  glide.mode    -> polyphony.setGlideMode(x)
  analog.drift  -> polyphony.setDrift(x)               # drift source owned by Polyphony
  master.pitchBend -> rampTo(this.pitchBend.offset, x * PITCH_BEND_RANGE_CENTS, FAST)
note flow: bus.onNote -> Engine.playNote/ releaseNote -> Polyphony (unless passthroughSuppressed)
ui: src/ui/app.ts (VOICE / UNISON / GLIDE controls; pitch-bend + transpose)
```

## Scenarios (BDD)

```gherkin
Scenario: Switching mono<->poly never leaves a hanging note
  Given a note is sounding
  When the user toggles voicing.mode
  Then all voices are killed and no note hangs
# pinned by: tests/state/params.test.ts (subscription); manual/e2e controls

Scenario: Changing the key while a note is held never hangs it (v3, REQ-8, regression)
  Given a key is held and sounding through the passthrough
  When scale.root changes and the key is then released
  Then the note that was started is the note released, and no voice is left sounding
# pinned by: tests/audio/engine-scale.test.ts

Scenario: Releasing a key whose voice was stolen leaves the thief sounding (v4, REQ-9, regression)
  Given every voice in the pool is playing a held note
  When one more note is played, stealing the oldest voice
  And the note that voice used to play is released
  Then the stolen voice keeps sounding its new note
  And no note-off reaches a voice playing something else

Scenario: A stolen note stops when it is stolen, not when its key is released (v4, REQ-9)
  Given every voice in the pool is playing a held note
  When one more note is played
  Then the oldest note stops immediately, because its voice was taken
  And its entry no longer claims that voice

Scenario: A note keeps its own voices when the pool has room (v4, REQ-9, edge)
  Given fewer notes are held than there are voices
  When another note is played
  Then an idle voice is taken and every held note still owns its own voices
# pinned by: tests/audio/polyphony.test.ts

Scenario: Glide defaults reproduce legacy behaviour (backward compat, edge)
  Given glide.mode is 'always' (1) and mixer.glide is 0
  Then notes retrigger with no audible portamento, exactly as before song mode
# pinned by: tests/state/preset.test.ts (existing presets unchanged)
```

## Tests & verification

- `tests/state/params.test.ts`, `tests/state/preset.test.ts`, `e2e/controls.spec.ts`.
- REQ-9 stealing/eviction: `tests/audio/polyphony.test.ts`.
- `npm test` / `npm run e2e`.
- **REQ-9 was verified by ear**, which is the part the tests cannot do
  ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)): a nine-note
  chord held across the eight voices and released oldest-first, A/B against the
  build before the fix, rendered with
  `npm run bench:audio -- --stagger 0.7` (see
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md) — a chord released all
  at once cannot expose a voice-allocation bug at all).

## Open questions / future

- New voice params must keep **no-op defaults** (see
  [add-a-parameter](../recipes/add-a-parameter.md)) to preserve old presets.
