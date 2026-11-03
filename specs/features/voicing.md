# Voicing, unison, glide & drift (voice management)

```yaml
id: voicing
status: implemented
version: 12
owner: core
related:
  - architecture
  - oscillators
  - scale-quantization
  - chord-tools
  - arpeggiator
  - runtime-performance  # REQ-an-idle-voice-is-unplugged answers its open question
  - sequencer            # the spread stage is the voice's second output edge
source:
  - src/audio/polyphony.ts     # voice pool, alloc, unison, glide, drift (ADR-008)
  - src/audio/engine.ts        # builds voices; thin playNote/releaseNote delegators
  - src/audio/voice.ts
  - src/audio/oscillator.ts    # Osc.setFrequency: the anchored glide
  - src/state/params.ts
  - src/ui/shell/header.ts           # the VOICE segmented
  - src/ui/panels/synth-panels.ts    # UNI (unison) + GLIDE
  - src/ui/shell/bottom.ts           # pitch-bend + transpose strips
```

How notes become voices: poly vs mono, unison stacking, glide, analogue drift,
pitch bend and keyboard transpose. These are the engine-level "how it plays"
controls, distinct from per-voice tone ([oscillators](oscillators.md)).

## Background / Why

Voice allocation is as much a synth's character as its oscillators: mono with glide
for bass and leads, poly for chords, unison for a fat stack, and per-voice
**drift** for an "alive" quality. `glide.mode` defaults to `always` (1), because
`always` at glide time 0 plays exactly like no glide, so presets are unchanged.

## Requirements

- **REQ-mode-switch-kills-all-voices** — `voicing.mode` toggles mono/poly, and
  switching **kills all voices** so no note hangs across the change.
- **REQ-a-live-note-starts-ahead-of-the-render** — A note with no time of its
  own, and its release, land at `liveStartTime(ctx)`, one render burst ahead
  ([live-trigger-timing](live-trigger-timing.md)
  REQ-a-live-trigger-starts-ahead-of-the-render).
- **REQ-unison-stacks-detuned-copies** — Unison stacks `1..4` detuned copies per
  note (`unison.detune` cents).
- **REQ-glide-controls-portamento** — Glide time + mode control portamento; the
  defaults are a no-op.
