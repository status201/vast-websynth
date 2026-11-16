# Scope Spectrum (the level and frequency readout)

```yaml
id: scope-spectrum
status: implemented
version: 1
owner: status201
related:
  - scope                             # the component; channels, layout, Wave, resize
  - performance-mode                  # the perf tier's fftSize and peak-hold rate
  - equalizer                         # the zones the EQ's graph shares
source:
  - src/ui/components/scope.ts
  - src/ui/components/scope-math.ts   # log mapping, ticks, column binning, zones, peak hold
  - src/ui/components/scope-render.ts
  - src/ui/components/canvas-text.ts  # haloText
```

## Background / Why

The [scope](scope.md)'s **Spectrum** view is the honest level and frequency
readout. A peak-hold line marks the loudest level reached, with the top of the graph
reading 0 dB. The axis is **logarithmic** over 20 Hz – 20 kHz, as every audio
analyser's is, so the bands a mix is judged by (mud 100–200 Hz, boxy 300–500, nasal
800–1 k, harsh 4–6 k) are areas you can point at; a tick scale, an opt-in Zones
overlay and a hover readout name them. A log axis magnifies the bass bins'
coarseness, so the renderer interpolates where columns outnumber bins.

## Requirements

- **REQ-spectrum-draws-a-peak-hold** — In **Spectrum** view each region draws a
  **peak-hold** indicator: a dotted horizontal line at the highest level
  reached, with the level printed in dB beside it (right-aligned at the line).
  The peak is held **per channel** (mono = one line; stereo = an independent
  line in each of L and R). Wave view draws no line and does **not** update the
  held peak (it is frozen while in Wave, resumed on return to Spectrum).

- **REQ-zero-db-is-the-top-of-the-graph** — The displayed dB scale is **0 dB at
  the top of the graph** down to `-SPECTRUM_DB_RANGE` (−70 dB) at the bottom,
  computed by a pure `byteToDisplayDb(byte)` that re-labels the analyser's
  default byte range. **Bar heights are unchanged** — no analyser/`engine.ts`
  change; only the dB *label* and the line's vertical position derive from this
  scale. `dbToFrac(db)` is the inverse, clamped to `[0,1]`, used to place the
  line on the same vertical scale as the bars (so it rides on top of the tallest
  visible bar). The dB text turns the red accent as the peak approaches 0 dB
  (clip).

- **REQ-a-taller-bar-pins-the-peak** — A taller bar pushes the held value up
  instantly and **pins** it for `PEAK_HOLD_SEC` (a hold plateau, so the max is
  readable); after the plateau elapses the held peak **falls very slowly** at
  `PEAK_DECAY_DB_PER_SEC`, never below the current bar. All timing is frame-rate
  independent from a clamped inter-frame `dt` (the clamp guards the long gap
  after the tab was hidden), so it feels identical at any target fps (e.g.
  15/30/60, set by perf-mode). The pure update is `updatePeak(state,
  currentMaxDb, dtSec)` (composing `decayPeak` for the fall); `state` is the
  per-channel `{ db, holdS }`.

- **REQ-clicking-the-graph-resets-the-peak** — **Clicking the graph resets** the
  peak (every channel back to `-Infinity`, re-acquired on the next frame). The
  click listener is on the canvas element itself; the
  `scope-toggle`/`scope-channels-toggle` buttons are siblings of the canvas (not
  children), so clicking a button never resets the peak — satisfying "anywhere
  but the buttons" with no `stopPropagation`.

- **REQ-peak-hold-obeys-the-perf-tier** — Performance scaling
  (REQ-the-scope-drop-shadow-is-dropped) applies to the peak-hold too: it is
  cheap (one line + one label per region) and draws with no drop-shadow like the
  bars; while the tab is hidden the loop is paused, so the held value neither
  decays nor updates.

- **REQ-the-frequency-axis-is-logarithmic** — **The Spectrum's frequency
  axis is logarithmic** over a fixed `SPECTRUM_F_MIN`…`SPECTRUM_F_MAX` (20 Hz…20
  kHz), replacing the linear bin-index mapping and its `0.6 × binCount` cutoff.
  The mapping is the pure, canvas-free `freqToFrac(hz)` (and its inverse
  `fracToFreq`), so it is unit-testable and is the **single** definition every
  consumer uses — bars, ticks, zones and the hover cursor all read positions
  from it, and none of them may recompute a position of their own.
  `SPECTRUM_F_MAX` is clamped to the analyser's Nyquist, so a 44.1 kHz context
  simply shows a little less at the top rather than addressing bins that do not
  exist. **Wave view is unaffected** — it is a time-domain trace and has no
  frequency axis.

