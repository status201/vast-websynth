# Scope — Wave / Spectrum live visualizer

```yaml
id: scope
status: implemented
version: 22
owner: status201
related:
  - architecture
  - performance-mode
  - compressor
  - runtime-performance
  - audio-lifecycle
  - debug-panel                       # the Scope row that reports this panel's liveness
source:
  - src/ui/components/scope.ts
  - src/state/debug-sources.ts        # setScopeStatsSource — the Debug panel's reader
  - src/ui/components/about-debug.ts  # the "Scope" row
  - src/ui/components/canvas-text.ts  # haloText, hoisted out of this component
  - src/ui/components/resize-handle.ts
  - src/state/scope-height.ts
  - src/audio/engine.ts
  - src/ui/studio-api.ts
  - src/ui/shell/scope-panel.ts
  - src/ui/shell/bottom.ts
  - src/ui/styles/bottom.module.css
  - src/ui/onboarding/help-content.ts
```

## Background / Why

The bottom panel hosts a live oscilloscope / analyser (`Scope`), tapped
**pre-master** so the display does not follow the master-volume knob. Two
independent toggles pick what it shows: **Wave / Spectrum** (what is drawn) and
**Mono / Stereo** (how many channels — Stereo splits the panel into LEFT and
RIGHT, side by side or stacked, REQ-the-split-layout-is-pure). The synth bus can
carry a stereo image (which inserts create one is [effects](effects.md)'s to say,
not this spec's), and a mono down-mix hides it.

The rest of the design follows from what each view is for:

- **Spectrum** is the honest level and frequency readout. A peak-hold line marks
  the loudest level reached, with the top of the graph reading 0 dB
  (REQ-spectrum-draws-a-peak-hold/REQ-zero-db-is-the-top-of-the-graph). The axis
  is **logarithmic** over 20 Hz – 20 kHz, as every audio analyser's is, so the
  bands a mix is judged by (mud 100–200 Hz, boxy 300–500, nasal 800–1 k, harsh
  4–6 k) are areas you can point at; a tick scale, an opt-in Zones overlay and a
  hover readout name them. A log axis magnifies the bass bins' coarseness, so the
  renderer interpolates where columns outnumber bins
  (REQ-bars-are-drawn-per-pixel-column).
- **Wave** is for watching. It **auto-ranges** with a fractional exponent, so a
  quiet song is legible and a loud one still reads louder; it is not a calibrated
  meter (REQ-the-wave-view-auto-gains).
- The panel is **resizable** from its top edge, 130–260 px, by resizing the grid
  row rather than the canvas, so the wheel strips that share the row grow with it
  and `Scope` needs no size logic of its own (REQ-a-scope-resize-handle).
- **It must never stop painting for good.** A frozen or black panel with every
  toggle dead is the failure mode this component has hit twice on real devices
  (a backgrounded Android tablet; a desktop GPU-process crash). The rules are
  REQ-the-redraw-loop-can-always-restart, REQ-every-public-mutator-is-a-recovery-path,
  REQ-a-watchdog-restarts-a-stalled-loop and
  REQ-a-lost-context-is-escaped-by-replacing-the-canvas: no state may exist from
  which it cannot start drawing again, and a timer that checks pixels are still
  arriving replaces guessing which event the platform will send.

## Requirements

- **REQ-two-extra-per-channel-analysers** — The `Engine` exposes two extra
  per-channel analysers, `analyserL` (left) and `analyserR` (right), tapped at
  the **same point** as the existing mono `analyser` (post-`masterComp`,
  pre-`master`), so all three stay independent of the volume knob. The audio
  path to `master`/destination is unchanged (lossless split→merge), so every
  analyser sits in the live render path and is pulled.
- **REQ-all-analysers-share-fft-settings** — All three analysers use the
  **same** `fftSize` and `smoothingTimeConstant` (0.2), so per-channel buffers
  are uniform and the three views are visually comparable. `fftSize` is
  **perf-tier-dependent** (v4/v5, halved in v6): **256 / 512 / 1024** for weak /
  medium / strong (`EngineOptions.analyserFftSize` seeds the boot value, default
  1024; from `PERF_PROFILES` — see [performance-mode](performance-mode.md)
  REQ-analyser-fft-size-follows-the-tier). Because `AnalyserNode.fftSize` is
  settable at runtime, a tier change applies it **live** via
  `Scope.setFftSize(n)`, which sets `fftSize` on all three analysers and
  **reallocates** each channel's time-domain + frequency read buffers to match —
  no reload, exactly like `setFps`.
- **REQ-studio-api-exposes-both-channels** — `StudioApi` exposes
  `analyserL`/`analyserR` alongside `analyser` (the UI's narrow view of the
  engine, ADR-009).
- **REQ-scope-has-a-channel-mode** — `Scope` gains a channel mode `'mono' |
  'stereo'` (default `'mono'`, the pre-existing view) set via `setChannels(c)`,
  orthogonal to the existing
  `setMode('wave'|'spectrum')`. State persists only in memory (see Persistence).
- **REQ-the-split-layout-is-pure** — The split layout is **pure** and
  unit-testable without a canvas: `scopeRegions(channels, w, h)` returns the
  sub-rectangles + channel tag/label to draw into. Mono → one full-panel region.
  Stereo → two equal regions with a **responsive** orientation decided from the
  panel width: **side-by-side** (left = left half, right = right half) when `w
  >= STEREO_SIDE_BY_SIDE_MIN_W` (480 CSS px); **stacked** (left = top, right =
  bottom) below it — so small screens stack and don't cram two narrow traces
  side-by-side. The side-by-side halves are inset by a centre **`STEREO_GAP`**
  (16 px) gutter so the two channels read as separate traces, not one continuous
  display; the stacked halves tile edge-to-edge.
- **REQ-scope-renderers-are-rect-scoped** — The Wave and Spectrum renderers are
  **rect-scoped** (draw into a given region), so a single renderer serves 1
  region (mono) or 2 (stereo) — DRY, no per-mode duplication. Each region draws
  its own mid-line; stereo regions show a faint `L`/`R` label. The label is
  anchored at its region's **bottom-left** (`textBaseline: 'bottom'`, inset 4
  px), **not** the top-left: the two corner overlay buttons — Mono/Stereo (`top:
  8px; left: 8px`) and Wave/Spectrum (`top: 8px; right: 8px`) — sit flush with
  the canvas corners inside the 8 px-padded `.scopeWrap`, so a top-anchored `L`
  is completely hidden behind the Mono/Stereo button. The bottom edge is the
  only quadrant free of overlay chrome in **both** stereo layouts (side-by-side
  and stacked). This is the same dodge the peak-dB readout already makes by
  centring horizontally.
- **REQ-a-channels-toggle-button** — A second toggle button
  (`data-testid="scope-channels-toggle"`) sits in the scope panel, labelled
  `Mono`/`Stereo`, defaulting to `Mono`. Clicking it flips `Scope.setChannels`
  and its own label, without disturbing the Wave/Spectrum toggle.
- **REQ-the-scope-drop-shadow-is-dropped** — Performance scaling: the canvas
  **drop-shadow is dropped for all modes** (a baseline cost cut), and the redraw
  rate is a configurable target fps (`ScopeOptions.fps`, default 60; `setFps`
  live) — perf-mode drives 15/30/60. The loop always pauses while the tab is
  hidden. Applies equally to the mono and stereo renderers. See
  `performance-mode`.
- **REQ-stereo-on-a-mono-scope-falls-back** — Defensive fallback: if
  `setChannels('stereo')` is called on a `Scope` built without left/right
  analysers, it stays in mono (no throw).
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
- **REQ-the-scope-canvas-carries-a-testid** — For test observability the canvas
  carries `data-testid="scope-canvas"` and the held dB is mirrored onto its
  `dataset`: `el.dataset.peak` (mono) / `el.dataset.peakL` / `el.dataset.peakR`
  (stereo), formatted to one decimal; cleared in Wave view, on a Mono/Stereo
  switch, and on reset. The mirror is written **only when the formatted value
  changes** (not every frame), so a steady scope performs no per-frame attribute
  write — the dataset still always reflects the latest displayed value. (Lets
  E2E assert without a 2D context.)
