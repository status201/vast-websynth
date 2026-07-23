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

- **Paint a run of steps in one swipe** — press a step and drag across the grid
  to fill or wipe everything the pointer touches. Starting on an empty step
  paints steps on; starting on a lit one erases, so clearing a whole hat line is
  a single gesture instead of sixteen precise clicks. Works on the sequencer,
  drum and sampler grids, with a finger or a mouse, and diagonally across
  drum/sampler rows.

- **Hold a step to edit it without switching it off** — press and hold (or
  right-click) a lit step to select it for the edit row. The step stays exactly
  as it was, ready to retune.

- **Clear ▾ on every machine** — next to each machine's Undo button, a Clear
  menu wipes the whole bank, or just one row: the selected track or slot on the
  Sequencer, Drum Machine and Sampler, and on Motion a list of whichever lanes
  (XY, A, B) currently hold steps. A message appears with an Undo button, and
  one press brings everything back — a cleared bank costs exactly one undo, not
  one per step.

- **Delete key clears the selected step** — Delete or Backspace switches off the
  step you have selected on whichever machine tab is open.

- **Presets can leave the browser** — sounds used to live only in this browser's
  storage, so clearing your profile lost them and there was no way to move a
  patch to another machine or hand it to someone else. Two new files fix that:
  a **preset** holds one sound (`<name>.preset.websynth.json`) and a **bank**
  holds many (`<name>.bank.websynth.json`) — the traditional synth naming, where
  a patch is a single sound and a bank is a collection of them.

- **One Preset button for everything** — the header's Save button now opens a
  preset manager: save the sound you are hearing, export it as a preset, export
  a bank, or import a file. The bank export offers **Mine** (everything you have
  made or changed, worked out by comparing against the factory sounds) or
  **All**, and tells you how many presets and which ones.

- **Importing presets shows you what will happen first** — choosing a file opens
  a review list marking each incoming preset as new, already identical, or
  clashing with one you have. Where names clash you choose **Keep both** (the
  default — it lands as "lead 2"), **Overwrite** or **Skip**, and the button says
  exactly how many will be written. Nothing is saved until you confirm, and your
  current sound is never touched. Re-importing a file you exported yourself
  changes nothing.

- **Motion's A and B cells read as level bars** — they no longer draw the XY
  pad's vertical centre line. A track cell only has a height, so an axis line
  down the middle suggested a horizontal position that does nothing.

- **The Motion tab is laid out by lane** — each of the three lanes now carries
  its own controls on a line directly above its own cells, instead of the XY
  lane's settings being split between the top header and a row underneath the
  pads. The XY Pad button, the Y/X graph toggle, the SLIDE/STEP switch, the two
  axis dropdowns and the "inherited / graph" readout are together in one row, so
  the toggle sits beside the value it explains. All three lanes share the same
  16 columns, so step 5 lines up vertically across them, and a single divider
  separates the XY lane from the two tracks.

- **Two more automation tracks in the Motion sequencer** — each motion bank now
  carries two extra tracks alongside the XY pair, and each one drives a single
  parameter you pick yourself. A bank can move up to four parameters at once (the
  XY pair plus these two); or, because these two tracks are independent of the XY
  Pad, move just them and keep the pad free for playing live. Pick a parameter per
  track per bank, drag the cells to set levels
  and double-click to clear, exactly like the XY steps. They follow the same
  Slide/Step curve and the same flow across the bar line, and copying a bank
  brings the tracks and their parameter choices with it.

- **Slide or Step per motion lane** — the Motion tab's SLIDE/STEP switch used to
  apply to everything at once. Each lane now has its own, so the XY sweep and the
  two extra tracks can differ: ramp a filter smoothly while another parameter
  jumps and holds, in the same bar.

- **Four sequencer tracks** — the note sequencer now has four independent
  tracks per bank instead of one, so a bank can hold a chord or a counter-line
  without faking it through the arpeggiator or a second render. Track 1 is the
  sequencer you already had, unchanged; tracks 2–4 start empty and folded away,
  and unfold with a click (a song that uses them opens them for you). Each track
  has its own mute, and each holds its own notes and ties, so one track's rest
  never cuts another's held note short. Tracks 2–4 need **poly** voicing — in
  mono they dim and say so rather than fighting over the single voice, and
  nothing is lost when you switch back.

- **Files that went through the wrong door say so** — dropping a preset or bank
  on the Song tab's Import points you at the Preset button instead of reporting
  a broken song, and vice versa.

