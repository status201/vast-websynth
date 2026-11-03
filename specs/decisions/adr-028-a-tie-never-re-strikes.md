# ADR-028 — A tie never re-strikes; the old sound is a song setting, not a version gate

```yaml
id: adr-028-a-tie-never-re-strikes
status: accepted
date: 2026-11-03
deciders: core
related:
  - ../features/sequencer        # REQ-a-tie-continues-the-note-without-retriggering, REQ-re-strike-keeps-the-old-tie
  - ../features/voicing          # REQ-a-legato-note-takes-over-the-held-voices
  - ../features/song-mode        # the version ladder this decision does not climb
  - adr-006-no-op-param-defaults # the rule seq.tieMode's default departs from
```

## Context / Forces

A sequencer tie skipped the previous step's release, then sent the next step a full
note-on. The voice was kept, but both envelopes re-attacked from wherever they had
fallen. At sustain 1 the re-attack was inaudible. On a short decay it was a new
pluck, and the filter envelope re-swept on every tied step. So a tie only "worked"
when the decay was long enough to reach the next attack. The help text promised
smooth legato lines, so this was a bug against the intent.

But the bug had become a sound. In eight demos (Blue Monday, Take on Me, Sweet
Dreams, Around the World, Luftballons, Night Rider, Ageispolis 1 and 2) tied
same-pitch runs are the pulsing 16th-note re-plucks the song is built on. Night
Rider was chosen by ear: it also slides, but its re-plucked runs carried it. A plain fix would flatten each
run into one decaying note. Users' saved songs may lean on it the same way.

## Decision

A tie **continues** the held note (sequencer.md
REQ-a-tie-continues-the-note-without-retriggering). The old behaviour survives as an
explicit, song-level choice, `seq.tieMode` **Re-strike** (1), and the **fix is the
default** (0, Legato). The demos that need the re-pluck carry `"seq.tieMode": 1` in
their params. Every other song, saved or new, plays the fixed tie.

`seq.tieMode` is deliberately **not** a no-op default, which is ADR-006's rule for a
new param. ADR-006 protects a *feature* nobody asked for from changing old sounds.
This param exists to keep a *defect* available on request. If it defaulted to
Re-strike, the fix would ship switched off for everyone, including every new song.

## Alternatives considered

- **Version-gate the behaviour** (song v10 means Legato; v1–v9 load as Re-strike) —
  rejected. The song version says which fields a file may hold, not when it was
  written. The authoring dialect emits the *lowest* version that fits
  (song-authoring-dialect.md), so a song authored today would play the old tie unless
  the dialect learned yet another rung. It is also the first bump that would change
  behaviour rather than add a field, which is the "per-field versioned migration"
  ADR-006 already turned down.
- **Rewrite the demos' ties as gate 100%** — rejected. It is close but not equal: an
  untied step at gate 1 releases its voice, so in Poly the next note takes a *fresh*
  voice from silence over the old one's release tail, and Mono loses the legato
  glide. The demos would change in ways that need listening to repair.
- **Keep Re-strike as the default and make Legato opt-in** — rejected, because the
  bug would stay the out-of-the-box behaviour of the control called Tie.

## Consequences

- **Good:** Tie means what it says, and tie plus glide slides a line in Poly too. The
  demos that rely on the re-pluck stay bit-identical, and each can be moved to Legato
  by ear, one at a time, by flipping one control and re-saving.
- **Trade-off:** a song saved before this change that leaned on the re-pluck (a
  browser slot, an autosave, a share link) now plays Legato until its owner sets
  Re-strike. Nothing detects this. The CHANGELOG says so.
- **Trade-off:** one more param whose default is not inert. Presets are untouched,
  because `seq.*` is not a patch prefix.
