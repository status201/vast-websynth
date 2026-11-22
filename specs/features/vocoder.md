# Vocoder (sample studio)

```yaml
id: vocoder
status: implemented
version: 1
owner: core
related:
  - sample-recorder        # the studio that hosts the tab, runOp, the undo stack, ClipPreview
  - time-stretch           # the sibling pure DSP; Stretch to fit reuses fitToFrames
  - sampler                # a filled slot can be the voice
  - metronome              # the click is silenced for a voice take
  - transport-window       # a playing song is stopped through the header's own button
  - panel-tabs             # the fifth tab
  - untrusted-input        # the frame cap and control ranges live in limits.ts
  - runtime-performance    # the render is paid once, on a press
  - testids
source:
  - src/audio/recorder/vocoder.ts          # vocode(), the pure channel vocoder
  - src/audio/recorder/voice-take.ts       # the cue pass, the crop window, the latency sum
  - src/audio/recorder/mic-capture.ts      # MicSession.firstFrame / inputLatency()
  - src/ui/components/studio-vocoder.ts    # the Vocoder tab and the voice take
  - src/ui/components/studio-tools.ts      # ToolContext.setPlayhead
  - src/ui/components/record-sound-modal.ts
  - src/ui/components/record-screen.ts     # micErrorText, the mic's refusals in words
  - src/state/limits.ts
  - src/ui/onboarding/help-content.ts      # the `sampler` topic names the tab
```

A **channel vocoder** in the sample studio's Edit screen. The selection is the
**carrier**. The **voice** (the modulator) is either sung or spoken into the mic
in time with the carrier, or taken from a filled sampler slot. It is offline,
destructive and undoable, like every other edit in the studio.

## Background / Why

A vocoder needs two signals that line up with **each other**: the voice's
syllables have to land where the carrier is sounding. They do not need to line
up with the clock, so the voice take is exactly as long as the carrier selection,
whatever that is (one bar, two, or a clip that is not bar-length at all). The
take plays the carrier once as a cue and records while it plays a second time.
For a one-bar loop that is "play the bar twice, sing on the second".

It is a buffer edit paid once on a press, like [time-stretch](time-stretch.md),
because a realtime vocoder voice on the audio thread is what ADR-010 budgets
against. It is hand-written (ADR-003). A filter bank with envelope followers is
the classic vocoder sound; the in-house FFT stays available if a spectral variant
is ever wanted.

## Requirements

- **REQ-vocoding-is-pure** — `vocode(carrier, voice, settings)` in
  `src/audio/recorder/vocoder.ts` takes and returns `CapturedAudio`, with no
  `AudioContext` and no DOM. It is deterministic: the same inputs give the same
  samples.
- **REQ-a-channel-vocoder-on-log-spaced-bands** — The voice and the carrier go
  through the same bank of `bands` band-passes. The centres are log-spaced from
  `VOCODER_LOW_HZ` to `min(VOCODER_HIGH_HZ, 0.45 × sampleRate)`, and each band is
  two cascaded RBJ band-pass biquads whose bandwidth is one band step. Each voice
  band drives an envelope follower: a fixed `VOCODER_ATTACK_MS` attack and a
  release set by **Smooth**. Each carrier band is multiplied by its voice
  envelope, and the bands are summed.
  - **Formant** shifts which voice band drives which carrier band: carrier band
    `k` takes voice band `k − formant`. A positive formant moves the voice's
    formants up. A band whose source falls outside the bank is silent.
  - **Clarity** (0..1) flattens the carrier: each carrier band is scaled by
    `max(env, floor)^−clarity`, where `env` is that band's own envelope. That keeps
    a dull carrier (a bass, a dark pad) intelligible. The floor sits 60 dB under
    the carrier's peak, so a band the carrier never fills is not raised from its
    noise. The gain is computed every `FLAT_STEP` frames and interpolated between,
    since the envelope it reads is smooth and a power per sample was the bank's
    costliest step.
  - **Sibilance** (0..1) adds the voice's own content above `VOCODER_SIBILANCE_HZ`
    (a two-section high-pass, held under Nyquist), centred in both channels. A carrier rarely has the
    noise a consonant needs.
  - **Dry** (0..1) adds the untouched carrier back.
