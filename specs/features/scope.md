# Scope — Wave / Spectrum live visualizer

```yaml
id: scope
status: implemented          # draft | active | implemented
version: 2
owner: status201
related:
  - architecture
  - performance-mode
  - compressor
source:
  - src/ui/components/scope.ts
  - src/audio/engine.ts
  - src/ui/studio-api.ts
  - src/ui/app.ts
  - src/ui/onboarding/help-content.ts
```

## Background / Why

The bottom panel hosts a live oscilloscope/analyser (`Scope`) tapped **pre-master**
so the display is independent of the master-volume knob. It already toggles between
a **Wave** (time-domain) and a **Spectrum** (frequency) view via a single button.

The synth's signal is **stereo** (reverb, delay, phaser, ping-pong delay and the DJ
FX all produce L≠R content), but the scope down-mixes to mono — so stereo motion is
invisible. This feature adds an orthogonal **Mono/Stereo** toggle: Mono keeps the
existing single full-panel trace (the down-mix, the default); Stereo splits the
panel into two stacked halves — the **LEFT** channel on top, the **RIGHT** channel
below — each drawn with the same Wave/Spectrum renderer.

The two toggles are independent: Wave/Spectrum picks *what* is drawn, Mono/Stereo
picks *how many channels* are drawn. All four combinations are valid.

**Peak-hold (v2).** When mixing with the bus compressors (`compressor`) it helps to
see *how loud the signal actually got*, not just the live bars. The **Spectrum**
view therefore draws a **max-dB peak-hold** indicator: a dotted horizontal line
that is pushed up by the spectrum bars to mark the highest level reached, with the
level printed in dB beside it. The line falls back down very slowly on its own (a
peak-hold meter), and **clicking the graph resets it** immediately. So the top of
the graph reads **0 dB** without touching the (unchanged) bar heights, the displayed
dB is simply *re-labelled*: the analyser's default `getByteFrequencyData` range
(−100…−30 dB) is offset by +30 so its −30 dB ceiling shows as 0 dB ("clip"). The
peak-hold is **Spectrum-only** — Wave view is unaffected.

## Requirements

- **REQ-1** — The `Engine` exposes two extra per-channel analysers, `analyserL`
  (left) and `analyserR` (right), tapped at the **same point** as the existing mono
  `analyser` (post-`masterComp`, pre-`master`), so all three stay independent of the
  volume knob. The audio path to `master`/destination is unchanged (lossless
  split→merge), so every analyser sits in the live render path and is pulled.
- **REQ-2** — `analyserL`/`analyserR` use the **same** `fftSize` (2048) and
  `smoothingTimeConstant` (0.2) as `analyser`, so per-channel buffers are uniform
  and the three views are visually comparable.
