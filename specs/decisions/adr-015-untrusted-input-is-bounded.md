# ADR-015 — Every untrusted payload is bounded, and no subscriber can wedge the clock

```yaml
id: adr-015-untrusted-input-is-bounded
status: accepted
date: 2026-07-30
deciders: core
related:
  - ../features/untrusted-input
  - ../features/song-mode
  - ../features/song-share-link
  - adr-003-no-runtime-dependencies
  - adr-004-patternstore-separate-from-parambus
  - adr-007-songfile-additive-versioning
```

> ADR `status` is its own decision lifecycle and is **not** the feature-spec
> `draft | active | implemented`. A decision is `proposed`, then `accepted`; a
> later ADR can mark it `superseded by adr-XXX` or `deprecated`. Records are
> append-only — supersede, don't rewrite.

## Context / Forces

A song is a **shareable document**: it travels as a `#song=` URL, a `.json`
file, a pasted AI reply, or a `.websynth.zip`. Every one of those is authored by
whoever sends it, and `#song=` is applied at boot with no user interaction at
all. So the song format is an untrusted input format, not merely a save format.

Three prior decisions shaped the gap this ADR closes:

- **ADR-003** (zero runtime dependencies) means every codec — base64url,
  deflate, zip, the validator itself — is hand-rolled here. There is no library
  shipping a sane default limit on our behalf; every bound is ours to set or
  ours to omit.
- **ADR-004** says `PatternStore` deliberately has no `min/max/clamp` — grids
  are not scalars, so unlike `ParamBus` (which *does* clamp every registered
  param to `def.min/max`) nothing downstream of the pattern grids re-checks a
  range.
- **ADR-007**'s additive contract makes the validator deliberately *lenient*
  about optional and unknown fields, so legacy files keep loading.

Lenient-about-shape was read as lenient-about-magnitude. The result: a
`SeqStep.note` was validated as "finite" but not "0..127", `midiToHz(1e6)`
returned `Infinity`, `AudioParam.setValueAtTime` threw, and the throw escaped an
un-try/caught listener loop in `Clock.tick` — permanently wedging the transport
until a page reload. One step object in a link.

## Decision

**Two invariants, together.**

1. **Every value and every count that arrives from outside is bounded before it
   is used** — not merely type-checked. Ranges belong in the *validator*
   (`song-validate.ts`, `song-author.ts`, `preset-validate.ts`), because
   ADR-004 guarantees the stores below it will not re-check. Sizes belong in the
   *codec* (`compression.ts`, `zip.ts`), enforced **while** decoding so a bomb is
   never materialized. The limits live in one module, `src/state/limits.ts`, and
   are published by [untrusted-input](../features/untrusted-input.md).

2. **A `Clock` subscriber may not wedge the transport.** `Clock.tick` isolates
   each listener and advances `nextStepTime` / `_step` regardless of a throw.
   This is the structural half: bound #1 closes the note bug, bound #2 closes
   *every future variant of it*, including ones we have not thought of.

Defence in depth follows the same split: `Oscillator.setFrequency` rejects a
non-finite Hz, and `Clock.setBpm` rejects a non-finite BPM, because
`Math.max(20, Math.min(400, NaN))` is `NaN` — the app-wide clamp idiom does not
survive `NaN` and every entry point that reaches it is not knowable in advance.

## Alternatives considered

- **Clamp in the audio layer instead of the validator** — rejected: it
  contradicts ADR-004 (the stores are deliberately range-free) and it silently
  *changes* a song rather than refusing it, so the user is never told their file
  is wrong. Refusing at the boundary is the only place a readable error can name
  the field.
- **Add a schema library (Zod/Ajv) and get bounds for free** — rejected by
  ADR-003. The hand-rolled walk also produces the path-prefixed, human-readable
  errors (`drumBanks[1][3][7].ratchet`) the import UI depends on, which a
  generic library would not match without a custom error mapper anyway.
- **Only fix the note range** — rejected: it treats the symptom. Any future
  value that reaches an `AudioParam` from a payload reopens the same hole, and
  the wedge is what turns a rejected note into an unrecoverable app.
- **Wrap every `AudioParam` write in a try/catch** — rejected: it scatters the
  concern across the whole audio layer and hides real bugs. One guard at the
  clock, where the failure actually becomes unrecoverable, is both smaller and
  strictly more general.
- **Cap payloads by checking length after decoding** — rejected: the memory is
  already gone by then. A cap is only a cap if it is enforced inside the read
  loop.
- **Sandbox the import in a Worker** — rejected as disproportionate: it does not
  help the availability bugs (the wedge is in the audio thread's scheduler, not
  the parser) and it would add a message-passing boundary to the one code path
  that most needs to stay simple and synchronous.

## Consequences

- **Good:** a hostile song is refused with a field-level error instead of
  wedging, OOM-ing, or silently degrading. The validator and the authoring
  dialect now agree on ranges (`song-author.ts` already bounded notes 0..127;
  the canonical validator was the looser of the two, which is backwards).
- **Good:** the clock guard makes *every* transport module fail soft — a bug in
  one lane can no longer stop the others, which is worth having independently of
  security.
- **Trade-off:** a limit is a compatibility surface. A song legitimately larger
  than a cap is now refused, so the numbers in
  [untrusted-input](../features/untrusted-input.md) must stay generous enough
  that no real song hits them — they are sized against the *demo corpus plus
  headroom*, not against what feels tidy. Raising one later is additive and safe;
  lowering one is a breaking change and needs the ADR-007 treatment.
- **Trade-off:** `Clock.tick` swallowing a listener throw can hide a genuine
  programming error. It is logged rather than silent, but a crash is a louder
  signal than a log, and we are trading that loudness for the guarantee that the
  instrument keeps playing.
- **Trade-off:** bounds must now be restated in three places that cannot import
  each other — the validator, the published JSON Schema
  (`public/schema/websynth-song.schema.json`), and the authoring dialect. The
  demo-conformance tests are what keep them honest.