- **REQ-the-carrier-image-is-kept** — The voice is mixed to mono before analysis,
  and every gain (the voice envelopes and Clarity's flattening, which is read from
  the carrier's mid) is applied **identically** to both carrier channels. A stereo
  carrier keeps its image; deciding per channel would decorrelate it, as
  [time-stretch](time-stretch.md) REQ-both-algorithms-decide-from-the-mid
  found.
- **REQ-the-output-is-the-carriers-length** — The output has exactly the
  carrier's frame count. A shorter voice is padded with silence, and a longer one
  is cut.
- **REQ-the-output-peak-matches-the-carrier** — The output is scaled so its peak
  equals the carrier's, capped at `VOCODER_PEAK_CAP` (0.99). A silent result stays
  silent, never divided by zero.
- **REQ-vocode-is-total** — The function never throws:
  - An empty carrier returns a clone.
  - A carrier past `MAX_VOCODER_FRAMES` returns a clone, checked before anything is
    allocated.
  - Non-finite samples in either input are read as 0.
  - Out-of-range settings are clamped, and a band count outside `VOCODER_BANDS`
    falls back to the default.
  - A silent voice gives silence (plus Dry), which is what a vocoder does; the tab
    says so.
- **REQ-vocoder-bounds-live-in-limits** — `MAX_VOCODER_FRAMES`, `VOCODER_BANDS`,
  `MAX_VOCODER_FORMANT` and `MAX_VOICE_OFFSET_MS` are written in
  `src/state/limits.ts` only (ADR-015). The frame cap is 30 s at 48 kHz. A
  32-band render costs time in proportion to the clip, so the cap sizes main-thread
  time, not trust.
- **REQ-vocoder-registers-no-params** — The settings and the voice are
  studio-lifetime state: they survive a tab change, an edit, an undo and a
  re-record, and are dropped when the studio closes. Nothing is persisted, and no
  ParamBus id is registered.
- **REQ-the-studio-hosts-a-vocoder-tab** — **Vocoder** is the studio's fifth tool
  tab ([sample-recorder](sample-recorder.md) REQ-the-tools-are-tabs). It holds:
  - the voice picker and **Record voice**
  - the voice lane
  - **Offset** (and **Stretch to fit**, for a slot voice)
  - **Bands**, **Formant**, **Smooth**, **Clarity**, **Sibilance**, **Dry**
  - **Audition** and **Apply**

  A hint line names what is missing ("Record a voice, or pick a slot as the voice";
  "nothing selected"; "the selection is longer than 30 s"). Audition and Apply stay
  disabled until nothing is.
- **REQ-the-voice-is-the-mic-or-a-slot** — The voice picker offers **Mic take**,
  then S1–S8 by slot name.
  - A slot with no audio (empty, or a name waiting for its file) is disabled.
  - A slot voice is read through `audioBufferToCaptured` when it is used, so a
    slot changed meanwhile is read fresh.
  - **Stretch to fit** shows for a slot voice only. It runs
    `fitToFrames(voice, selectionFrames, 'tonal')`, and is disabled with a reason
    when the ratio is outside the stretch limits.
- **REQ-the-voice-take-follows-the-carrier** — **Record voice** opens the mic and
  plays one buffer through the studio's `ClipPreview`: the **cue** followed by the
  whole selection (`buildCuePass`).
  - The cue is the selection's last `min(selection, one bar)`, with one bar being
    `MusicLengths.framesFor(barTicks)`. A one-bar loop therefore plays twice, and a
    long carrier never makes the singer wait through all of it first.
  - A playing song is stopped first, through the header's own button
    (`toggleTransport`), because it would leak into the take.
  - The metronome's click is silenced for the take and restored after it. The
    carrier is the cue, and a free-running click is not aligned with it.
  - The tab counts the beats left in the cue at the current BPM ("Get ready… 3"),
    then shows "Sing now" while the main waveform's playhead sweeps the selection
    and the voice's level draws into the lane.
  - The take stops itself `VOICE_TAKE_MARGIN_S` past the end of the selection's
    pass, with latency and the offset range allowed for.
- **REQ-the-voice-take-is-cropped-frame-exact** — Capture starts at the press.
  The voice is the raw take read from the frame where the selection's pass was
  heard:
  - `takeStartFrame = round((takeAt + latency) × sampleRate) − firstFrame`
  - `takeAt` is `ClipPreview.startTime + cueFrames / sampleRate`.
  - `firstFrame` is `MicSession.firstFrame`, the absolute context frame of the
    take's first sample (audio-export REQ-each-chunk-is-frame-tagged). Before
    any chunk arrives it falls back to `round(startedAt × sampleRate)`.
  - `latency` is `autoLatency()`: the context's `outputLatency` (falling back to
    `baseLatency`) plus the mic track's reported `latency`. Each term is read as 0
    when it is missing or non-finite, and clamped to 0.5 s.
