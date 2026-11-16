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
  - scope-health                      # never stop painting: the watchdog, context loss, sleep
  - scope-spectrum                    # the Spectrum view: log axis, peak hold, zones, hover
source:
  - src/ui/components/scope.ts
  - src/ui/components/scope-math.ts   # the pure half: regions, axes, peak hold, ticks, zones (re-exported by scope.ts)
  - src/ui/components/scope-render.ts # the painters + SpectrumCaches; `Scope` decides what to draw, these draw it
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
RIGHT, side by side or stacked, REQ-the-split-layout-is-pure), because a mono
down-mix hides the bus's stereo image.

The rest of the design follows from what each view is for:

- **Spectrum** is the honest level and frequency readout: a log axis, a peak
  hold, zones and a hover readout ([scope-spectrum](scope-spectrum.md)).
- **Wave** is for watching. It **auto-ranges** with a fractional exponent, so a
  quiet song is legible and a loud one still reads louder; it is not a calibrated
  meter (REQ-the-wave-view-auto-gains).
- The panel is **resizable** from its top edge, 130–260 px, by resizing the grid
  row rather than the canvas, so the wheel strips that share the row grow with it
  and `Scope` needs no size logic of its own (REQ-a-scope-resize-handle).
- **It must never stop painting for good** — the watchdog, context-loss recovery
  and the idle sleep are [scope-health](scope-health.md)'s.

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
  **perf-tier-dependent**: **256 / 512 / 1024** for weak /
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
  hidden ([performance-mode](performance-mode.md)).
- **REQ-stereo-on-a-mono-scope-falls-back** — Defensive fallback: if
  `setChannels('stereo')` is called on a `Scope` built without left/right
  analysers, it stays in mono (no throw).
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
  `waveGainTarget(peak)`. `WAVE_NORM_STRENGTH < 1` compresses the level scale
  rather than flattening it, so loud still draws louder than soft. The gain floor
  of **1** never shrinks a clipping signal; the `WAVE_MAX_GAIN` ceiling and a
  **silence gate** (`peak <= WAVE_SILENCE_PEAK` → 1) keep silence a flat line. The
  scaled sample is **clamped to `[-1, 1]`** (there is no `ctx.clip()`, and stacked
  stereo would bleed). Smoothing is a frame-rate-independent one-pole
  (`updateWaveGain`) that **falls fast** when the signal gets louder and **rises
  slowly** when it gets quieter; `dtSec <= 0` leaves the gain untouched. One gain
  is **shared across L and R**, from the loudest region this frame — per-channel
  gains would erase the stereo image. The gain is **frozen while in Spectrum** (it
  is neither updated nor decayed), the mirror image of how the peak-hold freezes
  in Wave (REQ-spectrum-draws-a-peak-hold).
- **REQ-the-wave-read-is-float** (v8) — The Wave read is **float**:
  `getFloatTimeDomainData` into a per-channel `Float32Array` (reallocated by
  `setFftSize` like the byte buffers). A byte read quantises to 1/128, which a boost paints as a staircase. The
  auto-gain adds **no measurable per-frame cost** (REQ-no-per-frame-layout-read):
  the peak scan is **fused into the draw loop**, drawing with the previous frame's
  peak, with **no allocation on the steady path**. The applied gain is mirrored
  to `el.dataset.waveGain` under the same change-only-write rule as the peak
  mirror (REQ-the-scope-canvas-carries-a-testid), so a steady scope still
  performs no per-frame attribute write.
- **REQ-the-wave-trace-is-triggered** (v19) — **The Wave trace is triggered.**
  Each channel's trace starts at the **first rising zero crossing**
  (`prev < 0 <= cur`) within the buffer's first quarter
  (`findRisingZeroCrossing`), and draws a fixed **three quarters** of the buffer
  from there. Fixed, so the time span never jumps between frames: the trace is
  the same width whether a trigger was found or not. When none is found — a note
  whose period is longer than the search quarter (below `sampleRate / (fftSize/4)`,
  ~190 Hz at the strong tier's 1024), or silence — the trace starts at 0 and
  free-runs; triggering is never a gate. The search is one pass over at most a quarter of the samples the
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
  Its **position and size** come from the consumer class `.scopeResize` in
  `bottom.module.css` — only the consumer knows what it must sit clear of.
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

Double-tap, the ARIA window-splitter semantics and the `title` hint are the shared
handle's ([resize-handle](resize-handle.md)); the `scope` help topic mentions it.

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

// Liveness constants + ScopeHealth: scope-health.md. Log axis + peak-hold math: scope-spectrum.md.

// Pure, exported, canvas-free — the split geometry (REQ-the-split-layout-is-pure):
interface ScopeRegion { x: number; y: number; w: number; h: number; tag: 'mono' | 'left' | 'right'; label: string; }
function scopeRegions(channels: ScopeChannels, w: number, h: number): ScopeRegion[];

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
- **Everything else is inside `scope.ts`** (the loop, peak-hold, auto-gain, the
  liveness sweep) **and its two helpers** — `scope-math.ts` (the pure axes and
  regions) and `scope-render.ts` (the painters) — and needs nothing from the audio layer but
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

A height is furniture, not a view mode: it joins the device-scoped family
(`websynth.perf`, `websynth.keyboard.layout`, `websynth.ui.collapsed.*`) and is
**excluded from `ParamBus`, presets and `SongFile`**, so a loaded song never
rearranges your panels. Stored as integer px (`'186'`); every read goes through
`clampScopeHeight`, and writes swallow private-mode and quota errors.

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

Panel resize — one grid track grows, and the wheels ride along because they
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


## Scenarios (BDD)

```gherkin
Scenario: A steady tone stands still in the Wave view (REQ-the-wave-trace-is-triggered)
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
  `tests/ui/scope-trigger.test.ts`,
  `tests/state/scope-height.test.ts`,
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

## Open questions / future

- A future **goniometer / Lissajous** (X-Y L-vs-R) view could reuse `analyserL/R`;
  out of scope here.
- The Wave auto-gain is deliberately **not exposed** — no third overlay button
  on an already three-cornered panel, and no persisted preference *of its own*. If a
  "1×" (calibrated) escape hatch is ever wanted, `WAVE_NORM_STRENGTH = 0` is already
  the whole implementation of it; the open question is only where the toggle would
  live (view state is not persisted; the height is workspace state, see Persistence).
- The 2× ceiling is a **fixed** 260 px, not a fraction of the viewport. On a very tall
  display there is headroom left unused; on a very short one the ceiling is reachable
  only by pushing the page into a scroll. A viewport-relative ceiling was rejected as
  a rule you cannot see: the handle would stop at a different place on every screen,
  and "twice as tall" is a promise the user can check.
- The Wave trigger (REQ-the-wave-trace-is-triggered) searches a quarter of the
  buffer, so low notes (below ~190 Hz at the strong tier) still free-run; a longer
  analyser on the Wave view would reach them, at an always-on FFT cost the
  perf tiers were set to avoid.