- **REQ-the-glide-switch-reads-on** — (v9) The MIXER's glide switch reads **OFF /
  ON / LEGATO**. Only the button text differs: `glide.mode`'s labels stay `['off',
  'always', 'legato']`, so files, the MCP tools and the authoring guide say
  `always`. The text is derived from `GLIDE_MODE_LABELS` with `always` swapped,
  so count and order cannot drift. `ALWAYS` overflowed the MIXER body
  (responsive-synth-panels.md REQ-selectors-never-outgrow-their-panel). OFF is not
  GLIDE 0 ms: demos switch glide off while keeping a time stored.

  **A glide starts from the pitch the previous one had reached, on both engines.**
  `Osc.setFrequency` must cancel, because a stolen voice may still carry the old
  note's pitch scheduled a lookahead ahead. The cancel is **anchored** (ADR-027),
  and the anchor is **computed, not read back**: `Osc` keeps the `{from, to, at,
  tau}` of the glide it scheduled and evaluates the one-pole in closed form (as
  `SamplerMachine.cutHit` does for gain). A bare cancel made Gecko glide from the
  constructed 440 Hz.
- **REQ-analogue-drift-is-off-by-default** — Drift adds subtle per-voice pitch
  wander (default 0). Its 110 ms interval runs **only while drift > 0**: `setDrift`
  starts it on 0→>0 and, on >0→0, settles the detune source to 0 and clears it.
- **REQ-bend-and-transpose-shift-pitch** — Pitch bend (`±` cents) and keyboard
  transpose (`±2` oct) shift pitch globally.
- **REQ-note-events-flow-through-the-bus** — Note events flow `bus.onNote →
  Engine.playNote / releaseNote` unless the arp's `passthroughSuppressed` is set
  (the arpeggiator then owns triggering; the sequencer never suppresses).
- **REQ-voice-lifecycle-gates-the-ladder** — (v2) Voices boot with the filter
  inactive, `noteOn` activates it unconditionally, and release-completion / `kill`
  deactivate it ([ladder-filter](ladder-filter.md) REQ-the-filter-idles-when-gated).
- **REQ-an-idle-voice-is-unplugged** — The same lifecycle decides whether a voice
  is **connected to the voice bus at all**. An idle voice's output edges (the dry
  edge, and the panned edge while the spread stage is engaged — [sequencer](sequencer.md)
  REQ-the-spread-stage-engages-off-centre) are **disconnected**, so the renderer,
  which pulls only what reaches the destination, skips the whole voice: its three
  oscillators, gains, sources and filter worklet (ADR-012's true bypass, applied to
  voices). Pool voices boot unplugged; `noteOn` plugs the voice in, synchronously
  and before its attack (which lands at `when >= liveStartTime`), whatever its
  state; release completion and `kill`'s fade window unplug it, at the same
  moments they deactivate the filter, when its VCA has already reached silence
  (15 time constants into the release; 30 ms after `kill`'s 3 ms cut). The spread
  stage keeps its own engaged state while a voice is unplugged and applies it when
  the voice is plugged back in, so engaging it never reconnects an idle voice.
  The saving is what `npm run bench:perf`'s idle and held-note scenarios print;
  with every voice sounding there is nothing to skip.
- **REQ-passthrough-remembers-what-it-played** — (v3) A raw key may be re-pitched
  by the key or expanded into a chord ([scale-quantization](scale-quantization.md),
  [chord-tools](chord-tools.md)). `Polyphony.releaseNote` looks up by note number,
  so a note-off that re-derived the mapping after a change would strand a voice.
  So `Engine.heldIn: Map<number, number[]>` maps raw key → notes actually sounded.
  Note-on stores; note-off replays and deletes. This is the sequencer's rule
  ([sequencer](sequencer.md) REQ-every-note-is-shifted-by-the-slot-transpose), and
  it lets a player change key or engage chord memory while holding a chord. The
  map is bounded (128 keys × ≤4 notes) and cleared with `killAll`.
  **A note the passthrough played is always released, arp or no arp**: the arp
  gate applies to note-on only. A note-off for a key the passthrough never played
  (pressed while the arp owned the stream) is ignored. *Accepted:* two keys can
  quantize onto one note, so releasing either stops it. That is how hardware
  quantizers behave; refcounting would break a legato retrigger.
- **REQ-a-stolen-voice-leaves-the-held-list** — (v4) `heldNotes` maps a sounding
  note to its voices. When the pool is full, `pickVoice` steals the oldest playing
  voice. So taking a voice **evicts it from whatever note holds it**, and an empty
  entry is dropped. The invariant: *a voice appears in at most one `heldNotes`
  entry*. Without it, releasing the robbed note stops the thief. **Mono is not
  exempt**: in mono every note plays `voices[0..count-1]`, so `evictVoice` runs
  there too, leaving one entry, the newest note. That is last-note priority
  without fallback: releasing the newest key while an older one is held leaves
  silence. Fallback is a feature (last / low / high priority), not this rule.
  Stealing order is unchanged, and this is not refcounting. The map is keyed by
  note number, so two sequencer tracks on one pitch share a voice and the later
  pan wins ([sequencer](sequencer.md) REQ-two-tracks-on-one-pitch-share-a-pan).

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
ui: src/ui/shell/header.ts (VOICE), src/ui/panels/synth-panels.ts (UNI, GLIDE), src/ui/shell/bottom.ts (pitch-bend + transpose)
```

## Scenarios (BDD)