- **REQ-the-offset-slides-the-voice-without-re-recording** — **Offset**, ±
  `MAX_VOICE_OFFSET_MS`, moves the voice against the carrier. Positive means
  later: the voice is read from `takeStartFrame − offsetFrames`. The raw take is
  kept, so the slide reads more of it, never a re-recording. Past the raw take's
  ends it pads with silence. The voice lane redraws as Offset moves, with the
  carrier drawn faintly behind the voice on the same time axis, so a consonant can
  be lined up with a hit by eye. The lane paints only while the tab shows, once a
  change has settled for `LANE_SETTLE_MS`, on a resize, and on a theme change
  (ui-themes.md REQ-a-theme-change-repaints-the-canvases).
- **REQ-audition-before-apply** — **Audition** renders the vocoded selection and
  plays it through `ToolContext.playClip`, committing nothing. **Apply** goes
  through `runOp` (label `Vocode`), so it inherits the busy latch, the undo stack,
  the marks reset and auto-play. A finished mic take auditions itself when the
  Effects page's auto-play is on.
- **REQ-the-voice-take-owns-its-teardown** — The take's mic session is disposed
  in every way a take can end:
  - when the take ends, and when it is cancelled
  - when the studio closes ([sample-recorder](sample-recorder.md)
    REQ-the-editor-owns-its-teardown)
  - when a stop resolves after the close: that take is dropped

  The watch interval, the click hold and the playhead override are released on
  the same paths. Pressing Record voice during the cue cancels the take and keeps
  nothing. Pressing it during the selection's pass stops early and keeps what was
  captured; the read pads the rest.