- **Empty slot in the FX rack** — on narrower screens the five effect panels sit
  in two columns and left one cell empty. It now reads as a vacant slot with
  room for another module's front plate: an inset, borderless recess, faintly
  lit at the centre and dark at the rim, with a colour-coded loom of cables
  dropping through it from the rack above — two ranks deep, the far one dimmer
  and finer — and one unused lead dangling its jack plug in mid-air. Purely
  decorative, and deliberately almost invisible.

### Changed

- **Knobs use the whole panel on tablets and phones** — on narrower screens the
  synth panels widen, and their knobs now spread evenly across that width instead
  of bunching in the middle. Sub/Uni and Filter drop from two cramped rows to a
  single row, and every panel gets the same generous, consistent spacing. On a
  wide desktop the layout is unchanged (Sub/Uni, Filter and the envelopes stay a
  tidy 2×2).

- **Switching a step off keeps its settings** — a step you toggle off holds on to
  its note, velocity, gate, probability, ratchet and tie, so toggling it back on
  restores it exactly as it was. Clearing a bank works the same way.

- **Audio buttons spell out the format** — on the Song tab, the Audio row's
  buttons now read **Export Song as WAV** / **Record as WAV** (or MP3), following
  the Format switch, so it is obvious what each will write. While recording, the
  button still just says **Stop**.

- **The tour shows you how to paint a pattern** — a new step lands on the drum
  grid (already full of the demo you loaded a moment earlier) and demonstrates
  tapping, dragging a run on or off, holding a step to edit it, and Clear ▾.

- **Help badges caught up with the app** — the Sequencer, Drum Machine and
  Sampler badges now explain drag-to-paint, hold-to-edit, Delete, Clear ▾ and
  Undo in the same words; the Sequencer badge covers its four tracks and why
  2–4 need Poly; Motion explains its two extra parameter tracks; and the header's
  **Presets** button has a badge of its own, spelling out the difference between
  a preset and a song and what the export/import review does.

- **Help badges sit still** — the little (i) badges no longer pulse, and they are
  a touch see-through, so a screenful of them is a quiet layer over the panels
  rather than a dozen things blinking at once. They still glow, and hovering one
  brings it back to full strength.

### Fixed

- **Selecting a beat-column step now shows** — on the Drum Machine and Sampler
  grids, a lit step on beats 1, 5, 9 and 13 kept its red outline when selected,
  so there was no sign of which step the edit row was about to change. It now
  takes the same yellow outline as every other step.

## [2.2.1] - 2026-07-21

### Added

