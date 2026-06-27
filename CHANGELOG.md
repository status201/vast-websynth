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

[Unreleased]: https://github.com/status201/vast-websynth/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/status201/vast-websynth/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/status201/vast-websynth/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/status201/vast-websynth/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/status201/vast-websynth/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/status201/vast-websynth/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/status201/vast-websynth/releases/tag/v1.3.0