- **REQ-3** — `StudioApi` exposes `analyserL`/`analyserR` alongside `analyser`
  (the UI's narrow view of the engine, ADR-009).
- **REQ-4** — `Scope` gains a channel mode `'mono' | 'stereo'` (default `'mono'`,
  the pre-existing view) set via `setChannels(c)`, orthogonal to the existing
  `setMode('wave'|'spectrum')`. State persists only in memory (see Persistence).
- **REQ-5** — The split layout is **pure** and unit-testable without a canvas:
  `scopeRegions(channels, w, h)` returns the sub-rectangles + channel tag/label to
  draw into. Mono → one full-panel region. Stereo → two equal regions with a
  **responsive** orientation decided from the panel width: **side-by-side** (left =
  left half, right = right half) when `w >= STEREO_SIDE_BY_SIDE_MIN_W` (480 CSS px);
  **stacked** (left = top, right = bottom) below it — so small screens stack and
  don't cram two narrow traces side-by-side. The side-by-side halves are inset by a
  centre **`STEREO_GAP`** (16 px) gutter so the two channels read as separate
  traces, not one continuous display; the stacked halves tile edge-to-edge.
- **REQ-6** — The Wave and Spectrum renderers are **rect-scoped** (draw into a
  given region), so a single renderer serves 1 region (mono) or 2 (stereo) — DRY,
  no per-mode duplication. Each region draws its own mid-line; stereo regions show
  a faint `L`/`R` label.
- **REQ-7** — A second toggle button (`data-testid="scope-channels-toggle"`) sits
  in the scope panel, labelled `Mono`/`Stereo`, defaulting to `Mono`. Clicking it
  flips `Scope.setChannels` and its own label, without disturbing the Wave/Spectrum
  toggle.
- **REQ-8** — Performance scaling: the canvas **drop-shadow is dropped for all
  modes** (a baseline cost cut), and the redraw rate is a configurable target fps
  (`ScopeOptions.fps`, default 60; `setFps` live) — perf-mode drives 15/30/60. The
  loop always pauses while the tab is hidden. Applies equally to the mono and stereo
  renderers. See `performance-mode`.
- **REQ-9** — Defensive fallback: if `setChannels('stereo')` is called on a `Scope`
  built without left/right analysers, it stays in mono (no throw).
- **REQ-10** — In **Spectrum** view each region draws a **peak-hold** indicator: a
  dotted horizontal line at the highest level reached, with the level printed in dB
  beside it (right-aligned at the line). The peak is held **per channel** (mono =
  one line; stereo = an independent line in each of L and R). Wave view draws no line
  and does **not** update the held peak (it is frozen while in Wave, resumed on
  return to Spectrum).
- **REQ-11** — The displayed dB scale is **0 dB at the top of the graph** down to
  `-SPECTRUM_DB_RANGE` (−70 dB) at the bottom, computed by a pure
  `byteToDisplayDb(byte)` that re-labels the analyser's default byte range. **Bar
  heights are unchanged** — no analyser/`engine.ts` change; only the dB *label* and
  the line's vertical position derive from this scale. `dbToFrac(db)` is the inverse,
  clamped to `[0,1]`, used to place the line on the same vertical scale as the bars
  (so it rides on top of the tallest visible bar). The dB text turns the red accent
  as the peak approaches 0 dB (clip).
- **REQ-12** — A taller bar pushes the held value up instantly and **pins** it for
  `PEAK_HOLD_SEC` (a hold plateau, so the max is readable); after the plateau elapses
  the held peak **falls very slowly** at `PEAK_DECAY_DB_PER_SEC`, never below the
  current bar. All timing is frame-rate independent from a clamped inter-frame `dt`
  (the clamp guards the long gap after the tab was hidden), so it feels identical at
  any target fps (e.g. 15/30/60, set by perf-mode). The pure update is
  `updatePeak(state, currentMaxDb, dtSec)` (composing `decayPeak` for the fall);
  `state` is the per-channel `{ db, holdS }`.
- **REQ-13** — **Clicking the graph resets** the peak (every channel back to
  `-Infinity`, re-acquired on the next frame). The click listener is on the canvas
  element itself; the `scope-toggle`/`scope-channels-toggle` buttons are siblings of
  the canvas (not children), so clicking a button never resets the peak — satisfying
  "anywhere but the buttons" with no `stopPropagation`.
- **REQ-14** — Performance scaling (REQ-8) applies to the peak-hold too: it is cheap
  (one line + one label per region) and draws with no drop-shadow like the bars; while
  the tab is hidden the loop is paused, so the held value neither decays nor updates.
- **REQ-15** — For test observability the canvas carries `data-testid="scope-canvas"`
  and the held dB is mirrored onto its `dataset`: `el.dataset.peak`
  (mono) / `el.dataset.peakL` / `el.dataset.peakR` (stereo), formatted to one
  decimal; cleared in Wave view, on a Mono/Stereo switch, and on reset. The mirror
  is written **only when the formatted value changes** (not every frame), so a
  steady scope performs no per-frame attribute write — the dataset still always
  reflects the latest displayed value. (Lets E2E assert without a 2D context.)
- **REQ-16 (performance)** — The redraw loop must do **no per-frame layout read and
  no per-frame DOM mutation**: the canvas bitmap is sized from a `ResizeObserver`
  (cached CSS box + dpr), not by reading `clientWidth`/`clientHeight` inside the
  rAF loop, and the `dataset` mirror only writes on change (REQ-15). So an animated
  scope costs a single composited canvas raster, not a full page
  layout/style/layerize/paint each frame. Environments without `ResizeObserver`
  (jsdom under unit test) fall back to measuring on draw — behaviour unchanged.

## Technical design

### Contract / public interface

`Scope` (`src/ui/components/scope.ts`):

```ts
type ScopeMode = 'wave' | 'spectrum';
type ScopeChannels = 'mono' | 'stereo';

interface ScopeAnalysers { mono: AnalyserNode; left?: AnalyserNode; right?: AnalyserNode; }
interface ScopeOptions { fps?: number; }  // target redraw rate (default 60); see performance-mode

class Scope {
  readonly el: HTMLCanvasElement;
  constructor(analysers: ScopeAnalysers, opts?: ScopeOptions);
  setMode(m: ScopeMode): void;          // wave | spectrum  (unchanged behaviour)
  setChannels(c: ScopeChannels): void;  // mono | stereo    (new; stereo needs left+right)
  get channelMode(): ScopeChannels;     // effective layout (mono unless stereo set with both)
  resetPeak(): void;                     // clear the spectrum peak-hold (also bound to canvas click)
  setFps(fps: number): void;             // change the target redraw rate live (perf-mode tier switch)
  destroy(): void;
}

// Pure, exported, canvas-free — the split geometry (REQ-5):
interface ScopeRegion { x: number; y: number; w: number; h: number; tag: 'mono' | 'left' | 'right'; label: string; }
function scopeRegions(channels: ScopeChannels, w: number, h: number): ScopeRegion[];

// Pure, exported, canvas-free — the peak-hold dB math (REQ-11/12):
const SPECTRUM_DB_TOP = 0;       // dB shown at the top of the graph (clip)
const SPECTRUM_DB_RANGE = 70;    // dB span to the bottom (matches analyser -100..-30)
const PEAK_DECAY_DB_PER_SEC = …; // very slow fall rate (tuned by ear)
const PEAK_HOLD_SEC = …;         // plateau the peak is pinned at a new max before it falls
interface PeakState { db: number; holdS: number; }              // per-channel held peak
function byteToDisplayDb(byte: number): number;                 // 255 -> 0, 0 -> -70
function dbToFrac(db: number): number;                           // inverse of the above, clamped [0,1]
function decayPeak(heldDb: number, currentMaxDb: number, dtSec: number): number;  // the slow fall
function updatePeak(state: PeakState, currentMaxDb: number, dtSec: number): PeakState; // push/hold/fall
```

`Engine` (`src/audio/engine.ts`) — new public fields `analyserL`, `analyserR`.
`StudioApi` (`src/ui/studio-api.ts`) — new `readonly analyserL`/`analyserR`.

### Data shapes

```yaml
ScopeRegion:
  x: number      # px, top-left within the canvas layout box (CSS px, not bitmap)
  y: number
  w: number
  h: number
  tag: mono | left | right   # which analyser feeds this region
  label: string              # '' for mono, 'L'/'R' for stereo

STEREO_SIDE_BY_SIDE_MIN_W: 480   # px; at/above -> side-by-side, below -> stacked
STEREO_GAP: 16                   # px; centre gutter between the side-by-side halves

# half = (w - STEREO_GAP) / 2
# scopeRegions('mono',  w, h)        -> [ {0,0,w,h, mono, ''} ]
# scopeRegions('stereo', >=480, h)   -> [ {0,0,half,h, left,'L'}, {half+GAP,0,half,h, right,'R'} ]  side-by-side + gutter
# scopeRegions('stereo', <480,  h)   -> [ {0,0,w,h/2, left,'L'}, {0,h/2,w,h/2, right,'R'} ]          stacked (small screens)
```

Peak-hold dB scale (REQ-11/12) — a fixed re-labelling of the existing byte bars,
no analyser change:

```yaml
SPECTRUM_DB_TOP: 0       # dB at the top edge of a region (clip)
SPECTRUM_DB_RANGE: 70    # dB to the bottom edge (matches the analyser's -100..-30 byte range)
PEAK_DECAY_DB_PER_SEC: ~3  # tuned by ear to feel "real slow"; single tunable constant
PEAK_HOLD_SEC: ~1.5        # plateau the line is pinned at a new max before it falls

# byteToDisplayDb(b) = SPECTRUM_DB_TOP - SPECTRUM_DB_RANGE * (1 - b/255)
#   byteToDisplayDb(255) -> 0      byteToDisplayDb(0) -> -70      byteToDisplayDb(128) -> ~-34.9
# dbToFrac(db)      = clamp01((db - SPECTRUM_DB_TOP + SPECTRUM_DB_RANGE) / SPECTRUM_DB_RANGE)
#   line y = r.y + r.h - dbToFrac(peakDb) * (r.h - 2)   (same vertical scale as the bars)
# updatePeak({db,holdS}, cur, dt):
#   cur >= db        -> { db: cur, holdS: PEAK_HOLD_SEC }      (snap up, re-arm hold)
#   holdS - dt > 0   -> { db,      holdS: holdS - dt }         (pinned; line steady)
#   else             -> { db: decayPeak(db,cur,dt), holdS: 0 } (slow fall, floor = cur)

# Per-Channel held state: peakDb (init -Infinity) + peakHoldS (init 0);
#   dataset mirror el.dataset.peak/peakL/peakR (1 dp); dB label centred in each region.
```

### Layer touchpoints & ordering

- **`Engine` constructor** builds the analyser tap. Replace the single
  `masterComp.output → analyser → master` link with a lossless split→merge so all
  three analysers are pulled (see Visual aids):
  `masterComp.output → splitter` ; `splitter[0] → analyserL`, `splitter[1] →
  analyserR` ; `analyserL → merger[0]`, `analyserR → merger[1]` ; `merger →
  analyser → master → destination`. `analyserL/R` are configured (fftSize 2048,
  smoothing 0.2) before use. `ChannelSplitterNode`/`ChannelMergerNode` are created
  with 2 ports.
- **`main.ts`** passes the concrete `Engine` (which now structurally satisfies the
  widened `StudioApi`) to `mountApp`; `window.__synth.engine` therefore exposes
  `analyserL`/`analyserR` (DEV only) for E2E assertions.
- **`app.ts` `buildBottom`** constructs `new Scope({ mono: engine.analyser, left:
  engine.analyserL, right: engine.analyserR }, { fps: PERF_PROFILES[resolveTier()].fps })`,
  returns the scope so `mountApp` can bind a live `setFps` hook (perf-mode), and adds the
  `scope-channels-toggle` button beside the existing `scope-toggle`.
- **`help-content.ts`** `scope` topic text mentions the Mono/Stereo split and the
  peak-hold (click to reset). CSS for the new button lives in `layout.module.css`
  (style-exempt from SDD).
- **Sizing / redraw cost (REQ-16)** — the constructor creates a `ResizeObserver` on
  the canvas that, on resize, reads `clientWidth`/`clientHeight` + `devicePixelRatio`
  and resizes the bitmap (`el.width`/`el.height`) only when it changes, caching the
  CSS size + dpr. `draw()`/`syncSize()` read those cached values — never the live
  layout — so the rAF loop forces no reflow. `mirrorPeak` writes a `dataset` key only
  when its `toFixed(1)` value changes; `clearPeakDataset` runs on Wave/Mono-Stereo/
  reset transitions (not per frame) and is a no-op when already clear. The observer is
  `disconnect()`ed in `destroy()`. No `ResizeObserver` (jsdom) → measure-on-draw
  fallback. The canvas CSS bezel (radial-gradient background + inset box-shadow) lives
  on the static `.scopeWrap`, not the animated canvas, so it is not re-rastered each
  frame.
- **`Scope.drawSpectrum`** owns the peak-hold (v2): after the existing
  `getByteFrequencyData` read it takes the max byte over the same visible bins,
  converts with `byteToDisplayDb`, updates `channel.peakDb` via `decayPeak` (from a
  clamped inter-frame `dt`), then draws the dashed line + dB label and mirrors the
  value onto `el.dataset`. The constructor binds a `click` listener on `el` →
  `resetPeak()` (removed in `destroy`). No `engine.ts`/`app.ts` change — the peak
  line, label and reset are entirely inside the component; the toggle buttons already
  sit outside the canvas.

### Persistence

**None.** Both scope toggles (Wave/Spectrum and Mono/Stereo) **and** the peak-hold
state are transient, held in the component/closure — deliberately *not* in
`ParamBus`, presets, or `SongFile` (a visualiser preference, or a held peak, is not
part of a sound or a song). Every boot starts at **Wave + Mono** with no held peak.

## Visual aids

Analyser tap after the change (lossless split→merge keeps everything in the live
path; the mono `analyser` reads the merged signal exactly as before):

```
masterComp.output → splitter ─[0:L]→ analyserL ─→ merger[0] ┐
                            └─[1:R]→ analyserR ─→ merger[1] ┴→ analyser → master → destination
```

Stereo panel layout — responsive on panel width:

```
 wide panel (w >= 480): side-by-side+gap   small panel (w < 480): stacked
┌───────────┐ gap ┌───────────┐          ┌───────────────────────────┐
│ L ∿∿∿∿∿∿  │ <-> │ R ∿∿∿∿∿∿  │          │ L  ∿∿∿∿∿∿∿∿∿∿∿∿∿∿  (top)   │
│   ∿∿∿∿∿∿  │     │   ∿∿∿∿∿∿  │          ├───────────────────────────┤
└───────────┘     └───────────┘          │ R  ∿∿∿∿∿∿∿∿∿∿∿∿∿∿ (bottom) │
                                         └───────────────────────────┘
```

Web Audio nodes (built-in): `AnalyserNode`, `ChannelSplitterNode`,
`ChannelMergerNode`. No new libraries.

## Scenarios (BDD)

```gherkin
Scenario: Mono is the default channel layout
  Given the app has booted and audio is running
  Then the scope channels toggle reads "Mono"
  And the scope draws a single full-panel trace
# pinned by: tests/ui/scope-regions.test.ts, e2e/scope.spec.ts

Scenario: Stereo on a wide panel splits side-by-side with a centre gutter
  Given a panel width of 600 (>= 480)
  When scopeRegions('stereo', 600, 120) is computed
  Then it returns two equal full-height halves of width (600 - STEREO_GAP)/2
  And a STEREO_GAP-wide gap sits dead centre between them
  And the left region is tagged 'left' labelled 'L', the right 'right' labelled 'R'
# pinned by: tests/ui/scope-regions.test.ts

Scenario: Stereo on a small screen stacks (L top, R bottom)
  Given a panel width of 360 (< 480)
  When scopeRegions('stereo', 360, 120) is computed
  Then it returns two equal full-width, half-height regions tiling the panel
  And the top region is tagged 'left' labelled 'L', the bottom 'right' labelled 'R'
# pinned by: tests/ui/scope-regions.test.ts

Scenario: The channels toggle flips Mono <-> Stereo independently of Wave/Spectrum
  Given the app has booted
  When the user clicks the scope channels toggle
  Then its label becomes "Stereo"
  And the Wave/Spectrum toggle still reads its own independent label
  When the user clicks it again
  Then its label returns to "Mono"
# pinned by: e2e/scope.spec.ts

Scenario: Engine exposes working left and right analysers tapped pre-master
  Given the audio engine is running
  Then window.__synth.engine.analyserL and analyserR are distinct AnalyserNodes
  And each differs from the mono analyser
  And getByteTimeDomainData fills a buffer of length fftSize on each
# pinned by: e2e/scope.spec.ts

Scenario: Stereo requested without per-channel analysers stays mono (defensive)
  Given a Scope built with only a mono analyser
  When setChannels('stereo') is called
  Then scopeRegions reflects mono and no error is thrown
# pinned by: tests/ui/scope-regions.test.ts

Scenario: The dB scale re-labels the top of the graph as 0 dB
  Given the peak-hold dB helpers
  When byteToDisplayDb is evaluated
  Then byte 255 maps to 0 dB, byte 0 maps to -70 dB, and byte 128 to about -35 dB
  And dbToFrac is its inverse clamped to [0,1]
# pinned by: tests/ui/scope-regions.test.ts

Scenario: A taller bar pushes the held peak up, pins it, then it falls slowly
  Given a held peak and a current spectrum maximum
  When updatePeak is applied each frame
  Then a current maximum above the held value snaps it up and re-arms PEAK_HOLD_SEC
  And while the hold plateau has time left the held value stays pinned (no decay)
  And once the plateau elapses it falls by PEAK_DECAY_DB_PER_SEC * dt, never below the current max
# pinned by: tests/ui/scope-regions.test.ts

Scenario: The peak-hold line shows only in Spectrum and reads a dB value
  Given the app has booted and audio is running
  When the user switches the scope to Spectrum and plays sound
  Then the canvas exposes a numeric dataset.peak that rises toward 0 dB
  And switching back to Wave clears the peak readout
# pinned by: e2e/scope.spec.ts

Scenario: Clicking the graph resets the peak-hold
  Given the scope is in Spectrum view with a held peak
  When the user clicks the graph (not the toggle buttons)
  Then resetPeak clears the held value and the dataset mirror
  And clicking the Wave/Spectrum or Mono/Stereo buttons does not reset it
# pinned by: tests/ui/scope-regions.test.ts, e2e/scope.spec.ts

Scenario: The redraw loop performs no per-frame layout read or DOM write (REQ-16)
  Given the scope is running and the canvas size is unchanged
  When successive animation frames draw
  Then the bitmap size is taken from the ResizeObserver-cached CSS box, not clientWidth
  And the dataset peak mirror is written only on a frame where its value changed
  And no canvas attribute is mutated on a steady frame
# pinned by: design contract (REQ-16); dataset observability via e2e/scope.spec.ts
```

## Tests & verification

- Unit: `tests/ui/scope-regions.test.ts` — pure `scopeRegions` geometry (mono single
  region; stereo two stacked halves tiling the panel; tags/labels); the peak-hold
  helpers `byteToDisplayDb`/`dbToFrac`/`decayPeak`; and `Scope.resetPeak()` clearing
  the dataset mirror — `npm test`.
- E2E: `e2e/scope.spec.ts` — default "Mono", toggle to "Stereo" and back,
  orthogonality with Wave/Spectrum, the `analyserL`/`analyserR` data path via
  `window.__synth.engine`, and the Spectrum peak readout rising with sound +
  click-to-reset (`canvas.dataset.peak`) — `npm run e2e`.
- Typecheck: `npm run typecheck`.
- Dev-bridge assertions: `window.__synth.engine.analyserL` (DEV only); peak readout
  via the canvas `dataset.peak`/`peakL`/`peakR`.

## Open questions / future

- Stereo orientation is **responsive**: side-by-side on wide panels (the L↔R
  spatial mental model reads naturally), stacked (dual-trace) on small screens where
  two side-by-side traces would each be too narrow. `STEREO_SIDE_BY_SIDE_MIN_W`
  (480 px) is the single tunable threshold, decided from the canvas width so it
  tracks actual available space rather than the viewport.
- A future **goniometer / Lissajous** (X-Y L-vs-R) view could reuse `analyserL/R`;
  out of scope here.
