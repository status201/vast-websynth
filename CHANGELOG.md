# Changelog

All notable changes to VAST G1-J5 are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

<!--
  Maintainers: jot user-facing changes under "[Unreleased]" as you work, grouped
  into Added / Changed / Deprecated / Removed / Fixed / Security. At release time,
  `npm run release -- <version>` promotes this section to a dated version heading,
  builds the app, zips dist/ into a release artifact (dist-v<version>.zip), and
  prints the git + `gh release create` steps to publish. Keep entries short and
  recognisable.
-->

## [Unreleased]

### Added

- **Transport sync (master/slave)** — sync the transport of two VAST
  instances (or hardware gear): a **Sync** section in the Song tab sets the
  instance to **Master** (broadcasts Start/Stop + 24 PPQN clock — any local
  start, including the arpeggiator, is mirrored) or **Slave** (follows
  Start/Stop and locks onto the incoming tempo, riding out short dropouts by
  free-running at the last tempo). The status line shows the connection and,
  while slaved, the followed BPM; the BPM knob dims because the tempo is
  external. A slave that joins mid-song jumps to the right bar (Song Position)
  instead of restarting from the top. The setting is per-device (never saved
  into presets/songs).
  - **Over MIDI** — works over USB (e.g. an Android tablet in USB-MIDI mode
    plugged into a laptop) or any virtual/hardware MIDI cable.
  - **Over WiFi** — pair two devices on the same network with **no cable and
    no server**: press **WiFi link…**, then **Create** on one device and
    **Join** on the other, swapping the code by scanning a **QR** or pasting
    it. (Same network with client isolation off; cross-device needs the
    secure HTTPS site, two tabs on one computer work on localhost.)

- **Rest bars in the arrangement** — each Song-tab chain lane (seq / drum /
  sampler) gains a fifth build option, a **rest**: an always-empty bar you can
  drop into the chain without spending one of the four banks (A/B/C/D). It shows
  as a rest glyph instead of a letter. While a rest bar plays, its machine tab
  dims the step grid under a large rest symbol so the empty bar is obvious. Rests
  save with the song; older songs are unaffected.

### Fixed

- **WiFi sync QR is now scannable** — the pairing QR was rendered too small and
  downscaled, so a full link code was unreadable by any camera. It is now drawn
  crisp and upscaled (never shrunk), large enough to scan across devices. The
  pair dialog also warns when the app isn't on a secure (HTTPS) origin and, if a
  link fails to connect, explains what to check (same Wi-Fi, router client/AP
  isolation off) instead of sitting silently.
- **WiFi sync: scan the answer QR on any device** — QR scanning previously
  needed the platform QR reader, which Windows desktop browsers and iOS Safari
  don't have, so the return code had to be moved by hand. Scanning now works on
  any device with a camera (falls back to a built-in decoder), making the QR
  handshake symmetric in both directions.

## [1.9.0] - 2026-07-07

### Added

- **LIVE FX window** — the live DJ controls (DJ Filter, Fill, Stutter, Drop, Tape
  Stop) plus the XY Pad launcher now live in a movable, **non-modal** "LIVE FX"
  window you can pop open and keep on screen **while working on any other tab**, so
  performing the effects no longer means sitting on the Song tab. It opens from the
  **LIVE FX** button, which now also serves as the Song tab's Live FX section title
  (with a small "new window" glyph) to save space.

- **Minimise floating windows** — every floating window (the XY Pad and the new
  LIVE FX window) gained a **minimise** button on the left of its title bar that
  collapses it to just the toolbar; click again to restore. Handy for parking a
  window out of the way without closing it.

- **XY Pad** — an assignable, Kaoss-pad-style performance controller, opened from a
  button in the Song tab's **Live FX** row. Its two axes each drive **any**
  parameter (defaults X = filter cutoff, Y = filter resonance) through the correct
  taper; **drag** the square — or **two-finger scroll** it on a trackpad — to sweep
  both at once, and on release both **spring back** to where they were, so it
  colours a moment without editing the patch. It floats in a movable, **non-modal**
  window, so you can keep playing the keyboard and turning knobs while you sweep it.
  The axis assignment saves with the song (older song files load with the default
  axes).

- **10 new factory presets** — the factory bank grows from 6 to 16 sounds:
  basses **upright** (acoustic), **pbass** (electric), **reese** (DnB) and
  **acid** (303 squelch with legato slide), keys **piano**, **rhodes**, **b3**
  (tonewheel organ) and **bells**, plus **solina** (string machine) and
  **brass** (poly synth brass). Every factory preset (old and new) now sets the
  full sound — sub, unison, drift, glide mode and all FX switches included — so
  switching presets never carries a setting over from the previous patch.