- **Machine status lights** — the Sequencer / Drum Machine / Sampler / Motion
  tabs now carry a small LED, so you can see at a glance whether a machine is
  running without opening its tab: fully lit = on and audible, half lit =
  enabled but muted (or silenced by another lane's solo), unlit = off. It is an
  indicator only — clicking anywhere on the tab still just opens it.

- **Song tab lane titles are links** — the "Sequencer" / "Drums" / "Sampler" /
  "Motion" headings on the Song tab's chain cards now open that machine's tab
  (marked with a ↗).

### Changed

- **The app starts lighter** — the MP3 encoder is a large chunk of code that
  every visitor used to download and parse before the synth would boot, whether
  or not they ever exported an MP3. It is now fetched only when something
  actually encodes MP3, cutting roughly a third off the initial download. It is
  still quietly pulled in the background once the app is idle, so exporting MP3
  offline (as an installed app) keeps working exactly as before, and the export
  itself is unchanged — same 192 kbps, same files.

- **Motion curves now flow across the bar line** — a chained motion bank used to
  wrap back into itself at the end of the bar, so a move you built up over a bank
  quietly collapsed inside its final step: a filter sweep or delay throw ending
  high at step 16 raced back down to where the bank started before the next bar
  ever got a say. Motion now hands off instead. The last anchor of a bank ramps
  toward the *next* bank's first anchor, and a bank's opening anchor continues
  from the *previous* bank's last, so a curve drawn across a chain reads as one
  continuous gesture. If the next bar can't be carried into — it rests, holds no
  anchors, or drives different parameters — the value simply holds where you left
  it rather than sliding somewhere arbitrary. The Motion tab's graph draws both
  bar edges as dashed lines at the values that will actually play, so the seam is
  visible while you author instead of a surprise on playback. A bank that repeats
  (a single-slot chain, the same bank twice, or the lane switched off) behaves
  exactly as before.

### Fixed

- **Step Input can no longer record behind your back** — the Sequencer's Step
  Input kept capturing every note you played, even from a completely different
  tab, so an afternoon of fiddling with the Arpeggiator could quietly overwrite
  a riff you had already written (and, with Bank Follow on during playback,
  smear it across all four banks). It is now scoped to what you can see: it
  records only while the Sequencer tab is open, switching tabs or folding the
  pattern row switches it back off, loading a song or hitting New clears it, and
  arming it turns Follow off so your take stays in the bank in front of you.

- **Sync no longer holds your tempo hostage** — with Sync set to Slave,
  disconnecting (unplugging the MIDI cable, closing the WiFi link, or the other
  instrument simply going away) left the setting stuck "on": the BPM knob
  stayed greyed out and unmovable at the vanished master's tempo, and it
  survived a reload. Master/Slave is still remembered, but it now only takes
  effect while something is actually connected — otherwise it greys out to
  *armed*, the status line says why ("Slave armed — no clock"), and the tempo
  is yours again. It picks up by itself when the clock comes back, including
  after a virtual MIDI cable outlives the app behind it. If the link drops
  mid-song nothing lurches: the BPM knob adopts the tempo already playing. A
  brief dropout while playing still rides through untouched.

## [2.2.0] - 2026-07-20

### Added

- **Toast notifications** — a small bottom-center toast component (one at a
  time, optional action button, 8 s auto-dismiss) for non-blocking feedback.
  First consumer: the "Loaded … — Undo" safety net.

- **Session safety net** — your working session now autosaves continuously
  (closing or reloading the tab loses nothing; it restores silently on the
  next visit), and loading a demo/song/import over your work shows an
  **Undo** toast that brings everything back — including loaded sampler
  audio. New still asks first, then offers the same Undo. Accidentally
  clicking a demo can no longer destroy your song.

- **Pattern undo** — every machine (Sequencer, Drums, Sampler, Motion) has an
  Undo button next to its bank bar, plus **Ctrl/Cmd+Z** on that machine's tab:
  step toggles, per-step setting tweaks (a drag counts as one step), and bank
  copies all revert one gesture at a time, up to 50 deep per machine. Loading
  a song starts a fresh history.

- **Drum voice models** — every drum track can now swap its voice algorithm
  via a model dropdown in the Drum tab's sound-design strip: the 8 classic
  voices plus five new percussion synths (**Conga, Bongo, Cowbell, Clave,
  Shaker**). The grid row label follows the chosen voice, the choice is saved
  in songs/presets like any knob, and existing files keep their classic
  voices untouched.

- **Percussion kit** — a new factory kit in the KIT dropdown that turns the
  drum machine into a percussion section (congas, bongo, clave, shakers,
  cowbell) in one click. Randomize still shuffles timbre only — it never
  changes the selected voices.

- **Demo pair: 1985-1 & 1985-2** — a two-instance jam built from a Hands On
  demo MIDI: 1985-1 (bass + drums) and its companion 1985-2 (staggered string
  chords + syncopated percussion on the new voices), made to run together
  over MIDI clock sync (Master/Slave).

### Changed

- **Song export is pretty-printed** — the downloaded `.websynth.json` is now
  indented (matching `npm run clean:demos` byte-for-byte), so exported songs
  dropped into `src/state/demos/` produce readable git diffs. Save slots,
  project zips and share links stay compact. `npm run build` re-canonicalizes
  the demos automatically and CI's new `check:demos` fails on drift; all
  previously single-line demos were unfolded once.

- **Guided tour shows off the Song tab** — two new steps before the sign-off:
  one on the arrangement **chains** (banks chained a bar at a time, plus the
  per-lane mute/solo/level mixer) and one on the **live DJ FX** (Fill, Stutter,
  Drop, Tape Stop and the DJ filter). The tour now finishes with the Song tab
  open and ready to play, instead of parked on the Sequencer.

- **Mod wheel help badge tells the truth** — it now explains that the wheel
  boosts the LFO amount toward whatever destination is selected (wobble /
  vibrato / tremolo / PWM), and that it does nothing while the LFO
  destination is off.

- **Help button tooltip** — reads "Help & Demo Tour" while help badges are
  off (it opens the Help chooser, not a shortcuts list).

- **Snappier step grids and knobs** — dropped the CSS fade transitions on the
  seq/drum/sampler step buttons (background + per-step viz fill) and the knob
  arc. During chained playback every bank switch restarted hundreds of these
  transitions at once for pure style/paint overhead; states now snap instantly.

### Fixed

- **Zip demo names** — project-zip demo buttons prettify the filename
  (underscores → spaces), so `Run_Away_2.websynth.zip` shows as "Run Away 2".

## [2.1.1] - 2026-07-17

### Changed

- **Active Help button switches badges off in one click** — while help badges
  are showing (the Help button glows orange), clicking Help now turns them off
  directly instead of opening the Help menu first; when inactive it opens the
  menu as before.

- **Fullscreen button shows its active state** — the header fullscreen toggle
  now glows orange while fullscreen is engaged, the same treatment the Help
  button gets while help badges are showing.

- **Rest overlay steps aside while you edit** — a machine tab's dimming rest
  overlay now hides while that panel's Bank **Follow** toggle is off (Follow
  off means you're editing, and the grid should look editable); it comes back
  as soon as Follow is switched on again while the lane is still resting.

### Fixed

- **Motion froze the wrong value going into a rest bar** — with look-ahead
  scheduling, the last slice of the bar before a rest was cut off, so a final
  low anchor never wrote and the previous (often high) value stayed frozen
  through the rest. Rests and bank switches now land exactly on the *heard*
  bar boundary.

## [2.1.0] - 2026-07-16

### Added

- **Motion Mute on the Song tab** — the Motion card now has a Mute switch like
  the other machines: muting pauses the automation and returns every driven
  knob (and the XY Pad's axes, assignments and values) to its resting state;
  unmuting resumes mid-play.

- **Motion help badge** — help mode now pins an (i) badge to the Motion tab
  explaining the machine and, in particular, the Y/X graph view (the line
  projects one axis at a time; the dots never move).

- **Motion sequencer** — a new machine between Sampler and Song that automates
  the XY Pad's two assigned params from a 16-step × 4-bank grid. Every step is
  a mini XY pad: drag to set an anchor, double-click to clear; a graph line
  traces the selected axis across the bar (Y/X view toggle). Slide mode ramps
  smoothly between anchors (filter sweeps in one bar: anchor min → max → min);
  Step mode jumps and holds (param-lock stabs). Each bank can optionally
  override which two params it drives (e.g. bank A cutoff×resonance, bank B
  delay time×mix), falling back to the XY Pad assignment. Motion has its own
  arrangement chain lane and Song-panel card, respects rests, and restores
  every automated param to its pre-play value on stop. Song files grow to v4
  (additive — older songs load unchanged); the AI authoring dialect gains a
  `motion` key and both published schemas document it.

- **holistic1 + holistic2** — twin demo songs built for multi-synth play: each
  is a funky, syncopated 12-bar groove on its own (112 BPM, E minor, 12-bar
  blues form), but sync two instances (Web MIDI or WiFi) and play them together
  and the bass and lead hocket into one composite melody while the two half-kits
  (kick/snare/low toms vs claps/hats/high toms) merge into a full drum kit —
  down to a bar-12 tom fill that cascades across both machines. Demo drop-ins
  under `src/state/demos/` are now exempt from the SDD spec guard (they're data,
  not code).
  
- **Restore to Factory Settings button** — (About modal, under the keyboard
  shortcuts) clears all data saved on the device (presets, songs,
  settings) and reloads the app into its factory state. Guarded by a styled
  confirm dialog whose fine print quotes the classic exit warning: *“Everything
  not saved will be lost.”*

### Changed

- **Motion graph matches Step mode** — with STEP selected the graph draws the
  true jump-and-hold staircase (including the wrap-around hold before the
  first anchor) instead of a slanted line; SLIDE keeps the ramp.

- **Leaner spectrum analyser** — the scope's FFT size halved on every
  performance tier (weak/medium/strong now 256/512/1024): fewer, wider
  spectrum bars that read better, at half the always-on analysis cost.

### Fixed

- **Escape with a dialog stacked over the About modal** closed the About modal
  underneath instead of the dialog on top. Escape now closes only the topmost
  layer.

## [2.0.1] - 2026-07-13

### Changed

- **Header icon buttons** — the Save / Perf / About / Help / Fullscreen
  buttons are now compact SVG icon buttons (floppy, gauge, ⓘ, ?, expand
  corners) with descriptive hover tooltips and accessible labels, decluttering
  the header; Fullscreen moved to the end of the row and swaps to a
  compress-corners icon while active. The Perf gauge still tints red / amber /
  green with the resolved performance tier.
- **Dropdowns open at the current value** — every dropdown (preset selector,
  XY Pad axis pickers, drum kit, song/seq slots, mic device) now scrolls the
  selected option into view and focuses it on open, instead of opening at the
  top of the list; closing returns focus to the dropdown button.
- **Tidier wrapped header** — when the header wraps to two rows (≤1140px) the
  layout is now deterministic: the transport cluster (Play / BPM / Swing)
  leads the second row at the far left with the voicing cluster (Mono-Poly /
  Panic / Vol) at the far right; on the first row the preset dropdown + Save
  stay left while the utility icon buttons (Perf / About / Help / Fullscreen)
  push to the far right, and the `Preset:` text label is dropped to save
  width. On phones (≤720px) the ☰ menu toggle parks at the far right of the
  brand row.
- **Compact preset dropdown on phones** — below 720px the preset dropdown no
  longer grows as wide as the selected preset/demo name: it is capped at 90px
  and a longer name truncates with an ellipsis. Wider screens are unchanged.

### Fixed

- **Sequenced synth notes clicked at note-off** — notes triggered by the
  sequencer (and arpeggiator) were cut instantly at the gate boundary instead
  of fading over the amp release, producing an audible click; live keyboard
  playing was unaffected. The envelope now anchors scheduled phase changes at
  the value the curve reaches at the scheduled time, so gated steps release
  with the proper tail. The filter envelope is fixed the same way (its cutoff
  snapped too).
- **Right edge clipped between ~993 and 1140px** (e.g. iPad Pro landscape,
  1024px): the header could neither shrink nor wrap in that range, cutting off
  the Panic button and volume knob — and, on some setups, the MIXER panel
  column. The header now wraps onto a second row from 1140px down, and the
  layout grid gives it room instead of letting the wrapped row paint over the
  panels.

## [2.0.0] - 2026-07-12

### Added

- **Songs from any AI agent** — a compact, input-only **authoring dialect**
  (`websynth-song-author`, ~40 lines instead of 576+ grid cells: note names
  like `"A2"`, drum hit-lists like `"kick": [0,4,8,12]`, chain strings like
  `"AABA"`) that import expands into a full song. Every import surface accepts
  it (Import button, OS file launch, project zips, share links); it is never
  exported. Published JSON Schema at `/schema/websynth-song-author.schema.json`
  plus an `llms.txt` for crawling agents.
- **✨ AI Prompt upgrade** — the prompt now teaches the compact dialect first
  (complete quickstart example, anti-truncation output rules, both schema
  URLs), with the full canonical format as an appendix — so weaker LLMs stop
  truncating mid-song.
- **Share links** — Export → **Copy Link** puts the whole song in a URL
  (`#song=…`, compressed into the hash; it never reaches a server). Opening
  the link loads the song; `#songUrl=<https url>` loads a hosted song/project
  file.
- **MCP server** — `scripts/mcp/` ships a zero-dependency MCP server (auto
  set-up in Claude Code via `.mcp.json`) giving tool-using AI agents a full
  authoring loop: `get_song_format`, `validate_song`, `expand_song`,
  `save_song`, `make_share_link`.

- **Install it as an app (PWA upgrades)** — added to your homescreen /
  installed from the browser menu, VAST now behaves like a native instrument:
  - **Works offline** after the first revisit (a hand-written, dependency-free
    service worker caches the app — production only, versioned per release).
  - **Keeps the screen awake while audio runs** (Screen Wake Lock, following
    the audio engine's state; released when audio stops, re-acquired on
    return to the tab).
  - **Fullscreen**: the installed Android app launches with no status bar,
    and a **Full/Exit** toggle in the header works in the browser too
    (hidden on iPhone, which has no fullscreen API).
  - **Opens song files directly** (desktop): `.json` and `.websynth.zip`
    files can be opened with the installed app and import exactly like the
    Import button.
  - **iOS polish**: a proper homescreen icon (PNG — iOS ignores SVG icons),
    and on iOS 17+ the synth now stays audible with the mute switch on via
    the standard Audio Session API (older iOS keeps the silent-loop
    workaround).
  - A second launch focuses the running instance instead of starting a
    second one (two instances would both make sound).

- **Export Project (song + sampler audio in one zip)** — the Song tab's
  **Export** now opens a chooser: **Song (.json)** (the unchanged format) or
  **Project (.zip)** — a `<name>.websynth.zip` bundling the song JSON with
  every loaded sampler clip (WAV by default, MP3 optional), so a song with
  samples re-imports in one step with **no re-loading of audio files**. Import
  auto-detects zip vs JSON on the same button; a hand-unzipped-and-re-zipped
  archive (Explorer, PowerShell) still imports. When no sampler audio is
  loaded the Project option explains itself and stays disabled. Browser save
  slots stay JSON-only, so after a page reload the usual re-load hint returns.
  Demo songs can now also ship as project zips (drop a `*.websynth.zip` into
  `src/state/demos/`). The zip reader/writer is hand-written and
  dependency-free, like everything else.

- **Import into sampler (resampling)** — a new section in the Sequencer tab
  renders the current seq bank through the live synth + FX chain and drops it
  into a sampler slot of your choice: layer harmonies on top of the live synth
  without a second synth instance. The capture is **bar-exact** (sample-accurate
  start and length, swing-safe) so it loops perfectly on the grid, and the bank
  plays twice under the hood so delay/reverb tails wrap seamlessly into the
  loop's start. Drums/sampler keep playing while you render but are never
  captured. Like all sampler audio, the rendered buffer lives until reload —
  re-render anytime (the seq bank is saved with the song).

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

- **Sustain pedal** — a MIDI sustain pedal (CC64) now works: releasing keys
  with the pedal down lets notes ring until the pedal lifts, and re-pressing a
  sustained key never cuts the new note short. With the arpeggiator on, the
  pedal doubles as an arp latch (held notes keep arpeggiating).

- **"Nothing to play yet" helper** — pressing Play when no machine is switched
  on with steps to play (a fresh boot, say) no longer starts a silent
  transport: a modal explains why nothing would be heard, what to do about it,
  and offers a one-click **▶ Play a demo**. A "Don't show this again" checkbox
  remembers your choice across sessions. Sync master/slave modes are exempt
  (an empty clock legitimately drives external gear).

- **Play button attention blinks** — the header Play button was easy to miss:
  while the transport is stopped its LED now pulses orange slowly, and any
  action that stays silent until you press Play — loading a demo or song,
  importing, turning a machine on, enabling a chain — switches it to a fast
  green "press play" blink until playback starts (playing keeps the familiar
  red beat blink). Honours reduced-motion.

### Changed

- **MP3 quality raised to 192 kbps** (from 128) — the high-quality sweet spot,
  applied to every MP3 the app writes: audio export, recordings, project-zip
  clips, and sample-editor saves.
- **Demo row de-cluttered** — the Song tab shows the first 6 demos inline; the
  rest tuck behind an **All Demos** toggle.

### Fixed

- **Disabled buttons now look disabled** — every switch-styled button gets a
  shared dimmed/not-allowed style when disabled (the Export modal's Copy Link
  on the Project row, the render-to-sampler button, wizard steps).

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
- **MIDI sync now actually locks** — a slave following over MIDI drifted a
  beat ahead of the master and could lose the tempo entirely. Cause: MIDI
  clock pulses are scheduled ahead with timestamps, so the Start message
  (sent immediately) overtook pulses already queued on the wire; the slave
  counted that stale tail into the new run, skewing both its tempo estimate
  and its beat position. The slave now ignores the possible in-flight span
  right after a Start/Continue and re-derives its beat position from pulse
  arrival times, and the master cancels its queued pulses around Start/Stop
  where the browser allows. Tempo estimation also stays reliable on bursty
  MIDI delivery (pulses arriving bunched together). WiFi sync was unaffected.
- **AI-authored songs play on import** — a compact authoring-dialect song
  imported silent unless it explicitly set `seq.on`/`drum.on`, even with banks
  full of notes (and the authoring guide wrongly claimed they defaulted on).
  Machines with hits now enable automatically on expansion — across every
  import surface (Import button, share links, OS file launch, MCP tools);
  an explicit `"seq.on": 0` still keeps one silent.
- **Copy Link is disabled for Project (.zip) exports** — a share URL embeds
  only the song JSON and can never carry sampler audio, so the button now
  disables with an explanatory tooltip while Project is selected instead of
  offering a link that would silently drop the samples.

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

[Unreleased]: https://github.com/status201/vast-websynth/compare/v2.2.1...HEAD
[2.2.1]: https://github.com/status201/vast-websynth/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/status201/vast-websynth/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/status201/vast-websynth/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/status201/vast-websynth/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/status201/vast-websynth/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/status201/vast-websynth/compare/v1.9.0...v2.0.0
[1.9.0]: https://github.com/status201/vast-websynth/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/status201/vast-websynth/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/status201/vast-websynth/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/status201/vast-websynth/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/status201/vast-websynth/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/status201/vast-websynth/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/status201/vast-websynth/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/status201/vast-websynth/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/status201/vast-websynth/releases/tag/v1.3.0