- **REQ-no-per-frame-layout-read** (performance) — The redraw loop must do **no
  per-frame layout read and no per-frame DOM mutation**: the canvas bitmap is
  sized from a `ResizeObserver` (cached CSS box + backing scale), not by reading
  `clientWidth`/`clientHeight` inside the rAF loop, and the `dataset` mirror
  only writes on change (REQ-the-scope-canvas-carries-a-testid). So an animated
  scope costs a single composited canvas raster, not a full page
  layout/style/layerize/paint each frame. Environments without `ResizeObserver`
  (jsdom under unit test) fall back to measuring on draw — behaviour unchanged.
  The spectrum bar gradient is likewise **cached per region** (keyed by the
  region's `y`/`h`, invalidated on resize) instead of `createLinearGradient`
  allocating every frame — no per-frame canvas-object allocation on the steady
  path.
- **REQ-the-wave-view-auto-gains** (v8) — The **Wave** view applies an
  **auto-gain** so quiet material still draws a readable trace. The gain is a
  **partial** normalization — `clamp((WAVE_TARGET_PEAK / peak) **
  WAVE_NORM_STRENGTH, 1, WAVE_MAX_GAIN)`, computed by the pure
  `waveGainTarget(peak)`. `WAVE_NORM_STRENGTH < 1` is what keeps loud louder
  than soft: in dB the drawn peak is `STRENGTH·TARGET_dB +
  (1−STRENGTH)·peak_dB`, i.e. a monotonic *compression* of the level scale,
  never a flattening. Three bounds make it safe: the gain floor of **1** means a
  clipping signal is never *shrunk*; the `WAVE_MAX_GAIN` ceiling and a **silence
  gate** (`peak <= WAVE_SILENCE_PEAK` → gain snaps to 1) together mean silence
  draws a flat line instead of blooming into amplified noise. The scaled sample
  is **clamped to `[-1, 1]`** before it maps to Y, so an overshoot can never
  paint outside its region (there is no `ctx.clip()`; in stacked stereo an
  unclamped trace would bleed into the neighbouring channel). Smoothing is a
  frame-rate-independent one-pole (`updateWaveGain(gain, peak, dtSec)`) with
  **asymmetric** time constants: the gain **falls fast** (`WAVE_GAIN_FALL_TAU`)
  when the signal gets louder, so a transient cannot fly off-screen, and **rises
  slowly** (`WAVE_GAIN_RISE_TAU`) when it gets quieter, so the trace does not
  pump. `dtSec <= 0` (the first frame after the tab-hidden pause, where `lastTs`
  is reset) leaves the gain untouched. The gain is **shared across L and R**,
  not held per channel: one `waveGain` on the `Scope`, driven by the maximum
  peak over every region drawn this frame. Per-channel gains would blow a
  hard-panned quiet side up to match the loud one and destroy the stereo image
  the Stereo view exists to show. The gain is **frozen while in Spectrum** (it
  is neither updated nor decayed), the mirror image of how the peak-hold freezes
  in Wave (REQ-spectrum-draws-a-peak-hold).
- **REQ-the-wave-read-is-float** (v8) — The Wave read is **float**:
  `getFloatTimeDomainData` into a per-channel `Float32Array` (reallocated by
  `setFftSize` like the byte buffers). `getByteTimeDomainData`
  quantises to 1/128, so a −25 dBFS signal occupies ~7 of 128 steps and any real
  boost would paint a visible staircase; float also lets the `[-1,1]` clamp see
  genuine above-0-dBFS excursions that a byte read hard-limits to 0/255. The auto-gain must add **no measurable per-frame cost**
  (REQ-no-per-frame-layout-read, `runtime-performance`): the peak scan is
  **fused into the existing draw loop** — the frame draws with the *previous*
  frame's peak (one frame of lag, ~16 ms, imperceptible) while accumulating this
  frame's peak in the same pass. So the added cost is one `abs` + one compare
  per sample inside a loop already issuing `lineTo`, plus one `Math.exp` per
  frame, and **no allocation on the steady path**. The applied gain is mirrored
  to `el.dataset.waveGain` under the same change-only-write rule as the peak
  mirror (REQ-the-scope-canvas-carries-a-testid), so a steady scope still
  performs no per-frame attribute write.
- **REQ-the-wave-trace-is-triggered** (v19) — **The Wave trace is triggered.**
  Each frame drew the analyser buffer from index 0, wherever in the waveform's
  cycle that happened to fall, so a steady tone slid sideways and never read like
  a scope. Now each channel's trace starts at the **first rising zero crossing**
  (`prev < 0 <= cur`) within the buffer's first quarter
  (`findRisingZeroCrossing`), and draws a fixed **three quarters** of the buffer
  from there. Fixed, so the time span never jumps between frames: the trace is
  the same width whether a trigger was found or not. When none is found — a note
  whose period is longer than the search quarter (below `sampleRate / (fftSize/4)`,
  ~190 Hz at the strong tier's 1024), or silence — the trace starts at 0 and
  free-runs exactly as before; triggering is an improvement where it can be had,
  never a gate. The search is one pass over at most a quarter of the samples the
  draw loop already visits, and allocates nothing (REQ-the-wave-read-is-float's
  cost rule). The auto-gain peak is taken over the drawn samples.

- **REQ-a-scope-resize-handle** (v11) — A **resize handle**
  (`data-testid="scope-resize-handle"`) sits on the scope panel's **top edge**.
  Dragging it vertically resizes the shared bottom row between
  `SCOPE_H_MIN` (130 px, the original fixed height) and `SCOPE_H_MAX` (260 px,
  exactly twice it), by writing a single CSS custom property `--scope-h` on the
  `.bottom` element from script (`style.setProperty` — the shipped CSP allows
  that, but not a `style="…"` attribute in markup); the scope row (`.bottomTop`) takes
  `min-height: var(--scope-h, 130px)`, so the **default is still expressed in CSS** and the
  app renders identically when nothing has been dragged and when storage is
  unavailable. Because the wheel strips share that row, they resize with the
  scope — this is a consequence of the row, not separate code.
  - The EQUALIZER section's graph reads `--scope-h` too
    ([equalizer](equalizer.md) REQ-the-eq-page-mirrors-the-scope-row): it borrows
    the *number*, not the row, so the two panels cannot be resized out of alignment.
  - **The dragged height is the scope's minimum, not its height.** While
    the keyboard below is at its cap (keyboard-range.md
    REQ-key-height-follows-key-width) the spare height comes to the scope
    (REQ-spare-height-goes-to-the-scope there), so the scope can stand taller
    than `--scope-h`, and a drag smaller shows nothing until that spare is used
    up. The EQ graph keeps the dragged height. With no spare (every default layout
    up to 2560px wide) the drag sets the height directly.
  The handle is a **sibling of the canvas**
  (appended to `.scopeWrap`, like the two corner toggle buttons), so a press on it can
  never reach the canvas `click` listener and reset the peak-hold (REQ-clicking-the-graph-resets-the-peak) — the same
  structural dodge, with no `stopPropagation`. `Scope` itself is **not modified**: the
  height change reaches it through its existing `ResizeObserver` (REQ-no-per-frame-layout-read).
  The handle's **appearance and interaction** come from its own CSS module; its
  **position and size** come from a consumer class in `bottom.module.css`
  (`.scopeResize`), the same split `.scopeToggle` already makes against
  `switch.module.css` — only the consumer knows what the handle must sit clear of.
  That width shrinks to fit and drops out below 350 px; see the Gesture inventory.
- **REQ-the-scope-height-persists** (v11) — The height **persists**,
  device-scoped, under `websynth.ui.scope.height` (see Persistence). It is read
  once at boot and applied **before** first paint so there is no visible jump,
  clamped on read so a hand-edited or stale value can never produce an unusable
  panel, and written **once on pointer release** — never per pointer move.
- **REQ-the-resize-obeys-the-cost-contract** (v11, performance) — The resize
  must not violate the app-wide cost contract
  ([runtime-performance](runtime-performance.md)). Three obligations: the
  `pointermove`/`pointerup` listeners are **window-scoped and gesture-scoped** —
  attached on `pointerdown`, removed on `pointerup`/`pointercancel` *and* in
  `destroy()` (REQ-studio-api-exposes-both-channels there); the layout is
  **measured once** on `pointerdown` and the stroke reuses it; and the
  `--scope-h` write is **rAF-coalesced** — a move stores the pending value and
  schedules at most one frame, so a fast drag costs one style write and one
  bitmap re-allocation **per frame**, not per event. At rest the handle holds no
  global listener and costs nothing.

- **REQ-the-redraw-loop-can-always-restart** (v12) — **The redraw loop can
  always be restarted.** `start()` cancels any pending frame and re-arms
  unconditionally, never early-returning on `running`: with `running` latched
  true and no frame queued, an early return makes every restart path a no-op.
  Restarting an already-running loop is harmless — the
  pending frame is cancelled first, so there is never more than one callback in
  flight.
- **REQ-one-bad-frame-cannot-end-the-loop** (v12) — **One bad frame cannot end
  the loop.** The next `requestAnimationFrame` is issued **before** `draw()`,
  not after. A throw is therefore not swallowed — it still reaches the console,
  which is where a bug like this needs to be visible — but the following frame
  is already queued when it happens, so the scope keeps drawing.
- **REQ-canvas-context-loss-is-survivable** (v12) — **Canvas context loss is
  survivable.** The canvas listens for `contextlost` → `preventDefault()`
  (**without which the browser never restores it**) then `stop()`; and
  `contextrestored` → drop the cached gradients, zero the cached bitmap size so
  `measure()` re-allocates, then `start()`. Both listeners are removed in
  `destroy()`. This is the failure a backgrounded tab hits when the OS reclaims
  its canvas backing store, and the only one of the three that is not the app's
  own fault.
- **REQ-becoming-visible-re-measures** (v12) — **Becoming visible re-measures.**
  The `visibilitychange` → visible path, and a `pageshow` (a bfcache restore can
  reach a visible page without a `visibilitychange`), both call `measure()`
  before `start()`. `ResizeObserver` does not fire for a box that comes back the
  size it left, and `measure()` already refuses a 0×0 read
  (REQ-no-per-frame-layout-read), so this is free and cannot make things worse.
  `setFps` likewise rejects a non-finite or non-positive rate — `frameInterval`
  of `NaN`/`Infinity` is a loop that spins and never draws, which is the same
  black panel by a fourth route.

- **REQ-the-frequency-axis-is-logarithmic** (v13) — **The Spectrum's frequency
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
- **REQ-bars-are-drawn-per-pixel-column** (v13) — **Bars are drawn per pixel
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
- **REQ-the-scale-is-a-permanent-ruler** (v13) — **The scale is a permanent
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
- **REQ-a-zones-toggle** (v13) — **A `Zones` toggle**
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
- **REQ-every-drawn-string-gets-a-halo** (v13) — **Every string the component
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
- **REQ-hovering-reads-out-a-frequency** (v13) — **Hovering the Spectrum reads
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

- **REQ-the-scope-proves-it-is-painting** (v16) — **The scope proves it is
  painting, not merely looping.** Two timestamps: `lastFrameTs`, written at the
  top of **every** rAF callback before the fps throttle, and `lastPaintTs`,
  written once `draw()` has returned without throwing. Nothing infers liveness
  from `running` — v12 already learned that flag latches `true` over a dead
  chain. `lastPaintTs` proves only that `syncSize()` passed and nothing threw;
  it is **not** evidence of pixels, and nothing here asks it to be. Its job is
  to separate a dead frame chain from a live one drawing into no layout box.
- **REQ-a-watchdog-restarts-a-stalled-loop** (v16) — **A ~1 Hz watchdog restarts
  a stalled loop.** A `window.setInterval` inside the component checks — and
  **only while `document.hidden` is false** — whether the last frame is older
  than `SCOPE_STALL_MS`; if it is, it `measure()`s and `start()`s (a sleeping
  loop is not a stall: REQ-a-scope-with-nothing-to-show-sleeps). Frames
  arriving while paints are not means the layout box is gone, not the loop: that
  escalates to `measure()` alone and never to a canvas rebuild, because a panel
  with no box has nothing to draw and reports `no box` instead. The timer
  returns on its first line while hidden, so
  [performance-mode](performance-mode.md) REQ-scope-fps-and-fft-apply-live and
  [runtime-performance](runtime-performance.md)
  REQ-visibility-gating-is-for-pixels-not-sound's pause-while-hidden rule stay
  literally true; it allocates nothing, reads no layout, and `destroy()` clears
  it. The gate reads `document.hidden` rather than `visibilityState` so it
  agrees with `onVisibility` and stays drivable from one stub in the unit suite.
- **REQ-waiting-for-contextrestored-is-bounded** (v16) — **Waiting for a
  `contextrestored` is bounded.** `contextlost` still `preventDefault()`s and
  still stops the loop (REQ-canvas-context-loss-is-survivable) — but it now
  records *when*, and if no `contextrestored` arrives within
  `CONTEXT_RESTORE_MS` the component stops waiting and recovers itself. An
  unbounded wait is a dead panel no toggle can undo, and needs no backgrounding:
  a GPU-process crash fires `contextlost` on a visible, foregrounded tab. Stopping is also how you stop giving a browser that restores lazily any
  reason to restore.
- **REQ-a-lost-context-is-escaped-by-replacing-the-canvas** (v16) — **A provably
  lost context is escaped by replacing the canvas, not by asking for another
  one.** `getContext('2d')` on a canvas whose context is lost returns *that same
  lost context*, so a fresh `<canvas>` is the only guaranteed escape. The
  rebuild takes the new context **first** and abandons the swap if that returns
  `null` — never trade a live canvas for one that cannot be drawn into — then
  copies the class and `data-testid`, `replaceWith`s in the same DOM slot (which
  keeps it above `.scopeScreen` and below the three corner buttons — slot order
  is load-bearing), moves the `click`, `contextlost`/`contextrestored` and
  mode-scoped hover registrations and the `ResizeObserver`, drops every cache
  **and every dataset mirror** — REQ-the-scope-canvas-carries-a-testid's
  change-only write would otherwise leave the replacement's readouts blank for
  the life of the page — then `measure()`s and `start()`s. When the canvas has
  no parent (the unit suite) the field is still swapped, because `replaceWith`
  on an unparented node is a silent no-op. `el` becomes a getter over a mutable
  field and stays read-only to callers. The rebuild is **rate-limited** to one
  per `REBUILD_MIN_GAP_MS`: a machine whose GPU process is really gone answers
  `isContextLost()` truthfully every time it is asked, and an unbounded watchdog
  would mint a fresh canvas and a fresh bitmap every second for the life of the
  page — turning the recovery into a leak. Recovery stays automatic when the GPU
  returns; only the retry rate is bounded.
- **REQ-scope-detection-is-free-or-it-does-not-happen** (v16) — **Detection is
  free or it does not happen.** A lost context is found by
  `ctx.isContextLost?.()` and by REQ-waiting-for-contextrestored-is-bounded's
  unanswered `contextlost` — **never by reading pixels back.** `getImageData`
  forces a GPU→CPU readback with a pipeline flush onto the thread the audio
  control path shares, and browsers de-accelerate a canvas that is read back
  often, so the probe would cost the panel its frame rate to ask whether it has
  one. It is also circular: a lost 2D context makes every method a no-op rather
  than throwing, so the fill the probe reads back is the very thing under test.
  Where a browser offers neither signal the scope does not guess — it keeps
  restarting the loop, which is free, and the Debug row
  (REQ-the-panel-says-whether-it-is-drawing) is what says so.
- **REQ-every-public-mutator-is-a-recovery-path** (v16) — **Every public mutator
  is a recovery path, and costs nothing when there is nothing to recover.**
  `setMode`, `setChannels`, `setZones`, `resetPeak`, `setFps` and `setFftSize`
  each call `ensureLive()`, as do a **non-capturing** `window` `focus` listener
  and the Page Lifecycle `resume` on `document` — a renderer frozen and resumed
  while already visible fires neither `visibilitychange` nor `pageshow`. The
  user's instinct on a dead scope is to poke a button, and that instinct must
  work. `ensureLive()` returns immediately when frames are arriving and the
  context is sound, so poking a *healthy* scope forces no layout read and
  re-arms no frame. The focus listener must not be registered with `capture`:
  `focus` does not bubble, so a capturing listener would route every knob,
  button and field in the app through here.
- **REQ-the-panel-says-whether-it-is-drawing** (v16) — **The panel says out loud
  whether it is drawing.** `Scope.health` reports drawing/asleep/stalled, the age of
  the last frame and paint, whether there is a layout box, whether the context
  is lost, and the restart/rebuild/loss counters. It reaches the Debug panel
  through `setScopeStatsSource` ([debug-panel](debug-panel.md)
  REQ-the-debug-extension-contract/REQ-an-unbound-row-reads-n-a) and increments
  `data-rebuilds` on the canvas — on change only, per REQ-the-scope-canvas-carries-a-testid/REQ-no-per-frame-layout-read, which here
  means essentially never. A device with no console must still be able to report it.
- **REQ-a-scope-with-nothing-to-show-sleeps** — **The redraw loop sleeps
  while there is nothing to draw.** Once every channel's input has stayed at or
  under `WAVE_SILENCE_PEAK` for `SCOPE_SLEEP_AFTER_MS` (500 ms) and the frame on
  screen has settled (in Spectrum, every peak-hold at the floor; no hover readout
  showing), the loop draws that frame and stops arming `requestAnimationFrame`.
  Asleep, a `SCOPE_WAKE_POLL_MS` (50 ms) timer reads each analyser's time-domain
  data and nothing else: no canvas, no layout, no dataset write. A sample over
  the gate restarts the loop, so a sound's first frame is at most one poll late.
  Every other way in wakes it too and draws: a public mutator
  (REQ-every-public-mutator-is-a-recovery-path), a pointer move, leave or click on
  the canvas, a re-measure, a restored or rebuilt canvas, becoming visible. Sleep
  is a liveness state, not a stall: the watchdog and `ensureLive` leave a sleeping
  loop alone, `health` reports it as `asleep` rather than stalled, and the Debug
  panel's Scope row says so. While hidden the poll is stopped as well, so the
  pause-while-hidden rule is unchanged. Why: a rAF chain is a main-thread frame
  every vsync even when each frame redraws a flat line, so an idle app spent most
  of its main-thread time redrawing silence, and every such frame also restyled
  the play button's composited attract pulse, 60 style recalcs a second that the
  pulse alone never needs ([runtime-performance](runtime-performance.md)).

## Technical design

### Gesture inventory — the resize handle

The [recipe](../recipes/design-an-interaction.md) step-1 artefact for the one new
interactive control this feature adds; the component's generic table is
[resize-handle](resize-handle.md), and this one is the scope's instance of it. Everything else on this panel is a plain
button. `—` is a decision, not an omission.

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| tap / click | — a press that doesn't move leaves the height alone | — |
| drag ↕ | resize the row, clamped `[130, 260]`, live | OS window resize; DAW panel splitters (Ableton, Logic) |
| double-tap | reset to the 130 px default | this app's knobs — double-tap resets to baseline |
| `↑` / `↓` (focused) | ±`SCOPE_H_STEP` (8 px), clamped | ARIA window-splitter pattern |
| `Home` (focused) | reset to the default | same |
| long-press | — | — |
| Shift + drag | — the whole range is 130 px; 1 px per pixel is already fine | — |
| right-click | — | — |
| wheel | — the page scrolls here; hijacking it would fight the scroll | — |
| `Delete` / `⌫` | — nothing to delete | — |

Every row has exactly one outcome and no hidden state, so ADR-014 law 2 holds.
`dblclick` is unreliable on touch, so double-tap is hand-rolled from `pointerdown`
timestamps on a `DOUBLE_TAP_MS` (350 ms) window — the recipe's documented gotcha,
and the same window the grid gestures use.

**Discoverability** (the recipe's step-4 triple): the handle carries a `title`
naming the gesture ("Drag to resize the scope — double-click to reset"), and the
`scope` help topic mentions it. No tour step — resizing is not on the primary path,
and the grip is self-evident at the panel edge.

**Accessibility.** The handle is the ARIA window-splitter: `role="separator"`,
`aria-orientation="horizontal"`, `aria-label`, `tabindex="0"`, and
`aria-valuenow`/`aria-valuemin`/`aria-valuemax` kept in sync with the height — which
is also why the keyboard rows above exist rather than being a `—`.

**One deliberate ADR-014 deviation.** Law 6 asks for ≥44 px hit targets. The grip is
a ≤48×5 px pill inside a 64×16 px transparent hit box, not 44 px tall: a 44 px target
would blanket the top third of the trace on a 112 px panel — the very thing this
feature exists to protect. The shortfall is safe *vertically* because the handle sits
at the panel's top edge with nothing else hittable within 16 px, so an imprecise touch
lands on the handle or on inert canvas, never on the wrong control.

**Horizontally** the handle threads between the two corner toggles (~127 px of the
panel's width together), so the hit box is `min(64px, calc(100% - 140px))`: full
width where there is room, shrinking rather than overlapping where there is not.
Deliberate: don't make it a fixed width, which overlaps the Mono/Stereo button on a
phone. Below **350 px** no hittable grip fits, so the handle is **dropped** rather
than shown unhittable; a stored height still applies.

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

`Scope` (`src/ui/components/scope.ts`):

```ts
type ScopeMode = 'wave' | 'spectrum';
type ScopeChannels = 'mono' | 'stereo';

interface ScopeAnalysers { mono: AnalyserNode; left?: AnalyserNode; right?: AnalyserNode; }
interface ScopeOptions { fps?: number; }  // target redraw rate (default 60); see performance-mode

class Scope {
  get el(): HTMLCanvasElement;          // a getter — REQ-a-lost-context-is-escaped-by-replacing-the-canvas can replace the element underneath
  constructor(analysers: ScopeAnalysers, opts?: ScopeOptions);
  ensureLive(): void;                   // restart if stalled; a no-op when healthy (REQ-every-public-mutator-is-a-recovery-path)
  get health(): ScopeHealth;            // liveness readout for the Debug panel (REQ-the-panel-says-whether-it-is-drawing)
  setMode(m: ScopeMode): void;          // wave | spectrum  (also binds/unbinds the hover listeners)
  setChannels(c: ScopeChannels): void;  // mono | stereo (stereo needs left+right)
  get channelMode(): ScopeChannels;     // effective layout (mono unless stereo set with both)
  resetPeak(): void;                     // clear the spectrum peak-hold (also bound to canvas click)
  setFps(fps: number): void;             // change the target redraw rate live (perf-mode tier switch)
  setFftSize(fftSize: number): void;     // set all three analysers' fftSize live + reallocate read buffers
  setZones(on: boolean): void;           // show/hide the problem-band overlay (REQ-a-zones-toggle)
  get zonesOn(): boolean;
  destroy(): void;
}

// Liveness (REQ-the-scope-proves-it-is-painting and the REQs after it). Exported ms constants, one record, one reader:
const SCOPE_WATCHDOG_MS = 1000;    // how often the watchdog looks; gated on document.hidden
const SCOPE_STALL_MS = 1200;       // no rAF callback for this long => the frame chain is dead
const SCOPE_PAINT_STALL_MS = 1500; // frames but no paints => no layout box (clears 15fps weak tier)
const CONTEXT_RESTORE_MS = 3000;   // a contextrestored that has not come by now is not coming
const REBUILD_MIN_GAP_MS = 5000;   // one canvas rebuild per this, so a dead GPU cannot leak
const SCOPE_SLEEP_AFTER_MS = 500;  // quiet frames for this long => asleep (REQ-a-scope-with-nothing-to-show-sleeps)
const SCOPE_WAKE_POLL_MS = 50;     // a sleeping scope's analyser read: its only work
interface ScopeHealth {
  asleep: boolean; drawing: boolean; frameAgeMs: number; paintAgeMs: number;
  hasBox: boolean; contextLost: boolean;
  restarts: number; rebuilds: number; losses: number;
}

// src/state/debug-sources.ts — the Debug panel's late-bound reader (REQ-the-panel-says-whether-it-is-drawing):
function setScopeStatsSource(fn: () => ScopeHealth): void;
function scopeStats(): ScopeHealth | undefined;   // undefined => the row reads "n/a"

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

// Pure, exported, canvas-free — the split geometry (REQ-the-split-layout-is-pure):
interface ScopeRegion { x: number; y: number; w: number; h: number; tag: 'mono' | 'left' | 'right'; label: string; }
function scopeRegions(channels: ScopeChannels, w: number, h: number): ScopeRegion[];

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

// Pure, exported, canvas-free — the Wave auto-gain (REQ-the-wave-view-auto-gains):
const WAVE_TARGET_PEAK   = 0.9;    // fraction of half-height a fully-normalized trace reaches
const WAVE_NORM_STRENGTH = 0.85;   // 1 = full normalization, 0 = none; <1 keeps loud louder than soft
const WAVE_MAX_GAIN      = 32;     // ceiling, so a noise floor is never blown up
const WAVE_SILENCE_PEAK  = 0.0005; // ~-66 dBFS; at/below this the gain snaps to unity (flat line)
const WAVE_GAIN_FALL_TAU = 0.05;   // s — gain dropping (signal got louder): fast, no overshoot
const WAVE_GAIN_RISE_TAU = 0.6;    // s — gain rising  (signal got quieter): slow, no pumping
function waveGainTarget(peak: number): number;                              // the clamped target gain
function updateWaveGain(gain: number, peak: number, dtSec: number): number; // asymmetric one-pole toward it
```

`Engine` (`src/audio/engine.ts`) has public `analyserL` / `analyserR`, read through
`StudioApi` (`src/ui/studio-api.ts`).

The resize handle is the shared `ResizeHandle` facility — its contract is
[resize-handle](resize-handle.md); the scope uses its default `up` direction with
static bounds and a numeric default.

```ts
// src/state/scope-height.ts — device-scoped workspace pref (same class as perf-mode); stored through state/size-pref.ts
const SCOPE_H_MIN = 130;      // px — the original fixed height, the floor
const SCOPE_H_MAX = 260;      // px — exactly twice it, the ceiling
const SCOPE_H_DEFAULT = 130;  // px — SCOPE_H_MIN; what a fresh boot and a reset give
const SCOPE_H_STEP = 8;       // px — arrow-key increment
function clampScopeHeight(px: number): number;   // NaN / non-finite -> SCOPE_H_DEFAULT
function readScopeHeight(): number;              // clamped; default on miss/garbage/throw
function writeScopeHeight(px: number): void;     // clamped; swallows quota/private-mode
```

### Data shapes

The constants are declared once, in the contract above; these are the formulas and the
values the contract does not carry.

```yaml
STEREO_SIDE_BY_SIDE_MIN_W: 480   # px; at/above -> side-by-side, below -> stacked
STEREO_GAP: 16                   # px; centre gutter between the side-by-side halves

# half = (w - STEREO_GAP) / 2
# scopeRegions('mono',  w, h)        -> [ {0,0,w,h, mono, ''} ]
# scopeRegions('stereo', >=480, h)   -> [ {0,0,half,h, left,'L'}, {half+GAP,0,half,h, right,'R'} ]  side-by-side + gutter
# scopeRegions('stereo', <480,  h)   -> [ {0,0,w,h/2, left,'L'}, {0,h/2,w,h/2, right,'R'} ]          stacked (small screens)
```

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

Wave auto-gain (REQ-the-wave-view-auto-gains/REQ-the-wave-read-is-float) — one gain for the whole display, not per channel:

```yaml

# waveGainTarget(peak):
#   !(peak > WAVE_SILENCE_PEAK) -> 1                       (silence, and NaN, are unity)
#   else clamp((WAVE_TARGET_PEAK / peak) ** WAVE_NORM_STRENGTH, 1, WAVE_MAX_GAIN)
# updateWaveGain(gain, peak, dt):
#   dt <= 0 -> gain                                        (first frame after a pause)
#   target = waveGainTarget(peak)
#   tau    = target < gain ? WAVE_GAIN_FALL_TAU : WAVE_GAIN_RISE_TAU
#   gain + (target - gain) * (1 - exp(-dt / tau))          (frame-rate independent)
# drawn sample: y = midY + clamp(v * gain, -1, 1) * amp    (amp = r.h / 2 - 4)
#
# Scope state: waveGain (init 1) + wavePeak (this-frame max |v| over ALL regions,
#   reset each frame). Dataset mirror el.dataset.waveGain (1 dp), Wave-view only.
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

Panel height (REQ-a-scope-resize-handle/REQ-the-scope-height-persists) — one number, one CSS custom property:

```yaml
DOUBLE_TAP_MS: 350     # ms window for the hand-rolled double-tap

# .bottom  flex column:
#            .bottomTop (wheels 120px | scope 1fr)  flex 1 1 0, min-height var(--scope-h, 130px)
#                                                    <- the resized row; a MINIMUM
#            EQ section                              auto
#            keyboard  flex 1000 1 0, floored at 160px, capped by key width
#                      (keyboard-range.md REQ-key-height-follows-key-width)
# drag: h = clamp(startH + (startY - clientY), MIN, MAX)    # up = taller
# clampScopeHeight(px) = Number.isFinite(px) ? min(max(round(px), MIN), MAX) : DEFAULT
```

### Layer touchpoints & ordering

- **`Engine` constructor** builds the analyser tap as a lossless split→merge so all
  three analysers are pulled: `masterComp.output → splitter` ; `splitter[0] →
  analyserL`, `splitter[1] → analyserR` ; `analyserL/R → merger[0/1]` ; `merger →
  analyser → master → destination` (2-port splitter/merger; the tier's
  `analyserFftSize`, smoothing 0.2). `window.__synth.engine` exposes
  `analyserL`/`analyserR` in DEV for E2E.
- **`shell/scope-panel.ts` `buildScopePanel`** constructs `new Scope({ mono:
  engine.analyser, left: engine.analyserL, right: engine.analyserR }, { fps:
  PERF_PROFILES[resolveTier()].fps })`, appends the overlay buttons
  (`scope-toggle`, `scope-channels-toggle`, `scope-zones-toggle`, the last hidden in
  Wave: `zonesToggle.hidden = isWave`) and the `ResizeHandle` to `.scopeWrap`, sets
  `--scope-h` from `readScopeHeight()` **before** mounting (no first-paint jump), and
  returns the scope and handle so `mountApp` binds `setFps` / `setFftSize` and both
  `destroy()`s.
- **Everything else is inside `scope.ts`** — peak-hold, auto-gain, the log axis and
  its overlays, the liveness sweep — and needs nothing from the audio layer but
  `analyser.context.sampleRate` (read as `?? 48000`, since the unit suites' analyser
  stubs carry no `context`). Deliberate: a change here that edits `engine.ts` or
  `studio-api.ts` has drifted (ADR-001/ADR-009). Inside it:
  - `draw()` updates `waveGain` from the *previous* frame's `wavePeak` before the
    region loop, only in Wave mode (so the gain freezes in Spectrum); `drawWave`
    accumulates `max |v|` in its one per-sample loop;
  - the Spectrum draw order is **midline → zone bands → bars → peak line + dB →
    ticks → zone names → hover cursor → `L`/`R`**, every label haloed
    (REQ-every-drawn-string-gets-a-halo); `setMode` binds and unbinds the hover
    listeners;
  - `attachCanvas` / `detachCanvas` hold the **one** listener list the constructor,
    `destroy()` and `rebuildCanvas()` share, so no listener is added in one place and
    forgotten in another.
- **Sizing (REQ-no-per-frame-layout-read):** a `ResizeObserver` reads the CSS size
  and `backingScale()` (`devicePixelRatio` × the UI scale, no DOM read;
  [ui-scale](ui-scale.md) REQ-canvases-stay-sharp-at-any-scale), resizes the bitmap
  only on change, and caches both. A UI-scale change re-measures once; the rAF
  loop reads the cache (measure-on-draw where there is no observer, as in jsdom).
  The bezel lives on the static `.scopeScreen` underlay, not on the animated canvas.
  `dataset` mirrors are written on change only.
- **Liveness reporting:** `app.ts` binds `setScopeStatsSource(() =>
  bottom.scope.health)` (`state/debug-sources.ts`), read by `about-debug.ts`'s
  `Scope` row on the every-tick tier ([debug-panel](debug-panel.md)
  REQ-debug-refresh-is-tiered-by-row-cost).
- **`help-content.ts`**'s `scope` topic covers Mono/Stereo, the peak reset, Zones,
  the hover readout and the resize handle.

### Persistence

**The panel height, and nothing else.**

| State | Where | Why |
| --- | --- | --- |
| Wave/Spectrum, Mono/Stereo, **Zones**, peak-hold, wave gain | in-memory only | *View* state — what you are looking at right now. Not part of a sound or a song, and cheap to re-pick. Every boot starts at **Wave + Mono + Zones off** with no held peak. |
| Panel height | `localStorage` `websynth.ui.scope.height` | *Workspace* state — how the instrument is arranged on **this** screen. |

A height is not a view mode, it is furniture. It joins the device-scoped
family of `websynth.perf`, `websynth.keyboard.layout` and `websynth.ui.collapsed.*` —
read at boot, written on change, and **equally excluded from `ParamBus`, presets and
`SongFile`**. Loading someone else's song must never rearrange your panels, and a
shared preset must never carry your screen's dimensions.

Stored as an integer count of px (`'186'`). Every read is clamped through
`clampScopeHeight`, so a missing key, a hand-edited value, garbage, or a value left
by a future build with a different range all resolve to something usable instead of
throwing or producing an unusable panel. Writes use the house `try/catch` — private
mode or a full quota costs you the preference, not the app.

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

Panel resize (v11) — one grid track grows, and the wheels ride along because they
share it:

```
       default (--scope-h: 130px)                dragged to the 260px ceiling
  ┌──────┬──────────────────────────┐      ┌──────┬──────────────────────────┐
  │      │        ═══ grip ═══      │      │      │        ═══ grip ═══      │
  │wheels│  scope  ∿∿∿∿∿∿∿∿∿∿  130px│      │wheels│                          │
  │P O M │                          │      │P O M │  scope  ∿∿∿∿∿∿∿∿∿∿  260px│
  ├──────┴──────────────────────────┤      │      │                          │
  │          keyboard  (1fr)        │      │ (taller too — same row)         │
  │                                 │      ├──────┴──────────────────────────┤
  │                                 │      │   keyboard (1fr, floors at 160) │
  └─────────────────────────────────┘      └─────────────────────────────────┘
```

The Spectrum region after v13 — the ruler is permanent and runs the full width,
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

Web Audio nodes (built-in): `AnalyserNode`, `ChannelSplitterNode`,
`ChannelMergerNode`. No new libraries.

## Scenarios (BDD)

```gherkin
Scenario: A steady tone stands still in the Wave view (v19, REQ-the-wave-trace-is-triggered)
  Given a sine whose period fits in a quarter of the analyser buffer, at any phase
  When the trigger point is found
  Then it is the first sample where the signal crosses zero going up
  And the trace drawn from it starts at the same point of the cycle every frame
  Given silence, or a period longer than the search window
  Then no trigger is found and the trace starts at sample 0
# pinned by: tests/ui/scope-trigger.test.ts

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

Scenario: Stereo channel labels clear the corner overlay buttons (regression)
  Given the scope is in Stereo mode
  Then each region's L/R label is drawn at that region's bottom-left, inset 4px
  And neither label is overlapped by the Mono/Stereo button at the canvas top-left
  Nor by the Wave/Spectrum button at the canvas top-right
  And this holds in both the side-by-side and the stacked stereo layout
# pinned by: design contract (REQ-scope-renderers-are-rect-scoped); canvas text is not assertable from the DOM

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

Scenario: The redraw loop performs no per-frame layout read or DOM write (REQ-no-per-frame-layout-read)
  Given the scope is running and the canvas size is unchanged
  When successive animation frames draw
  Then the bitmap size is taken from the ResizeObserver-cached CSS box, not clientWidth
  And the dataset peak mirror is written only on a frame where its value changed
  And no canvas attribute is mutated on a steady frame
# pinned by: design contract (REQ-no-per-frame-layout-read); dataset observability via e2e/scope.spec.ts

Scenario: Quiet material is boosted, but loud still draws taller than soft
  Given the Wave auto-gain
  When waveGainTarget is evaluated across the level range
  Then a peak at or above full scale gets unity gain (a clipping song is never shrunk)
  And a peak at -25 dBFS gets a gain of about 10x, drawing over half the panel height
  And the drawn height (peak * gain) still increases monotonically with the peak
  And the gain never exceeds WAVE_MAX_GAIN
# pinned by: tests/ui/scope-regions.test.ts

Scenario: Silence draws a flat line, not amplified noise
  Given a peak at or below WAVE_SILENCE_PEAK (about -66 dBFS)
  When waveGainTarget is evaluated
  Then the gain is unity, so the trace settles flat instead of blooming
  And a NaN peak is likewise treated as unity
# pinned by: tests/ui/scope-regions.test.ts

Scenario: The gain falls fast and rises slowly, identically at any frame rate
  Given a held wave gain and a new frame peak
  When updateWaveGain is applied each frame
  Then a louder signal (target below the held gain) moves it down quickly
  And a quieter signal (target above the held gain) moves it up slowly, so it does not pump
  And ten 10ms steps land at the same gain as one 100ms step
  And a dt of 0 leaves the gain unchanged
# pinned by: tests/ui/scope-regions.test.ts

Scenario: The applied wave gain is observable and Wave-only
  Given the app has booted and audio is running in Wave view
  Then the canvas exposes a numeric dataset.waveGain of at least 1
  And switching to Spectrum clears it
# pinned by: e2e/scope.spec.ts

Scenario: Dragging the handle upward makes the scope taller
  Given the app has booted with the scope at its default height
  When the user drags the scope resize handle 60px upward
  Then the --scope-h custom property reads 190px
  And the scope canvas is taller than it was
# pinned by: tests/ui/resize-handle.test.ts, e2e/scope.spec.ts

Scenario: The height is clamped to between one and two times the default
  Given the scope resize handle
  When the user drags far past either end of the range
  Then the height stops at SCOPE_H_MIN (130) going down
  And it stops at SCOPE_H_MAX (260) going up, exactly twice the minimum
# pinned by: tests/ui/resize-handle.test.ts

Scenario: The wheel strips grow with the scope (they share the grid row)
  Given the app has booted
  When the scope is dragged to its full height
  Then the PITCH/OCT/MOD strips are taller by the same amount
  And each strip's thumb still tracks its parameter value at the new height
# pinned by: e2e/scope.spec.ts

Scenario: A press that does not move leaves the height alone
  Given the scope is at some height
  When the user presses the handle and releases without moving
  Then the height is unchanged
  And nothing is written to storage
# pinned by: tests/ui/resize-handle.test.ts

Scenario: Double-tapping the handle resets the height
  Given the scope has been dragged away from its default height
  When the user taps the handle twice within DOUBLE_TAP_MS
  Then the height returns to SCOPE_H_DEFAULT
  And the reset is persisted
# pinned by: tests/ui/resize-handle.test.ts

Scenario: The focused handle resizes from the keyboard
  Given the scope resize handle has focus
  When the user presses ArrowUp
  Then the height increases by SCOPE_H_STEP and aria-valuenow follows it
  When the user presses Home
  Then the height returns to SCOPE_H_DEFAULT
# pinned by: tests/ui/resize-handle.test.ts

Scenario: The height survives a reload
  Given the user has dragged the scope taller
  When the app is reloaded
  Then the scope is still at the dragged height
# pinned by: tests/state/scope-height.test.ts, e2e/scope.spec.ts

Scenario: A corrupt or out-of-range stored height falls back to something usable
  Given the stored height is missing, garbage, or outside [130, 260]
  When the app boots
  Then the height resolves to a value within the range
  And no error escapes to the caller
# pinned by: tests/state/scope-height.test.ts

Scenario: Pressing the handle never resets the spectrum peak-hold (regression)
  Given the scope is in Spectrum view with a held peak
  When the user presses the resize handle
  Then the held peak is unchanged
  And this holds because the handle is a sibling of the canvas, not a child (REQ-clicking-the-graph-resets-the-peak)
# pinned by: tests/ui/resize-handle.test.ts

Scenario: The scope comes back after the tab was hidden (v12, regression)
  Given the scope is drawing and the tab is hidden, pausing the loop
  When the tab becomes visible again
  Then the canvas is measured and the loop restarts and draws
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A frame that throws does not kill the loop for good (v12, regression)
  Given the scope is drawing
  When one draw throws
  Then the next animation frame is still delivered and draws
   And a restart after a broken frame chain re-arms rather than early-returning
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A lost canvas context is restored, not left black (v12)
  Given the browser reclaims the canvas backing store and fires contextlost
  Then the event's default is prevented, so the browser will restore it
   And the loop stops until it is restored
  When contextrestored fires
  Then the cached bitmap size and gradients are dropped and the loop draws again
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A nonsense frame rate cannot silently stop the drawing (v12, edge)
  Given a mounted scope
  When setFps is called with 0, a negative number or NaN
  Then the target rate falls back to the default instead of never drawing
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The watchdog restarts a loop the browser stopped delivering (v16, REQ-a-watchdog-restarts-a-stalled-loop)
  Given the scope is drawing and the tab is visible
  When the renderer drops the queued frame with nothing to announce it
   And more than SCOPE_STALL_MS passes
  Then the next watchdog tick measures and restarts the loop, and it draws
   And health.restarts has incremented
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The watchdog does nothing at all while the tab is hidden (v16, REQ-a-watchdog-restarts-a-stalled-loop)
  Given the tab is hidden, so the loop is paused
  When many watchdog ticks pass with the loop stalled
  Then no frame is queued and nothing is drawn
   And the pause performance-mode.md REQ-scope-fps-and-fft-apply-live requires is untouched
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The watchdog leaves a healthy loop completely alone (v16, REQ-a-watchdog-restarts-a-stalled-loop/REQ-every-public-mutator-is-a-recovery-path)
  Given frames are arriving on time
  When several watchdog ticks pass
  Then no frame is cancelled or re-armed and health.restarts is 0
   And a mutator called on that healthy loop cancels nothing either
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: Frames without paints measure rather than rebuild (v16, REQ-a-watchdog-restarts-a-stalled-loop)
  Given the loop is ticking but the canvas reports a 0x0 layout box
  When the paint age passes SCOPE_PAINT_STALL_MS
  Then the watchdog measures, health.hasBox is false, and the canvas is not replaced
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The scope stops waiting for a contextrestored that never comes (v16, REQ-waiting-for-contextrestored-is-bounded)
  Given contextlost fired and its default was prevented, stopping the loop
   And no contextrestored arrives within CONTEXT_RESTORE_MS
  When the next watchdog tick runs
  Then the scope recovers itself instead of waiting forever
   And this needs no visibilitychange, because the page never stopped being visible
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A provably lost context is escaped by replacing the canvas (v16, REQ-a-lost-context-is-escaped-by-replacing-the-canvas)
  Given the 2D context reports isContextLost
  When any control is used, or the watchdog ticks
  Then a fresh canvas replaces the old one in the same DOM slot
   And it carries the class, the testid and every listener the old one had
   And the dataset mirror is cleared, so its readouts appear again
   And health.rebuilds has incremented
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A GPU that never comes back is retried, not rebuilt every second (v16, REQ-a-lost-context-is-escaped-by-replacing-the-canvas)
  Given the context reports itself lost on every ask, as a dead GPU process does
  When several REBUILD_MIN_GAP_MS pass
  Then the canvas is replaced at most once per gap, not once per watchdog tick
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A live canvas is never traded for one that cannot be drawn into (v16, REQ-a-lost-context-is-escaped-by-replacing-the-canvas, edge)
  Given the context is lost and a rebuild is due
  When getContext on the replacement returns null
  Then the swap is abandoned and the existing canvas is kept
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: Every control revives a stalled scope (v16, REQ-every-public-mutator-is-a-recovery-path)
  Given the loop is stalled and the tab is visible
  When any of setMode, setChannels, setZones, resetPeak, setFps or setFftSize is called
  Then the loop is live again and draws
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A window focus and a Page Lifecycle resume both revive it (v16, REQ-every-public-mutator-is-a-recovery-path)
  Given the loop is stalled
  When window fires focus, or document fires resume
  Then the loop is live again
   And a focus on an element inside the app does not reach the handler
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The watchdog dies with the scope (v16, REQ-a-watchdog-restarts-a-stalled-loop)
  Given a mounted scope
  When destroy() is called and the clock runs far past several watchdog periods
  Then no frame is queued, nothing throws, and no restart is counted
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The panel reports what it is doing (v16, REQ-the-panel-says-whether-it-is-drawing)
  Given a mounted scope
  Then health reports drawing, the frame and paint ages, the box and the context
   And the restart, rebuild and loss counters rise with the events that cause them
   And data-rebuilds is written only when it increments
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The frequency axis is logarithmic, so every octave gets equal width (v13)
  Given the log axis helpers
  When freqToFrac is evaluated across the range
  Then 20 Hz maps to 0 and 20 kHz maps to 1
  And 200 Hz sits the same distance from 100 Hz as 2 kHz does from 1 kHz
  And a frequency outside the range clamps rather than escaping [0,1]
  And fracToFreq round-trips freqToFrac to within floating-point tolerance
# pinned by: tests/ui/scope-axis.test.ts

Scenario: The tick labels land where the requested frequencies are (v13, REQ-the-scale-is-a-permanent-ruler)
  Given a plot 636px wide
  When visibleTicks is computed
  Then it returns ticks for 100, 500, 1k, 5k and 10k
  And each tick's x equals freqToFrac(hz) * the region width
  And every label stays inside the plot rather than overflowing its edges
# pinned by: tests/ui/scope-axis.test.ts

Scenario: A narrow region drops crowded ticks instead of overlapping them (v13, edge)
  Given a plot too narrow to hold all five labels apart
  When visibleTicks is computed
  Then colliding ticks are dropped from the middle of the set outwards
  And the ticks that remain do not overlap each other
  And the width test uses an estimate, never ctx.measureText
# pinned by: tests/ui/scope-axis.test.ts

Scenario: Column-to-bin mapping covers the range at every perf tier (v13, REQ-bars-are-drawn-per-pixel-column)
  Given columnBinEdges for fftSize 256, 512 and 1024
  Then the edges are monotonically increasing and span F_MIN to the clamped F_MAX
  And no edge addresses a bin beyond frequencyBinCount
  And the array is cached, so a second call with the same key allocates nothing new
# pinned by: tests/ui/scope-axis.test.ts

Scenario: The bass is interpolated and the treble is peak-held (v13, REQ-bars-are-drawn-per-pixel-column)
  Given a column narrower than one FFT bin
  Then its level is interpolated between the two neighbouring bins
  Given a column spanning several bins
  Then its level is the maximum over them, so a narrow peak is never averaged away
# pinned by: tests/ui/scope-axis.test.ts

Scenario: The peak-hold is unaffected by the log rewrite (v13, regression)
  Given the scope is in Spectrum view with signal present
  Then the held dB still comes from the raw bin maximum, not an interpolated column
  And dataset.peak still rises toward 0 dB and still clears on click
# pinned by: tests/ui/scope-axis.test.ts, e2e/scope.spec.ts

Scenario: Zones are Spectrum-only and default off (v13, REQ-a-zones-toggle)
  Given the app has booted in Wave view
  Then the scope zones toggle is hidden
  When the user switches to Spectrum
  Then the toggle is visible and the overlay is off
  When the user clicks it
  Then the four problem bands are shown and the canvas reports zones on
  When the user switches back to Wave
  Then the toggle is hidden again
# pinned by: e2e/scope.spec.ts

Scenario: The plot spans the whole region, button or no button (v13, REQ-a-zones-toggle)
  Given any region width
  When the ruler is laid out
  Then the ticks run edge to edge, with no width reserved for the Zones button
  And on a panel narrow enough for the two to meet, the 10k label sits behind it
  And that is accepted: reserving the width cost every panel a dead strip
# pinned by: tests/ui/scope-axis.test.ts

Scenario: Hovering the spectrum reads out the frequency under the pointer (v13, REQ-hovering-reads-out-a-frequency)
  Given the scope is in Spectrum view
  When the mouse moves over the graph
  Then a cursor line is drawn there and the canvas reports the frequency under it
  When the pointer leaves
  Then the readout is cleared
# pinned by: tests/ui/scope-axis.test.ts, e2e/scope.spec.ts

Scenario: A touch drag never strands a cursor line (v13, edge)
  Given the scope is in Spectrum view on a touch device
  When a pointermove of type touch reaches the canvas
  Then no cursor is recorded and nothing is drawn for it
# pinned by: tests/ui/scope-axis.test.ts

Scenario: The hover listeners exist only while Spectrum is showing (v13, REQ-hovering-reads-out-a-frequency/REQ-the-resize-obeys-the-cost-contract)
  Given the scope is in Wave view
  Then the canvas holds no pointermove listener
  When the user switches to Spectrum and back
  Then the listener is added on entry and removed on exit
  And destroy() leaves none behind
# pinned by: tests/ui/scope-axis.test.ts

Scenario: Every drawn label is haloed so a bright bar cannot swallow it (v13, REQ-every-drawn-string-gets-a-halo)
  Given a spectrum bar reaching full height behind a label
  When the tick, zone, cursor, peak-dB and L/R labels are drawn
  Then each is stroked in a dark outline before it is filled
  And the alignment a caller changed is restored, so the L/R label still draws left-aligned
# pinned by: tests/ui/scope-axis.test.ts (stroke order); appearance by eye (ADR-010)

Scenario: A silent scope stops arming frames (REQ-a-scope-with-nothing-to-show-sleeps)
  Given the Wave view and an input at or under WAVE_SILENCE_PEAK
  When SCOPE_SLEEP_AFTER_MS passes
  Then it draws once more and requests no further animation frame
  And only the wake poll runs, reading the analysers and touching no canvas
# pinned by: tests/ui/scope-sleep.test.ts

Scenario: A sound wakes it within one poll (REQ-a-scope-with-nothing-to-show-sleeps)
  Given a sleeping scope
  When a poll reads a sample over WAVE_SILENCE_PEAK
  Then the loop restarts and draws on the next frame
# pinned by: tests/ui/scope-sleep.test.ts

Scenario: The Spectrum stays awake until its peak-holds have fallen (REQ-a-scope-with-nothing-to-show-sleeps, edge)
  Given the Spectrum view with a held peak above the floor and a silent input
  Then the loop keeps drawing while the peak decays, and sleeps once every hold is at the floor
# pinned by: tests/ui/scope-sleep.test.ts

Scenario: Any control or pointer wakes it and it redraws (REQ-a-scope-with-nothing-to-show-sleeps)
  Given a sleeping scope
  When the mode or channel toggle, the fps or FFT setter, a pointer over the canvas or a click acts on it
  Then a frame is drawn showing the change
# pinned by: tests/ui/scope-sleep.test.ts

Scenario: A sleeping loop is not a stall (REQ-a-scope-with-nothing-to-show-sleeps, REQ-a-watchdog-restarts-a-stalled-loop)
  Given a scope that has slept for longer than SCOPE_STALL_MS
  When the watchdog ticks and ensureLive is called
  Then neither restarts it, and health reports asleep, not stalled
  And while the page is hidden no wake poll runs
# pinned by: tests/ui/scope-sleep.test.ts

Scenario: An idle app costs almost nothing on the main thread (REQ-a-scope-with-nothing-to-show-sleeps, perf)
  Given the app open, the transport stopped and nothing sounding
  When npm run bench:perf measures idle
  Then main-thread busy falls to near zero against a before run
# pinned by: npm run bench:perf --compare (a before/after pair)

Scenario: The handle holds no global listener at rest (REQ-the-resize-obeys-the-cost-contract)
  Given a mounted resize handle that is not being dragged
  Then it has registered no window pointermove listener
  When a drag starts and then ends
  Then the listeners are attached for the stroke and detached on release
  And destroy() detaches them and cancels any pending frame
# pinned by: tests/ui/resize-handle.test.ts
```

## Tests & verification

- Unit: `tests/ui/scope-regions.test.ts` (geometry, peak-hold, auto-gain helpers),
  `tests/ui/scope-trigger.test.ts`, `tests/ui/scope-axis.test.ts` (log mapping,
  ticks, column binning, halo order, hover listeners),
  `tests/ui/scope-lifecycle.test.ts` (one case per recovery route, and the watchdog
  under fake timers; its frame scheduler and recording context are
  `tests/ui/scope-harness.ts`), `tests/ui/scope-sleep.test.ts` (sleep, wake, and
  that a sleeping loop is no stall), `tests/state/scope-height.test.ts`,
  `tests/ui/resize-handle.test.ts` (one case per gesture-inventory row) — `npm test`.
- E2E: `e2e/scope.spec.ts` (Mono/Stereo, the L/R data path, the peak and gain
  mirrors, the resize surviving a reload, an unanswered `contextlost`, and a real
  backgrounding) — `npm run e2e`.
- Dev bridge: `window.__synth.engine.analyserL`; the canvas `dataset` (`peak`,
  `peakL`, `peakR`, `waveGain`, `zones`, `cursorHz`, `rebuilds`); the Debug panel's
  `debug-scope` row.
- **By eye (ADR-010)** — the views are a *look*, so a green suite does not verify
  them:
  - **Wave auto-gain:** a quiet demo must draw a readable trace (about half the
    panel) and a loud one visibly taller; silence settles flat, a transient from
    silence stays inside its region, Stereo keeps a hard-panned L/R difference.
    `WAVE_NORM_STRENGTH` and `WAVE_MAX_GAIN` are the two knobs.
  - **Resize:** at the ceiling the trace and bars scale cleanly, the L/R labels
    clear in both layouts, the bezel frames the canvas, the wheel strips grow with
    it, and the keyboard gives up its slack before the page scrolls. At phone width
    the grip clears both corner buttons.
  - **Axis:** sweep the cutoff and watch the bars track the ticks (a 440 Hz
    fundamental sits just left of 500); the bass reads as a curve, every label
    survives a full-height bar, Zones sit where the ear says; repeat on the weak
    tier (fftSize 256).
  - **Liveness**, in Firefox and Chrome with a demo playing: stub
    `requestAnimationFrame` away, watch `debug-scope` go `stalled`, restore it and
    see the trace return untouched within about a second; dispatch an unanswered
    `contextlost` and see the panel return within ~4 s with `rebuilds` at `1`; while
    stalled, each of Wave/Spectrum, Mono/Stereo and Zones must revive it; background
    the tab (on Android under Battery Saver, through recents, with a rotation) and
    check the frame age on return reads large.

## Open questions / future

- Stereo orientation is **responsive**: side-by-side on wide panels (the L↔R
  spatial mental model reads naturally), stacked (dual-trace) on small screens where
  two side-by-side traces would each be too narrow. `STEREO_SIDE_BY_SIDE_MIN_W`
  (480 px) is the single tunable threshold, decided from the canvas width so it
  tracks actual available space rather than the viewport.
- A future **goniometer / Lissajous** (X-Y L-vs-R) view could reuse `analyserL/R`;
  out of scope here.
- The Wave auto-gain is deliberately **not exposed** — no third overlay button
  on an already three-cornered panel, and no persisted preference *of its own*. If a
  "1×" (calibrated) escape hatch is ever wanted, `WAVE_NORM_STRENGTH = 0` is already
  the whole implementation of it; the open question is only where the toggle would
  live (view state is not persisted; the height is workspace state, see Persistence).
- `ResizeHandle` is written generically — it writes a CSS custom property on a
  target and knows nothing about scopes — but it is specced here rather than in its
  own facility spec because the scope is its only consumer. A **second** consumer
  (resizable floating windows are the obvious candidate) is what would earn it a spec
  of its own, and the lift would be a move, not a rewrite.
- The 2× ceiling is a **fixed** 260 px, not a fraction of the viewport. On a very tall
  display there is headroom left unused; on a very short one the ceiling is reachable
  only by pushing the page into a scroll. A viewport-relative ceiling was rejected as
  a rule you cannot see: the handle would stop at a different place on every screen,
  and "twice as tall" is a promise the user can check.
- **Bass resolution is bounded by `fftSize`, and the log axis magnifies that.**
  At the weak tier (256) a bin is 187.5 Hz wide and covers roughly the
  display's first third, so REQ-bars-are-drawn-per-pixel-column's interpolation draws a smooth ramp where there
  is no real detail to draw — honest, but not informative. Raising `fftSize` only
  while in Spectrum would fix it and would fight
  [performance-mode](performance-mode.md) REQ-analyser-fft-size-follows-the-tier, which owns that number for the
  whole app; a Spectrum-only override is the open question, not a decided design.
- **`SPECTRUM_F_MAX` is 20 kHz, so the top of the plot is usually empty**.
  Little music has content above 16 k, and at a 44.1 kHz sample rate the clamp to
  Nyquist eats the last stretch anyway. 20 k was chosen because "20 Hz to 20 kHz"
  is a range the user can check against what they already know, over a tighter
  `F_MAX` that would read better but explain worse. Revisit if the empty right
  edge annoys more than the round number helps.
- **Zones are not persisted**, on the same argument as Wave/Spectrum and
  Mono/Stereo (see Persistence). If mixing sessions turn out to leave it on
  permanently, that is the evidence that would move it into the device-scoped
  workspace family beside the panel height — not before.
- The Wave trigger (REQ-the-wave-trace-is-triggered) searches a quarter of the
  buffer, so low notes (below ~190 Hz at the strong tier) still free-run; a longer
  analyser on the Wave view would reach them, at an always-on FFT cost the
  perf tiers were set to avoid.