```gherkin
Scenario: A pool voice boots unplugged (REQ-an-idle-voice-is-unplugged)
  Given a voice connected to the voice bus by connectTo
  Then neither of its output edges reaches the bus until a note arrives
# pinned by: tests/audio/voice.test.ts

Scenario: A note plugs the voice in before its attack (REQ-an-idle-voice-is-unplugged)
  Given an unplugged voice
  When noteOn fires
  Then its dry edge is connected to the bus within that call
  And a second noteOn on the plugged voice connects nothing twice
# pinned by: tests/audio/voice.test.ts

Scenario: Release completion and kill unplug the voice (REQ-an-idle-voice-is-unplugged)
  Given a sounding voice
  When its release completes, or kill's fade window passes with no new note
  Then its output edges are disconnected from the bus
  And a noteOn inside kill's window keeps it plugged
# pinned by: tests/audio/voice.test.ts

Scenario: The spread stage never plugs an idle voice back in (REQ-an-idle-voice-is-unplugged, edge)
  Given an unplugged voice and the spread stage engaging
  Then its panned edge stays disconnected
  When a note plugs the voice in
  Then both its dry and its panned edge reach the bus
  And unplugging it again takes both edges down
# pinned by: tests/audio/voice.test.ts

Scenario: An idle synth costs a fraction of what it did (REQ-an-idle-voice-is-unplugged, perf)
  Given the default patch with no note held
  When npm run bench:perf measures idle and 1 note
  Then the audio load falls well below the all-voices-rendering baseline
  And a note started on an unplugged voice still starts without a click
# pinned by: npm run bench:perf --compare (a before/after pair); onsets by ear and 3rd-difference scan, Blink and Gecko

Scenario: Releasing an older key in mono does not cut the sounding note (regression)
  Given voicing.mode is mono
  And the user holds C3, then holds E3 while still holding C3
  When the user releases C3
  Then E3 is still sounding
  And releasing E3 then stops it
# pinned by: tests/audio/polyphony.test.ts

Scenario: A glide leaves from the pitch in flight, not the last one assigned (regression)
  Given mixer.glide is above zero and a note is gliding from C3 toward C4
  When a new note arrives before the glide has settled
  Then the frequency curve is pinned at the value the glide had reached
  And the new approach starts from that value on Blink and on Gecko alike
# pinned by: tests/audio/oscillator-glide.test.ts, recipes/verify-audio-by-ear.md

Scenario: A live note is scheduled a render burst ahead (REQ-a-live-note-starts-ahead-of-the-render, regression)
  Given the context reports a baseLatency
  When a key plays a note with no time of its own, and releases it
  Then the attack is anchored at currentTime + baseLatency, not at currentTime
  And the release is placed with the same margin, after the attack
  And a note given its own time is scheduled exactly there
# pinned by: tests/audio/polyphony.test.ts

Scenario: Switching mono<->poly never leaves a hanging note
  Given a note is sounding
  When the user toggles voicing.mode
  Then all voices are killed and no note hangs
# pinned by: tests/state/params.test.ts (subscription); manual/e2e controls

Scenario: Changing the key while a note is held never hangs it (REQ-passthrough-remembers-what-it-played, regression)
  Given a key is held and sounding through the passthrough
  When scale.root changes and the key is then released
  Then the note that was started is the note released, and no voice is left sounding
# pinned by: tests/audio/engine-scale.test.ts

Scenario: Releasing a key whose voice was stolen leaves the thief sounding (REQ-a-stolen-voice-leaves-the-held-list, regression)
  Given every voice in the pool is playing a held note
  When one more note is played, stealing the oldest voice
  And the note that voice used to play is released
  Then the stolen voice keeps sounding its new note
  And no note-off reaches a voice playing something else
# pinned by: tests/audio/polyphony.test.ts (voice stealing keeps heldNotes
#            honest — releasing the robbed note does not stop the thief)

Scenario: A stolen note stops when it is stolen, not when its key is released (REQ-a-stolen-voice-leaves-the-held-list)
  Given every voice in the pool is playing a held note
  When one more note is played
  Then the oldest note stops immediately, because its voice was taken
  And its entry no longer claims that voice
# pinned by: tests/audio/polyphony.test.ts (voice stealing keeps heldNotes
#            honest — still releases the note the stolen voice actually plays)

Scenario: A note keeps its own voices when the pool has room (REQ-a-stolen-voice-leaves-the-held-list, edge)
  Given fewer notes are held than there are voices
  When another note is played
  Then an idle voice is taken and every held note still owns its own voices
# pinned by: tests/audio/polyphony.test.ts

Scenario: Glide defaults reproduce legacy behaviour (backward compat, edge)
  Given glide.mode is 'always' (1) and mixer.glide is 0
  Then notes retrigger with no audible portamento
# pinned by: tests/state/preset.test.ts (existing presets unchanged)

Scenario: A key held as the arp comes on still releases (REQ-passthrough-remembers-what-it-played, regression)
  Given a key held and sounding through the passthrough
  When the arpeggiator is switched on, and then the key is let go
  Then its note is released
   And a key pressed after the arp came on is neither played nor released by the passthrough
# pinned by: tests/audio/engine-scale.test.ts
```

## Tests & verification

- `tests/state/params.test.ts`, `tests/state/preset.test.ts`,
  `tests/audio/polyphony.test.ts`, `tests/audio/engine-scale.test.ts` (against the
  production `Engine.handleNote`), `tests/audio/oscillator-glide.test.ts`,
  `e2e/controls.spec.ts` — `npm test` / `npm run e2e`.
- **By ear** (ADR-010): voice stealing with a nine-note chord released
  oldest-first, `npm run bench:audio -- --stagger 0.7`
  ([verify-audio-by-ear](../recipes/verify-audio-by-ear.md); a chord released at
  once cannot expose an allocation bug). The anchored glide is pinned by the suite
  and was A/B'd on Blink; the **Gecko** correction is still owed a Firefox listen.
- **Audio-thread cost**: `npm run bench:perf` (Blink tracing) for
  REQ-an-idle-voice-is-unplugged — compare `--name` runs before and after.

## Open questions / future

- New voice params keep **no-op defaults** ([add-a-parameter](../recipes/add-a-parameter.md)).
- Mono note priority with fallback (last / low / high) is unbuilt.