- **REQ-a-stopped-carrier-cancels-the-take** — If the carrier stops before its
  pass is over (the edit bar's Stop, or another audition), the take is cancelled
  and nothing is kept. A voice recorded against half a carrier is not a voice
  for that carrier.

## Technical design

### Gesture inventory (ADR-014)

| Control | Tap / click | Drag | Long press | Double | Keyboard |
| --- | --- | --- | --- | --- | --- |
| `voc-source` | opens the voice picker | — | — | — | the Dropdown's keys |
| `voc-record` | idle: start the take; cue: cancel; selection pass: stop early | — | — | — | Enter/Space when focused |
| `voc-offset` | — | slides the voice | — | — | arrows when focused (range input) |
| `voc-stretch` | toggles Stretch to fit (slot voice only) | — | — | — | Space when focused |
| `voc-bands` | opens the band-count picker | — | — | — | the Dropdown's keys |
| `voc-formant` / `voc-smooth` / `voc-clarity` / `voc-sibilance` / `voc-dry` | — | sets the value | — | — | arrows when focused |
| `voc-audition` | renders and plays without committing | — | — | — | Enter/Space when focused |
| `voc-apply` | vocodes the selection (Undo takes it back) | — | — | — | Enter/Space when focused |

A `—` is a decision. Nothing is momentary: Record voice is a toggle, not a hold
(ADR-014 law 2). The studio's `R` stays the Record screen's key; it is not bound
here.

### Contract / public interface

```yaml
vocoder.ts:
  vocode(carrier, voice, settings: VocoderSettings): CapturedAudio
  bandCentres(bands, sampleRate): number[]
  DEFAULT_VOCODER: VocoderSettings
  VOCODER_LOW_HZ = 100 · VOCODER_HIGH_HZ = 8000 · VOCODER_ATTACK_MS = 5
  VOCODER_SIBILANCE_HZ = 5000 · VOCODER_PEAK_CAP = 0.99
voice-take.ts:
  VOICE_TAKE_MARGIN_S = 0.2
  buildCuePass(carrier, barFrames): { audio: CapturedAudio; cueFrames: number }
  autoLatency({ outputLatency?, baseLatency?, inputLatency? }): number
  takeStartFrame({ takeAt, latency, sampleRate, firstFrame }): number
  readVoice(raw, start, frames): CapturedAudio      # exactly `frames`, silence past either end
mic-capture.ts (MicSession):
  firstFrame: number | null      # RecorderNode.firstFrame of the current take
  inputLatency(): number         # the track's reported latency, s; 0 when unknown
studio-tools.ts (ToolContext):
  setPlayhead(fn: (() => number | null) | null)   # overrides the waveform playhead (frames of the selection)
studio-vocoder.ts:
  buildVocoderPage(ctx, opts: VocoderPageOptions) -> ToolPage & { destroy() }
  VocoderPageOptions: toggleTransport · metronome · settings {get,set} · voice {get,set} · autoPlay() · visible()
limits.ts:
  MAX_VOCODER_FRAMES = 48_000 * 30 · VOCODER_BANDS = [8, 16, 24, 32]
  MAX_VOCODER_FORMANT = 4 · MAX_VOICE_OFFSET_MS = 150
```

### Data shapes

```yaml
VocoderSettings:
  bands: number        # one of VOCODER_BANDS; default 16
  formant: number      # integer bands, ±MAX_VOCODER_FORMANT; default 0
  smoothMs: number     # envelope release, 10..200; default 40
  clarity: number      # 0..1; default 0.5
  sibilance: number    # 0..1; default 0.3
  dry: number          # 0..1; default 0
VoiceTake:             # studio-lifetime, never persisted
  raw: CapturedAudio   # the whole capture, press to auto-stop
  start: number        # takeStartFrame, offset 0
  frames: number       # the selection's length when it was taken
  latencyMs: number    # what autoLatency() measured, shown beside Offset
VoiceState:            # what the page keeps across rebuilds
  source: 'mic' | number   # a slot index
  take: VoiceTake | null
  offsetMs: number
  stretch: boolean
```

### Layer touchpoints & ordering

```yaml
flow: Record voice -> openMicSession -> session.start() -> ClipPreview.play(buildCuePass(...))
      -> watch: cue countdown, selection pass, auto-stop -> session.stop() -> dispose
      -> VoiceTake { raw, start = takeStartFrame(...) } -> audition
render: readVoice(raw, start - offset, selFrames) | slot voice (fitToFrames?) -> vocode(selection, voice, settings)
apply: ctx.runOp(btn, 'Vocode', (sel) => vocode(sel, voiceFor(sel), settings))
playhead: ctx.setPlayhead(() => (now - takeAt) * sr) during the pass; cleared on every exit
click: metronome.setClick(false) for the take; the toolbar's CLICK state put back after it
```

`ClipPreview` is unchanged: the cue and the selection play as one buffer, so the
selection's pass starts at a context time known before it sounds.

### Persistence

None (REQ-vocoder-registers-no-params). The voice take is held in memory for
the studio's lifetime only; the result reaches a slot through the studio's Load.

## Visual aids

```
 effects ┆ chop ┆ fit & shift ┆ scratch ┆ VOCODER
 Voice [Mic take ▾]  [● Record voice]   Sing now · use headphones
 ┌ voice lane: the carrier faint, the voice over it, one time axis ───────┐
 └─────────────────────────────────────────────────────────────────────────┘
 Offset ─────●──── +12 ms (auto 21 ms)          [ ] Stretch to fit
 Bands [16 ▾]  Formant ─●─  Smooth ─●─  Clarity ─●─  Sibilance ─●─  Dry ─●─
 [▶ Audition] [Apply]          Vocode: 2.00 s selection with the mic take
```

## Scenarios (BDD)

```gherkin
Scenario: The output is exactly as long as the carrier (REQ-the-output-is-the-carriers-length)
  Given a carrier of 9600 frames
  When it is vocoded with a voice of 4800 frames, and again with one of 20000
  Then both outputs are 9600 frames long
# pinned by: tests/audio/recorder/vocoder.test.ts

Scenario: A silent voice gives silence (REQ-vocode-is-total)
  Given a noise carrier and an all-zero voice, Dry 0
  When it is vocoded
  Then every output sample is 0
# pinned by: tests/audio/recorder/vocoder.test.ts

Scenario: A tone in the voice puts the carrier's energy in that band (REQ-a-channel-vocoder-on-log-spaced-bands)
  Given a white-noise carrier and a voice that is a sine at one band's centre
  When it is vocoded with Clarity 0 and Sibilance 0
  Then most of the output's energy lies within that band
# pinned by: tests/audio/recorder/vocoder.test.ts

Scenario: A stereo carrier keeps its image (REQ-the-carrier-image-is-kept)
  Given a carrier with identical left and right channels
  Then the output's left and right are identical
  Given a carrier with independent noise in each channel
  Then the output's channels stay decorrelated, so the mono down-mix does not collapse
# pinned by: tests/audio/recorder/vocoder.test.ts

Scenario: Bad input never throws or leaks a non-finite sample (REQ-vocode-is-total, edge)
  Given a carrier and a voice holding NaN and Infinity samples, and out-of-range settings
  When it is vocoded
  Then every output sample is finite and the peak is at most VOCODER_PEAK_CAP
  And an empty carrier, or one past MAX_VOCODER_FRAMES, comes back as a clone
# pinned by: tests/audio/recorder/vocoder.test.ts

Scenario: The peak follows the carrier, and the render is deterministic (REQ-the-output-peak-matches-the-carrier, REQ-vocoding-is-pure)
  Given a carrier peaking at 0.5
  When it is vocoded twice
  Then the output peaks at 0.5 and both renders are sample-identical
# pinned by: tests/audio/recorder/vocoder.test.ts

Scenario: The cue is the carrier's last bar, then the whole carrier (REQ-the-voice-take-follows-the-carrier)
  Given a carrier of three bars
  Then the cue pass is its last bar followed by all three bars
  Given a carrier of half a bar
  Then the cue pass is the carrier twice
# pinned by: tests/audio/recorder/voice-take.test.ts

Scenario: The take is read from where the carrier was heard (REQ-the-voice-take-is-cropped-frame-exact)
  Given a take whose first sample is context frame 1000, a pass starting at 0.5 s and 20 ms of latency
  Then the voice starts at frame round(0.52 × sr) − 1000 of the raw take
  And missing or non-finite latency terms count as 0, each clamped to 0.5 s
# pinned by: tests/audio/recorder/voice-take.test.ts

Scenario: Offset slides the voice and pads past the ends (REQ-the-offset-slides-the-voice-without-re-recording)
  Given a raw take and a start frame
  When the voice is read 150 ms earlier than the take begins
  Then it is exactly the selection's length, silent until the take's first sample
# pinned by: tests/audio/recorder/voice-take.test.ts

Scenario: The session reports its first frame (REQ-the-voice-take-is-cropped-frame-exact)
  Given a mic session that has captured its first chunk
  Then firstFrame is that chunk's frame tag, and inputLatency() reads the track's latency or 0
# pinned by: tests/audio/recorder/mic-capture.test.ts

Scenario: The tab waits for a voice, then applies through the undo stack (REQ-the-studio-hosts-a-vocoder-tab, REQ-audition-before-apply)
  Given a clip open in the editor and no slot holding audio
  When the user opens the Vocoder tab
  Then Audition and Apply are disabled and the hint asks for a voice
  And the empty slots are disabled in the voice picker
  Given S2 holds audio
  When the user picks S2 and presses Apply
  Then the clip is replaced by the vocoded selection and Undo brings it back
# pinned by: tests/ui/studio-vocoder.test.ts

Scenario: A mic take plays the cue, records the pass and keeps the voice (REQ-the-voice-take-follows-the-carrier, REQ-the-voice-take-owns-its-teardown)
  Given a clip open in the editor and the transport playing
  When the user presses Record voice
  Then the transport is stopped through the header's button and the click is silenced
  And the preview plays the cue followed by the selection
  When the selection's pass is over
  Then the take stops itself, the mic session is disposed and the click comes back
  And Apply is enabled
# pinned by: tests/ui/studio-vocoder.test.ts,
#            e2e/vocoder.spec.ts (the fake mic through the real recorder worklet, applied and undone)

Scenario: Closing the studio mid-take releases the mic (REQ-the-voice-take-owns-its-teardown, regression)
  Given a voice take in its cue
  When the studio closes
  Then the mic session is disposed and no interval is left running
# pinned by: tests/ui/studio-vocoder.test.ts

Scenario: Stopping the carrier cancels the take (REQ-a-stopped-carrier-cancels-the-take, edge)
  Given a voice take in the selection's pass
  When the preview stops before the pass is over
  Then the take is cancelled, the session disposed and no voice kept
# pinned by: tests/ui/studio-vocoder.test.ts

Scenario: The voice is intelligible and lands on the beat (by ear, ADR-010)
  Given a one-bar saw pad rendered to a slot, opened in the studio, with headphones on
  When "one, two, three, four" is recorded on the beats and applied
  Then the words can be understood and each lands on its beat, in Firefox and Chrome
  And moving Offset audibly loosens and tightens the timing
# pinned by: by ear — not automated
```

## Tests & verification

- Unit: `tests/audio/recorder/vocoder.test.ts`,
  `tests/audio/recorder/voice-take.test.ts`,
  `tests/audio/recorder/mic-capture.test.ts` — `npm test`
- UI: `tests/ui/studio-vocoder.test.ts` (jsdom, mocked mic session)
- Help copy: `tests/ui/help-content.test.ts` (the `sampler` topic names the tab and the take)
- E2E: `e2e/vocoder.spec.ts` (Chromium's fake mic device) and
  `e2e/sample-editor-tabs.spec.ts` (the five tabs) — `npm run e2e`
- Typecheck: `npm run typecheck`
- By ear (ADR-010), Firefox then Chrome, with headphones: the scenario above.
  `bench:audio` cannot drive the studio, and `vocode()` is pure, so a scratch
  script can render WAV files for tuning.

## Open questions / future

- Turning echo cancellation on for voice takes would let speakers be used instead
  of headphones. Whether the browser's AEC damages the envelope enough to hear has
  to be judged by ear.
- A spectral (STFT) variant on `fft.ts`, if a smoother, more "robotic-free" sound
  is wanted alongside the channel bank.
