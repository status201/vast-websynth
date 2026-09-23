# Voicing, unison, glide & drift (voice management)

```yaml
id: voicing
status: implemented
version: 7   # v7: heldNotes being keyed by NOTE is what makes two sequencer tracks on one
             #     pitch share a voice, and so one pan (sequencer.md REQ-two-tracks-on-one-pitch-share-a-pan)
             # v6: MONO obeys REQ-a-stolen-voice-leaves-the-held-list too — every mono note
             #     claimed the same voices, so releasing an older key cut the newer note
             # v5: a glide's cancel is ANCHORED, and the anchor is computed rather than
             #     read back — on Gecko a bare cancel made portamento start from the
             #     last assigned value, not the note being left (REQ-glide-controls-portamento)
             # v3: the passthrough stores what it played, so a re-pitched or
             #     chord-expanded key still releases correctly (REQ-passthrough-remembers-what-it-played)
             # v4: a stolen voice is evicted from its old note's held list, so
             #     releasing that key no longer cuts the new note (REQ-a-stolen-voice-leaves-the-held-list)
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

- **REQ-mode-switch-kills-all-voices** — `voicing.mode` toggles mono/poly;
  switching **kills all voices** so no notes hang across the mode change.

- **REQ-unison-stacks-detuned-copies** — Unison stacks `1..4` detuned copies per
  note (`unison.detune` cents).

- **REQ-glide-controls-portamento** — Glide time + mode control portamento;
  defaults reproduce the legacy no-glide behaviour.

  **(v5) A glide starts from the pitch the previous one had reached, on both
  engines.** `Osc.setFrequency` cancels before it schedules, and the cancel is
  load-bearing: `osc.frequency` is written from that one method, so a voice
  stolen from the sequencer still carries that note's pitch scheduled up to a
  lookahead ahead, and without the cancel it would fire mid-glide. But a bare
  cancel leaves **no event** at `when`, and `setTargetAtTime` then begins at
  "the param's value" — which Blink reads off the automation curve and Gecko
  reads as the last value explicitly assigned. On Firefox a glide therefore slid
  from the wrong origin (often the 440 Hz the node was constructed with) rather
  than from the note being left: a wrong-sounding portamento, on one engine
  only, invisible to the suite because the mock `AudioParam` has a static
  `value` and no event list.

  The cancel is therefore **anchored** (architecture.md "Never cancel automation
  without anchoring it"), and the anchor value is **computed, not read back**:
  `AudioParam.value` is exactly what is unreliable here. `setTargetAtTime` is a
  one-pole approach, so the value in flight is closed-form, and `Osc` keeps the
  `{from, to, at, tau}` of the glide it scheduled to evaluate it — the same
  move `SamplerMachine.cutHit` makes for its gain, and for the same reason.

  `tests/audio/no-unanchored-cancel.test.ts` now refuses `setTargetAtTime` as an
  anchor, which is how this hid: it was listed as one, so the source rule read
  the defect as compliant.

  *Verification status (v5):* the automation shape is pinned by
  `tests/audio/oscillator-glide.test.ts`, and a Blink A/B through `bench:audio`
  shows **no** audible change — the expected result, since the fix reproduces on
  both engines what Blink already did. The **Gecko** correction, which is the
  point of the change, has been reasoned but **not yet heard**: Playwright's
  Firefox was not installed on the machine that made the change. It is the first
  thing to listen for the next time this is played in Firefox
  ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md) — a green suite is
  not evidence that a glide sounds right).

- **REQ-analogue-drift-is-off-by-default** — Analogue drift adds subtle
  per-voice pitch wander (default 0 = off). The 110 ms drift interval runs
  **only while drift > 0** (v2): `setDrift` starts it on a 0→>0 transition and
  on >0→0 clears it after settling the detune source back to 0 — at the default
  there is no recurring main-thread timer (pinned by
  `tests/audio/polyphony.test.ts`).

- **REQ-bend-and-transpose-shift-pitch** — Pitch bend (`±` cents) and keyboard
  transpose (`±2` oct) shift pitch globally.

- **REQ-note-events-flow-through-the-bus** — Note events flow `bus.onNote →
  Engine.playNote / releaseNote` unless `passthroughSuppressed` (arp/sequencer
  own triggering then).

- **REQ-voice-lifecycle-gates-the-ladder** — (v2) The voice lifecycle drives the
  ladder filter's **idle gating**: voices boot inactive, `noteOn` activates the
  filter unconditionally, and release-completion / `kill` deactivate it — see
  [ladder-filter](ladder-filter.md) REQ-the-filter-idles-when-gated for the protocol and its safety
  asymmetry (pinned by `tests/audio/voice.test.ts`).

- **REQ-passthrough-remembers-what-it-played** (the passthrough remembers what
  it played, v3) — a raw key no longer maps 1:1 to a sounding note: it may be
  re-pitched by the key or expanded into a chord
  ([scale-quantization](scale-quantization.md), [chord-tools](chord-tools.md)).
  Since `Polyphony.releaseNote` looks up `heldNotes` **by the note number passed
  in**, a note-off that re-derived that mapping after the key or voicing changed
  would miss the lookup and **strand the voice forever**.

  So the passthrough keeps `Engine.heldIn: Map<number, number[]>` — raw key → the notes
  actually sounded. Note-on stores; note-off replays that array and deletes the entry.
  This is the same "resolve once, release through the stored note" rule the sequencer
  states at [sequencer](sequencer.md) REQ-every-note-is-shifted-by-the-slot-transpose, now applied to the one note source that
  previously had nowhere to store it. It is what lets a player change key, or switch on
  chord memory, **while holding a chord**. The map is bounded at 128 keys × ≤4 notes and
  is cleared alongside `killAll` — REQ-mode-switch-kills-all-voices's mode switch and panic both go through it, so
  no entry outlives the voices it names.

  *Accepted consequence:* two raw keys can quantize onto the same note, so releasing one
  stops it while the other is still held. That is inherent to quantization and is how
  hardware quantizers behave; it is not to be "fixed" by refcounting, which would make a
  legato retrigger stop working.

- **REQ-a-stolen-voice-leaves-the-held-list** (a stolen voice leaves its old
  note's held list, v4) — `heldNotes` maps a sounding note to the voices playing
  it, and `releaseNote` sends `noteOff` to whatever that entry names. When the
  pool is full, `pickVoice` **steals** the oldest playing voice — so that voice
  is now sounding a *new* note while the old note's entry still claims it.
  Releasing the old key then stopped the new note.

  The bug is reachable with nothing exotic: hold eight notes (`VOICE_COUNT = 8`), play a
  ninth, and let go of the first — the ninth stops, the first was never sounding. Unison
  reaches it sooner still, since every copy takes a voice, and a chord-expanded or
  sequenced passage reaches it without a ninth finger.

  So allocation is the point where the bookkeeping is repaired: taking a voice
  **evicts it from whatever note currently holds it**, and an entry left with no voices
  is dropped. The invariant is *a voice appears in at most one `heldNotes` entry* —
  which is what makes REQ-passthrough-remembers-what-it-played's "release through the stored note" rule sound, since that
  rule assumes the stored note still owns the voice it names.

  **(v7) The map is keyed by note number, and that has a musical consequence
  now.** Two sequencer tracks playing the *same* pitch land on one entry, so the
  second re-triggers the first's voices rather than taking its own — one voice,
  therefore one stereo position, and the later track's pan wins
  ([sequencer](sequencer.md) REQ-two-tracks-on-one-pitch-share-a-pan). Keying per
  track would spread them, at the cost of a voice per duplicated pitch out of
  eight and a rewrite of the invariant above; it is recorded there rather than
  paid for here.

  **(v6) Mono is not exempt.** The rule was applied on the poly branch only, and
  the mono branch violates it *by construction* rather than occasionally: in mono
  every note plays `voices[0..count-1]`, so each held key adds a `heldNotes`
  entry naming **the same voices**. Two keys down means two entries pointing at
  one voice, which is precisely what the invariant forbids — and the consequence
  is the one the poly comment describes: releasing the older key sends `noteOff`
  to the voice now sounding the newer note, so letting go of a key you are no
  longer hearing stops the note you are.

  It needs no new machinery. `evictVoice` already removes a voice from every
  entry that claims it and drops an entry left empty, so calling it on the mono
  path leaves exactly one entry — the newest note. `releaseNote` no-ops on a
  note it cannot find, so the older key correctly does nothing.

  *Not in scope:* this gives **last-note priority without fallback** — releasing
  the newest key while an older is still held leaves silence rather than
  returning to the older note. Fallback is a feature (and a choice: last / low /
  high priority), not this fix, which only stops a release cutting a note it
  does not own.

  This is deliberately **not** refcounting, and not a change to the stealing order:
  the oldest playing voice is still the one taken, and the note it was playing is simply
  no longer claimed. The old note goes silent when it is stolen — that is what voice
  stealing *is*, and it is what a player expects from a polyphonic instrument.

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
Scenario: Releasing an older key in mono does not cut the sounding note (v6, regression)
  Given voicing.mode is mono
  And the user holds C3, then holds E3 while still holding C3
  When the user releases C3
  Then E3 is still sounding
  And releasing E3 then stops it
# pinned by: tests/audio/polyphony.test.ts

Scenario: A glide leaves from the pitch in flight, not the last one assigned (v5, regression)
  Given mixer.glide is above zero and a note is gliding from C3 toward C4
  When a new note arrives before the glide has settled
  Then the frequency curve is pinned at the value the glide had reached
  And the new approach starts from that value on Blink and on Gecko alike
# pinned by: tests/audio/oscillator-glide.test.ts, recipes/verify-audio-by-ear.md

Scenario: Switching mono<->poly never leaves a hanging note
  Given a note is sounding
  When the user toggles voicing.mode
  Then all voices are killed and no note hangs
# pinned by: tests/state/params.test.ts (subscription); manual/e2e controls

Scenario: Changing the key while a note is held never hangs it (v3, REQ-passthrough-remembers-what-it-played, regression)
  Given a key is held and sounding through the passthrough
  When scale.root changes and the key is then released
  Then the note that was started is the note released, and no voice is left sounding
# pinned by: tests/audio/engine-scale.test.ts

Scenario: Releasing a key whose voice was stolen leaves the thief sounding (v4, REQ-a-stolen-voice-leaves-the-held-list, regression)
  Given every voice in the pool is playing a held note
  When one more note is played, stealing the oldest voice
  And the note that voice used to play is released
  Then the stolen voice keeps sounding its new note
  And no note-off reaches a voice playing something else
# pinned by: tests/audio/polyphony.test.ts (voice stealing keeps heldNotes
#            honest — releasing the robbed note does not stop the thief)

Scenario: A stolen note stops when it is stolen, not when its key is released (v4, REQ-a-stolen-voice-leaves-the-held-list)
  Given every voice in the pool is playing a held note
  When one more note is played
  Then the oldest note stops immediately, because its voice was taken
  And its entry no longer claims that voice
# pinned by: tests/audio/polyphony.test.ts (voice stealing keeps heldNotes
#            honest — still releases the note the stolen voice actually plays)

Scenario: A note keeps its own voices when the pool has room (v4, REQ-a-stolen-voice-leaves-the-held-list, edge)
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
- REQ-a-stolen-voice-leaves-the-held-list stealing/eviction: `tests/audio/polyphony.test.ts`.
- `npm test` / `npm run e2e`.
- **Verified by ear (REQ-a-stolen-voice-leaves-the-held-list)**, which is the part the tests cannot do
  ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)): a nine-note
  chord held across the eight voices and released oldest-first, A/B against the
  build before the fix, rendered with
  `npm run bench:audio -- --stagger 0.7` (see
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md) — a chord released all
  at once cannot expose a voice-allocation bug at all).

## Open questions / future

- New voice params must keep **no-op defaults** (see
  [add-a-parameter](../recipes/add-a-parameter.md)) to preserve old presets.