- **BPM "sweet spots" help badges** — the Delay Time knobs (synth, drum, sampler)
  and the LFO / wah / phaser rate knobs gained help-mode (i) badges that list the
  musical note divisions — straight, dotted and triplet — with their value at the
  **current tempo** (milliseconds for delays, Hz for rates), filtered to each
  knob's range. **Click a value to snap the knob to it**, so getting a delay or
  LFO perfectly in time no longer means doing the math by hand. Change the BPM and
  reopen the badge to see the values recomputed.

- **Relationship help badges** — the filter cutoff, resonance and envelope-amount
  knobs, the unison detune knob, and the drum/master compressor thresholds gained
  (i) badges that explain their live derived numbers (cutoff in Hz, the
  self-oscillation pitch, the envelope sweep's top, the unison spread in cents,
  and so on) so mutually-dependent controls make sense at a glance.

  **Dialogue Windows** — new type of modal for themed alerts, prompts and confirms.
  Applied to all existing dialogs. Added a confirm dialog to clearing arrangement
  lanes.

### Changed

- **Lower steady-state CPU (less crackle on weak devices)** — two engine
  optimisations, both sonically identical:
  - the ladder filter now works out its cutoff coefficient **once per audio block**
    while the cutoff is held still (the common case), instead of recomputing an
    expensive calculation on every single sample — the biggest per-note saving,
    and it applies to every voice;
  - the oscilloscope's analysers now scale with the performance tier (FFT
    **512 / 1024 / 2048** for Weak / Medium / Strong) and this applies **live**
    when you switch tiers (no reload), trimming always-on cost on weaker devices
    with no visible change to the scope. Switching between Medium and Strong still
    needs no reload.

- **Double-tap reset returns to the loaded sound** — double-tapping a knob (or the
  drum panel's per-track Reset) now snaps it back to the value the current preset
  or song set for that control, instead of the factory default. Load *acid* and
  double-tap Cutoff and you get *acid*'s cutoff, not a generic one. Controls no
  preset/song has touched still reset to their default, and saving a preset/song
  makes the saved values the new reset target.

### Fixed

- **Editing drums no longer slows the app down (crackle that got worse over time)**
  — clicking drum steps and track labels rebuilt the per-track tuning knobs on
  every click without cleaning up the old ones, so a long session gradually piled
  up dead event handlers that starved the audio thread and caused crackle that
  only worsened and never recovered. Knobs and faders now remove their drag
  handlers when they're done, and the drum tuning strip only rebuilds when you
  actually switch to a different track.

- **Step Input inserted two steps per computer key** — with the Sequencer's Step
  Input armed, pressing a single key on the computer keyboard (e.g. `x` for D)
  filled two steps instead of one. The key was firing the note twice; it now fires
  once, matching mouse input.

## [1.8.0] - 2026-07-03

### Added

- **Reverb on the Drum Machine** — the drum bus gained a fourth effect group
  (Size / Damp / Mix), sitting last in the chain after the Delay so echoes tail
  off into the room. Off by default, so existing songs and presets sound
  unchanged.

- **Follow toggle on the bank bars** — the Sequencer, Drum Machine and Sampler
  each gained a **Follow** button before the A/B/C/D banks. While on (the
  default), the panel switches banks along with the song's arrangement, so you
  can watch a song's structure play out with the step highlight always visible.
  Clicking a bank other than the one playing turns Follow off — handy when you
  want to edit one bank while another plays.

- **Song panel button help** — every file-management button in the Song panel
  (Load, Save, Import, Export, New, Export Song, Record) now has its own (i)
  help badge explaining exactly what it does. **Save**, **Export**, and
  **Export Song** (audio) are easy to mix up — each now gets a precise,
  disambiguating explanation.

### Changed

- **Much lower CPU use on phones (mobile crackle fix)** — a series of engine
  optimisations aimed at mid-range Android devices:
  - the transport's timing pulse moved off the main thread into a Worker, so
    the groove no longer stumbles when the browser is busy and keeps playing
    when the tab is backgrounded;
  - a synth voice's filter now sleeps while the voice is silent (previously
    all 8 filters computed at full cost forever), and it processes mono
    instead of a duplicated stereo pair — identical sound at half the cost;
  - switched-off effects are now truly disconnected: bypassed reverbs,
    distortions, phasers, delays and compressors no longer burn audio CPU
    (they used to run silently behind the crossfade);
  - drum-track drive only engages its oversampling while actually driven;
  - the analogue drift ("wobble") timer only runs while Drift is turned up —
    previously it ticked every 110 ms from boot even at the default of off;
  - the spectrum scope's background gradient is now cached instead of
    reallocated every animation frame.
  Nothing changes sonically — presets and songs sound the same.

