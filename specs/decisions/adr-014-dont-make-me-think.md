# ADR-014 — Interaction design follows "Don't Make Me Think"

```yaml
id: adr-014-dont-make-me-think
status: accepted
date: 2026-07-22
deciders: core
related:
  - ../architecture
  - ../features/step-grid-editing
  - ../recipes/design-an-interaction
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

The UI is hand-built DOM with no framework and no design system, and it grew
panel by panel. Each panel wired its own listeners, so gestures accreted locally
with nothing to check them against — there was no written rule a reviewer could
cite, which made "this control feels wrong" an opinion rather than a finding.

That produced a whole bug *class*, not a single bug. The clearest instance: on
every step grid a click was quietly given **two jobs** — move the selection
cursor *and* toggle the step. Selecting a lit step in order to edit its note or
velocity therefore switched the step off, so the note vanished under the
pointer; the user had to click a second time to put it back before they could
edit it. Nothing was broken in the code, and no test failed. The design was
simply never stated, so nothing could disagree with it.

Two forces pull against just fixing the instance. First, this is a *musical
instrument*: players build muscle memory, and a surprising gesture costs more
here than a surprising button in a form — you notice it mid-performance.
Second, we are competing with 40 years of established convention (hardware
sequencers, VST plug-ins, DAW piano rolls); users arrive with expectations
already formed, and inventing our own vocabulary spends their attention for no
gain.

## Decision

Interaction design in this app follows **Steve Krug's "Don't Make Me Think"**,
expressed as six laws. When they conflict, **in this order**:

1. **Self-evident beats explained beats documented.** A control that needs no
   caption wins over one with a good tooltip, which wins over one covered in the
   help modal. Reach for docs last, never first.
2. **One gesture, one outcome.** A single gesture on a single target does
   exactly one thing, and the same thing every time. If a gesture's result
   depends on invisible state, that is a defect — split the jobs across
   *different gestures*, not across *modes*.
3. **Destructive actions are obvious and reversible.** Anything that discards
   user work is either visibly labelled as such or trivially undoable —
   preferably both. A reachable undo (`PatternUndo`, the `Toast` Undo action)
   is worth more than a confirmation dialog, because a dialog interrupts every
   *correct* action to guard against the rare wrong one.
4. **Follow precedent before inventing.** Look up how hardware does it first
   (it is the most muscle-memorised), then how DAWs/VSTs do it. Invent only
   when neither has an answer, and say so in the spec.
5. **State is visible, not remembered.** If a mode exists it carries a lit
   affordance, and it ends when its context ends — the user must never have to
   recall what mode they are in. (`Step Input`'s visibility scoping,
   [sequencer](../features/sequencer.md) REQ-5, is the worked example.)
6. **Every control is touch-first.** Pointer Events, hit targets ≥ 44 px, and no
   affordance that exists only on hover — the app ships as an installed PWA on
   phones ([pwa-install](../features/pwa-install.md)).

Law 4 is why this repo prefers a vintage-gear answer where one exists: tap-to-
toggle plus **hold-to-edit** comes from Elektron and Ableton Push, and
**paint-drag** from the FL Studio / Ableton grid. Both arrive already learned.

The rule is applied, not just stated: [`step-grid-editing`](../features/step-grid-editing.md)
is its first enforcement, and the running checklist lives in
[`design-an-interaction`](../recipes/design-an-interaction.md).

## Alternatives considered

- **Adopt a component library / full design system** — rejected: pulls in a
  runtime dependency ([ADR-003](adr-003-no-runtime-dependencies.md)) and solves
  *visual* consistency, which was never the problem. The defects were in gesture
  semantics, which no component library decides for you.
- **Leave the rule unwritten and fix instances as they are reported** — rejected:
  that is the status quo that produced the select-vs-toggle collision across
  four panels simultaneously. Without a written rule the same collision is
  re-introduced by the next panel, and a reviewer has no ground to object from.
- **Put the rule in `CLAUDE.md` instead of `specs/`** — rejected: `CLAUDE.md` is
  the conventions reference (*what the code looks like*), while a prioritized
  principle with rejected alternatives is exactly the ADR shape — the precedent
  is [ADR-010](adr-010-musical-stable-cheap-dsp.md), which governs DSP the same
  way this governs interaction.
- **Solve it with modes (an explicit "edit mode" / "erase mode" toggle)** —
  rejected as the *default* answer: a mode makes the same gesture mean different
  things, which is law 2 inverted, and law 5 then obliges us to keep its state
  visible forever. A mode is the fallback when no distinct gesture is available,
  not the first move.
- **Require a confirmation dialog for anything destructive** — rejected: it taxes
  every correct action to catch the rare wrong one, and users learn to dismiss
  dialogs unread. Undo is the better guarantee, and we already have it per
  machine ([pattern-undo](../features/pattern-undo.md)).

## Consequences

- **Good:** gesture collisions become reviewable findings instead of taste
  arguments — "law 2" is a citable objection. Leaning on hardware/DAW precedent
  means users arrive already trained, and it gives the product the vintage-gear
  character it is going for. Laws 3 and 5 have existing machinery behind them
  (`PatternUndo`, `Toast`, the Step Input visibility scoping), so following them
  is mostly wiring, not new infrastructure.
- **Trade-off:** every new interactive control now owes a **gesture inventory**
  in its spec, which is real work up front for small controls. Law 4 means we
  sometimes ship the *conventional* interaction over one we think is better —
  deliberately, and the spec must say which precedent it followed. Law 6 rules
  out hover-only affordances that would be cheap on desktop, so some information
  moves into always-visible chrome. And because the laws are ordered, a control
  that is self-evident but unconventional beats one that is conventional but
  opaque — expect that tie-break to be argued case by case.