- **REQ-bars-are-drawn-per-pixel-column** — **Bars are drawn per pixel
  column, not per bin**, because a log axis maps the two ends of the spectrum in
  opposite directions: in the treble many bins fall in one column, in the bass
  one bin spans many columns. A column covering **one or more whole bins** takes
  the **maximum** over them (a peak must never be averaged away); a column
  **narrower than a bin** takes a **linear interpolation** between the two
  neighbouring bins at its centre frequency, which is what turns the bass from
  three fat plateaus into a curve. The per-column bin boundaries are precomputed
  into a **cached** `Float32Array` keyed by `(cols, fftSize, sampleRate)` and
  invalidated in exactly the three places the gradient cache already is —
  `measure()`, `setFftSize()` and `contextrestored` — so the redraw loop
  allocates nothing (REQ-no-per-frame-layout-read, `runtime-performance`
  REQ-scope-renderers-are-rect-scoped). The peak-hold's `maxByte` (REQ-spectrum-draws-a-peak-hold/REQ-zero-db-is-the-top-of-the-graph)
  keeps coming from **raw bins**, never from an interpolated value, over the
  whole visible band up to `SPECTRUM_F_MAX`: "the loudest **visible** bar".

- **REQ-the-scale-is-a-permanent-ruler** — **The scale is a permanent
  bottom ruler**: a short vertical tick at each of `SPECTRUM_TICKS_HZ` (100,
  500, 1 k, 5 k, 10 k) rising from the region's bottom edge, with the frequency
  printed above it (`formatHz`: `100`, `500`, `1k`, `5k`, `10k`). Labels are
  centred on their tick, clamped to stay inside the plot, and a tick whose label
  would **collide** with its neighbour on a narrow region is **dropped** — from
  the middle of the set outwards, so the ends of the scale survive longest.
  Collision is decided from an **estimated** text width (`TICK_CHAR_W`, 6 px per
  character at the component's 10 px monospace), never `ctx.measureText`: the
  lifecycle suite drives a proxy 2D context whose methods all return
  `undefined`, so a `measureText(...).width` read throws there.

- **REQ-a-zones-toggle** — **A `Zones` toggle**
  (`data-testid="scope-zones-toggle"`) shades and names the four problem bands
  of `SPECTRUM_ZONES` — MUD 100–200, BOXY 300–500, NASAL 800–1000, HARSH
  4000–6000 Hz. It is **Spectrum-only**: the button is `hidden` in Wave, where
  the bands would be meaningless, so the panel gains no permanent fourth
  control. Bands draw *behind* the bars and their names *in front*, inset from
  the region top so they clear the two corner overlay buttons; names are dropped
  on a region too narrow to hold them while the bands themselves stay. Default
  **off**, and — like every other view mode here — held in memory only (see
  Persistence). The button sits **bottom-right**, the last corner free of
  chrome, and the plot **reserves nothing for it** — bars, ruler and peak line
  all run the full width of the region. The 10 kHz label lands at ≈90 % of the
  width whatever the panel size, so on a narrow panel (and on a stereo half) it
  goes **behind** the button. That is deliberate: the first cut of this feature
  reserved a 64 px gutter on every region to protect that one label, which cost
  every panel a dead strip and put an 80 px hole down the middle of side-by-side
  stereo. Losing the top label on small layouts is much cheaper than paying
  width everywhere — the other four ticks, the bands and the cursor readout all
  still say where you are.

- **REQ-every-drawn-string-gets-a-halo** — **Every string the component
  draws gets a dark halo**: a `strokeText` outline under the `fillText`, via one
  shared helper.
  - That helper is `haloText` in `ui/components/canvas-text.ts`, shared with the
    EQ graph ([equalizer](equalizer.md) REQ-the-graph-computes-from-bus-values)
    draws the same small mono labels over the same kind of saturated fill, and
    a copy would drift the first time either was tuned. It sets `lineWidth`,
    `lineJoin`, `strokeStyle` and `fillStyle` without restoring them — a
    `save`/`restore` pair per label was measurable in this loop — so the
    `textAlign` invariant below is unchanged and still the caller's to keep. This covers the
  new tick, zone and cursor text *and retrofits* the two labels that predate it —
  the `L`/`R` channel tags (REQ-scope-renderers-are-rect-scoped) and the peak-dB readout (REQ-spectrum-draws-a-peak-hold) — which sit on
  top of bars bright enough to swallow them. It is an outline rather than a
  `shadowBlur`: omnidirectional, crisper at 10 px, and it does not reintroduce
  canvas shadows to a component that removed them for cost (REQ-the-scope-drop-shadow-is-dropped). The helper must
  preserve the existing `textAlign` invariant — `drawLabel` sets no alignment and
  relies on `drawPeak` having `restore()`d its own (REQ-scope-renderers-are-rect-scoped), so any caller that
  changes alignment stays inside its own `save()`/`restore()`.

- **REQ-hovering-reads-out-a-frequency** — **Hovering the Spectrum reads
  out a frequency**: a thin vertical line at the pointer with `fracToFreq`
  printed beside it (`437 Hz`), so the scale is a measuring tool rather than
  five fixed reference points. Three constraints make it free: the listeners are
  **mode-scoped** (attached on entering Spectrum, detached on leaving and in
  `destroy()`, per REQ-the-resize-obeys-the-cost-contract's rule); the handler
  reads `offsetX`/`offsetY`, which are already canvas-relative, so it forces
  **no layout** the way a `getBoundingClientRect()` would; and it stores two
  numbers while the existing rAF loop does the drawing. Only `pointerType ===
  'mouse'` arms it, so a touch drag cannot strand a cursor line on screen.
  Clicking still resets the peak-hold (REQ-clicking-the-graph-resets-the-peak) —
  unchanged, but now easier to do by accident while reading the cursor, which is
  a deliberate acceptance, not an oversight.

## Technical design

### Gesture inventory — the Spectrum canvas

The canvas owes an inventory too; the Zones button is a plain button and does not.

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| hover (mouse) | vertical cursor line + the frequency under it (REQ-hovering-reads-out-a-frequency) | every DAW analyser; a scope's cursor |
| click / tap | reset the peak-hold — **unchanged** (REQ-clicking-the-graph-resets-the-peak) | v2 |
| drag | — nothing; there is no selection or zoom to make | — |
| long-press | — | — |
| touch move | — deliberately inert: hover has no touch equivalent, and a stranded cursor line reads as a bug | — |
| wheel | — the page scrolls here (same call the resize handle makes) | — |
| right-click | — | — |
| `Delete` / `⌫` | — nothing to delete | — |

Every row has one outcome and no hidden state, so ADR-014 law 2 holds. The touch
row is the one real deviation: the readout is genuinely mouse-only. The Zones
overlay is what carries the same information to a touch device, which is why it is
a **button** rather than a second hover affordance.

**Discoverability.** The tick scale is always on, so the axis explains itself; the
`Zones` button appears the moment you switch to Spectrum and names what it does;
the cursor is the one thing you have to find by moving the mouse, and the `scope`
help topic says so. No tour step.

### Contract / public interface

Exported from `scope-math.ts` (re-exported by `scope.ts`); `Scope.resetPeak()` and
`setZones()` are on the [scope](scope.md) contract.

```ts
// Pure, exported, canvas-free — the log frequency axis (REQ-the-frequency-axis-is-logarithmic):
const SPECTRUM_F_MIN = 20;        // Hz at the left edge of the plot
const SPECTRUM_F_MAX = 20000;     // Hz at the right edge, clamped to Nyquist at read time
const SPECTRUM_TICKS_HZ: readonly number[];   // [100, 500, 1000, 5000, 10000]
const SPECTRUM_ZONES: readonly SpectrumZone[]; // MUD / BOXY / NASAL / HARSH
interface SpectrumZone { from: number; to: number; name: string; }
interface SpectrumTick { hz: number; x: number; label: string; }

function freqToFrac(hz: number, fMax?: number): number;   // log position 0..1, clamped
function fracToFreq(frac: number, fMax?: number): number; // inverse — the hover readout
function formatHz(hz: number): string;                    // 100 -> '100', 1000 -> '1k', 437 -> '437 Hz'
function visibleTicks(regionW: number, fMax?: number): SpectrumTick[]; // collision-pruned
function columnBinEdges(cols: number, fftSize: number, sampleRate: number): Float32Array;

// Pure, exported, canvas-free — the peak-hold dB math (REQ-zero-db-is-the-top-of-the-graph/REQ-a-taller-bar-pins-the-peak):
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

### Data shapes

Peak-hold dB scale (REQ-zero-db-is-the-top-of-the-graph/REQ-a-taller-bar-pins-the-peak) — a fixed re-labelling of the existing byte bars,
no analyser change:

```yaml
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

Log frequency axis (REQ-the-frequency-axis-is-logarithmic) — one mapping, four consumers:

```yaml
SPECTRUM_COL_W: 3         # px per drawn column (the bar loop's step)
TICK_CHAR_W: 6            # px per char at 10px monospace — the measureText-free estimate
ZONE_NAME_MIN_W: 300      # px of region width below which zone NAMES drop (bands stay)
SPECTRUM_TICKS_HZ: [100, 500, 1000, 5000, 10000]
SPECTRUM_ZONES:
  - { from:  100, to:  200, name: MUD }
  - { from:  300, to:  500, name: BOXY }
  - { from:  800, to: 1000, name: NASAL }
  - { from: 4000, to: 6000, name: HARSH }

# freqToFrac(hz) = clamp01( log(hz/F_MIN) / log(F_MAX/F_MIN) )
# fracToFreq(f)  = F_MIN * (F_MAX/F_MIN) ** clamp01(f)          # exact inverse
#   x = r.x + freqToFrac(hz) * r.w           # the plot IS the region: no gutter
#
# columnBinEdges(cols, fftSize, sampleRate)[c] = fractional bin index at column c's
#   left edge = fracToFreq(c/cols) * fftSize / sampleRate ; length cols+1, monotonic.
#   span = edges[c+1] - edges[c]
#     span >= 1  -> byte = max over bins floor(edges[c]) .. ceil(edges[c+1])-1   (treble)
#     span <  1  -> byte = lerp between the two bins around the column centre     (bass)
#   maxByte for the peak-hold comes from the RAW bins visited, never the lerp.
```

### Visual aid

The Spectrum region — the ruler is permanent and runs the full width,
the shaded bands are the opt-in `Zones` overlay, and the button simply sits on top
of the far right of the scale where the panel is too narrow to keep them apart:

```
┌───────────────────────────────────────────────────────────────────────┐
│[Mono]                                                      [Spectrum] │
│            ░MUD░       ░BOXY░    ▓N▓             ░HARSH░              │
│ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ -6.2 dB ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
│        ▁▃▅█▇▅▃▂▁▂▃▂▁ ▁▂▃▂▁      ▏437 Hz   ▁▂▁      ▁▂▃▂▁              │
│ L      ╵          ╵         ╵           ╵          ╵         [Zones]  │
│       100        500       1k           5k       10k ↑                │
└───────────────────────────────────────────────────────────────────────┘
   20Hz ─────────────── log frequency ──────────────── 20kHz
                                     ▏= the hover cursor (mouse only)
        ↑ the one label the button can cover — accepted, see REQ-a-zones-toggle
```

## Scenarios (BDD)

```gherkin
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

Scenario: The frequency axis is logarithmic, so every octave gets equal width
  Given the log axis helpers
  When freqToFrac is evaluated across the range
  Then 20 Hz maps to 0 and 20 kHz maps to 1
  And 200 Hz sits the same distance from 100 Hz as 2 kHz does from 1 kHz
  And a frequency outside the range clamps rather than escaping [0,1]
  And fracToFreq round-trips freqToFrac to within floating-point tolerance
# pinned by: tests/ui/scope-axis.test.ts

Scenario: The tick labels land where the requested frequencies are (REQ-the-scale-is-a-permanent-ruler)
  Given a plot 636px wide
  When visibleTicks is computed
  Then it returns ticks for 100, 500, 1k, 5k and 10k
  And each tick's x equals freqToFrac(hz) * the region width
  And every label stays inside the plot rather than overflowing its edges
# pinned by: tests/ui/scope-axis.test.ts

Scenario: A narrow region drops crowded ticks instead of overlapping them (edge)
  Given a plot too narrow to hold all five labels apart
  When visibleTicks is computed
  Then colliding ticks are dropped from the middle of the set outwards
  And the ticks that remain do not overlap each other
  And the width test uses an estimate, never ctx.measureText
# pinned by: tests/ui/scope-axis.test.ts

Scenario: Column-to-bin mapping covers the range at every perf tier (REQ-bars-are-drawn-per-pixel-column)
  Given columnBinEdges for fftSize 256, 512 and 1024
  Then the edges are monotonically increasing and span F_MIN to the clamped F_MAX
  And no edge addresses a bin beyond frequencyBinCount
  And the array is cached, so a second call with the same key allocates nothing new
# pinned by: tests/ui/scope-axis.test.ts

Scenario: The bass is interpolated and the treble is peak-held (REQ-bars-are-drawn-per-pixel-column)
  Given a column narrower than one FFT bin
  Then its level is interpolated between the two neighbouring bins
  Given a column spanning several bins
  Then its level is the maximum over them, so a narrow peak is never averaged away
# pinned by: tests/ui/scope-axis.test.ts

Scenario: The peak-hold is unaffected by the log rewrite (regression)
  Given the scope is in Spectrum view with signal present
  Then the held dB still comes from the raw bin maximum, not an interpolated column
  And dataset.peak still rises toward 0 dB and still clears on click
# pinned by: tests/ui/scope-axis.test.ts, e2e/scope.spec.ts

Scenario: Zones are Spectrum-only and default off (REQ-a-zones-toggle)
  Given the app has booted in Wave view
  Then the scope zones toggle is hidden
  When the user switches to Spectrum
  Then the toggle is visible and the overlay is off
  When the user clicks it
  Then the four problem bands are shown and the canvas reports zones on
  When the user switches back to Wave
  Then the toggle is hidden again
# pinned by: e2e/scope.spec.ts

Scenario: The plot spans the whole region, button or no button (REQ-a-zones-toggle)
  Given any region width
  When the ruler is laid out
  Then the ticks run edge to edge, with no width reserved for the Zones button
  And on a panel narrow enough for the two to meet, the 10k label sits behind it
  And that is accepted: reserving the width cost every panel a dead strip
# pinned by: tests/ui/scope-axis.test.ts

Scenario: Hovering the spectrum reads out the frequency under the pointer (REQ-hovering-reads-out-a-frequency)
  Given the scope is in Spectrum view
  When the mouse moves over the graph
  Then a cursor line is drawn there and the canvas reports the frequency under it
  When the pointer leaves
  Then the readout is cleared
# pinned by: tests/ui/scope-axis.test.ts, e2e/scope.spec.ts

Scenario: A touch drag never strands a cursor line (edge)
  Given the scope is in Spectrum view on a touch device
  When a pointermove of type touch reaches the canvas
  Then no cursor is recorded and nothing is drawn for it
# pinned by: tests/ui/scope-axis.test.ts

Scenario: The hover listeners exist only while Spectrum is showing (REQ-hovering-reads-out-a-frequency/REQ-the-resize-obeys-the-cost-contract)
  Given the scope is in Wave view
  Then the canvas holds no pointermove listener
  When the user switches to Spectrum and back
  Then the listener is added on entry and removed on exit
  And destroy() leaves none behind
# pinned by: tests/ui/scope-axis.test.ts

Scenario: Every drawn label is haloed so a bright bar cannot swallow it (REQ-every-drawn-string-gets-a-halo)
  Given a spectrum bar reaching full height behind a label
  When the tick, zone, cursor, peak-dB and L/R labels are drawn
  Then each is stroked in a dark outline before it is filled
  And the alignment a caller changed is restored, so the L/R label still draws left-aligned
# pinned by: tests/ui/scope-axis.test.ts (stroke order); appearance by eye (ADR-010)
```

## Tests & verification

- `tests/ui/scope-axis.test.ts` (log mapping, ticks, column binning, halo order,
  hover listeners), `tests/ui/scope-regions.test.ts` (peak hold); `e2e/scope.spec.ts`
  (the peak mirrors).
- **By eye (ADR-010):** sweep the cutoff and watch the bars track the ticks (a
  440 Hz fundamental sits just left of 500); the bass reads as a curve, every label
  survives a full-height bar, Zones sit where the ear says; repeat on the weak tier
  (fftSize 256).

## Open questions / future

- **Bass resolution is bounded by `fftSize`, and the log axis magnifies that.** At
  the weak tier (256) a bin is 187.5 Hz wide, so REQ-bars-are-drawn-per-pixel-column
  draws a smooth ramp where there is no detail. A Spectrum-only `fftSize` would
  fight [performance-mode](performance-mode.md) REQ-analyser-fft-size-follows-the-tier;
  it is open, not decided.
- **`SPECTRUM_F_MAX` is 20 kHz, so the top of the plot is usually empty** — chosen
  because "20 Hz to 20 kHz" is a range the user can check. Revisit if the empty
  right edge annoys more than the round number helps.
- **Zones are not persisted**, like the other view toggles. A habit of leaving it
  on would move it into the device-scoped workspace family beside the panel height.