- **Weak performance tier cuts effect cost too** — on Weak, the engine now
  also widens the transport look-ahead (steadier on throttled devices), caps
  reverb tails at 1.5 s, and skips distortion oversampling. **About → Debug**'s
  audio-profile row shows the extra fields (lookahead, IR cap, oversample).

- **Drum Machine effect groups now follow the signal flow** — the header reads
  Comp / Phaser / Delay / Reverb, matching the order the audio actually passes
  through them (the compressor was always first in the chain).

- **Effect knobs hide while an effect is off** — the inline effect groups in
  the Drum Machine (Comp / Phaser / Delay / Reverb), Sampler (Dist / Phaser /
  Delay / Reverb) and the Song tab's master Comp now show only their name and on/off
  switch while bypassed. Flipping an effect on reveals its knobs in place (and
  the Comp's gain-reduction meter); loading a preset or song that uses an
  effect expands it automatically. Clears a lot of header clutter.

- **Performance mode is now three tiers** — Weak / Medium / Strong (plus Auto),
  replacing the On/Off toggle. Each tier scales latency, polyphony, and the
  visualiser's frame rate (15 / 30 / 60 fps); the header **Perf** button is
  colour-coded by tier and **About → Debug** shows the detected tier and device
  signals (cores, memory). Auto no longer forces capable tablets into the
  high-latency profile, and the canvas drop-shadow is dropped on all tiers.

### Fixed

- **iOS: audio now plays with the ring/silent switch set to silent** —
  iPhones and iPads route Web Audio through the "ambient" category, which
  honors the physical mute switch and previously left the synth silent
  whenever it was flipped. Sound now upgrades the page's audio session to
  "playback" (the same trick apps like YouTube and Spotify use) by routing a
  silent loop *through* the `AudioContext` itself, so audio reaches the
  speaker regardless of the switch. iOS-only; nothing changes on other
  platforms.
- **iOS: audio recovers automatically after phone calls, Siri, and
  backgrounding** — iOS can drop the audio session into a non-standard
  "interrupted" state that the previous resume logic didn't recognise,
  leaving the synth silent until a page reload. Resuming now also handles
  that state, and **About → Debug** gains iOS unlock/session diagnostics for
  tracking down issues in the field.
- **MIDI's permission prompt no longer appears before you've tapped to
  start** — Web MIDI access is now requested from the start-gesture handler
  instead of at page load, so Chrome's MIDI permission prompt no longer pops
  up behind the "Tap to start" modal for visitors who never plug in a
  controller.

## [1.7.0] - 2026-06-28

### Added

- **Stereo scope** — a Mono/Stereo toggle on the Wave/Spectrum visualiser. Stereo
  splits the display into independent **L** and **R** traces (side-by-side on wide
  panels, stacked on small screens), so you can see stereo effects move the channels
  apart.
- **Spectrum peak-hold** — in the Spectrum view a dotted **max-dB** line is pushed
  up by the bars to mark the loudest level reached (0 dB at the top = clipping), with
  the value shown in dB — handy when riding the compressors. It holds the peak
  briefly, then falls back very slowly; **click the graph** to reset it.
- **Mobile header menu** — on phones (≤720px) the preset controls
  (Preset / Save / Perf / About / Help) collapse behind a ☰ menu button in the
  top-right so the header stays compact; tap to reveal them. This fixes the
  header overflowing and clipping those buttons on narrow screens. Wider screens
  are unchanged.
- **Documented, validated song format** — the `.websynth.json` song format now
  has a published [JSON Schema](public/schema/websynth-song.schema.json) (served
  with the app at `/schema/websynth-song.schema.json`) for external tools and AI
  agents. Importing a song is now **validated**: a malformed file is rejected
  with specific field-level messages (which step/field is wrong) instead of a
  single generic error, and legacy/older songs still load unchanged.

### Changed

- **Smaller song & preset files** — exported `.websynth.json` songs and saved
  presets are now far more compact: numbers are rounded to a musically-inaudible
  precision and default step-cells are omitted (a dropped grid cell is just
  `{"on":false}`). A downloaded song is ~8× smaller; older files still load and
  sound identical.
- **AI song prompt revamp** — the Song panel's **✨ AI Prompt** now has a
  *"Describe your song"* box (type your idea — style, length, mood — and it's
  folded into the prompt), a much shorter prompt (a small illustrative example
  instead of an embedded full song), and an **absolute, host-resolved** schema
  link so external AI tools can actually fetch it.

### Fixed

- **Typing no longer plays the synth** — entering text in a field (such as the new
  AI Prompt brief box) no longer triggers notes, transport, or other
  computer-keyboard shortcuts.
- **AI Prompt modal fits small screens** — the dialog is now height-capped and
  scrolls internally, so its title and the **Close** button stay reachable on a
  phone (previously it could overflow the screen and be impossible to close); its
  instruction line is also now readable sentence-case.

## [1.6.0] - 2026-06-26

### Added

- **Performance mode** — a device-scoped audio-quality setting (Auto / On /
  Off) in the header **Perf** modal. On weak hardware it trades a little
  latency, polyphony, and visual fidelity to keep audio stable; **Auto**
  detects weak devices automatically. Buffer and voice count are fixed when
  audio starts, so a change applies on **reload** (the modal shows the
  effective state and a reload hint). The setting never enters presets or songs.

### Changed

- **Ladder filter** now has per-stage saturation and a smoother resonance taper
  for a warmer, more musical filter sweep (with a matching cutoff-knob taper).

### Fixed

- Synthesised drum hits no longer leak audio nodes: each one-shot hit's
  oscillators, filters, and gains are disconnected when it ends, fixing the
  crackle/distortion that built up over a long-running song (worst on mobile).
- Performance modal: the reload hint and button no longer appear on a fresh
  open when no change is pending.

## [1.5.1] - 2026-06-23

## [1.5.0] - 2026-06-23

### Added

- Per-drum sound design in the Drum Machine: every track now has **Tune**,
  **Decay**, **Tone**, **Drive**, **Pan** and volume controls in a selected-drum
  tuning strip, with a per-track **Reset**. Click a drum's name to audition and
  edit its sound. Tune now shapes **every** voice (kick, snare, hats, toms,
  clap), not just the pitched ones.
- **Drum kits**: a KIT picker with factory kits (808, 909, LoFi, Acoustic,
  Techno) plus a **Randomize** ("surprise me") button for instant new kits. Kit
  and per-drum tweaks save with presets and songs; existing presets/songs are
  unaffected.

## [1.4.0] - 2026-06-23

### Added

- Per-lane DJ mixer in the Song tab: **Mute**, **Solo**, and **Volume** for the
  Sequencer, Drums, and Sampler, so you can ride levels and drop lanes without
  switching machines. Solo isolates a lane (dimming the others); muting the
  Sequencer stops its notes while live keyboard play keeps going.

## [1.3.1] - 2026-06-22

### Added

- Custom bus compressors as AudioWorklets with gain-reduction meters: a
  1176-style FET compressor on the drum bus and an SSL-G-style VCA "glue"
  compressor on the master bus.
- Per-step settings (velocity, gate, probability, ratchet, tie) on the Drum
  Machine and Sampler, sharing the sequencer's step-hits math and edit UI; a
  choke model lets a shortened gate cut one-shots early and tie lets the last
  ratchet hit ring on. Legacy songs load unchanged.
- Per-step settings are now visualised directly on the step buttons of all three
  machines (gate width, velocity brightness, probability border, ratchet ticks,
  tie bridge).
- New demo songs (e.g. "Fat" v2 and "Run Away").

### Changed

- Demo songs are code-split into their own bundle chunk so app code and the
  rarely-changing demo data are cached separately.

### Removed

- The built-in "Knight Rider" demo song.

## [1.3.0] - 2026-06-22

- Baseline release. Covers the synth engine, FX chain, transport (clock,
  arpeggiator, 16-step sequencer, 8-track drum machine, 8-slot sampler),
  pattern banks, song chains, live DJ FX, song save/load, presets, and the
  in-app sample recorder/editor. See the git history prior to this changelog
  for the detailed evolution.

[Unreleased]: https://github.com/status201/vast-websynth/compare/v1.9.0...HEAD
[1.9.0]: https://github.com/status201/vast-websynth/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/status201/vast-websynth/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/status201/vast-websynth/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/status201/vast-websynth/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/status201/vast-websynth/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/status201/vast-websynth/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/status201/vast-websynth/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/status201/vast-websynth/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/status201/vast-websynth/releases/tag/v1.3.0
