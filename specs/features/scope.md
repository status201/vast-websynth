# Scope — Wave / Spectrum live visualizer

```yaml
id: scope
status: implemented          # draft | active | implemented
version: 11  # v4: analyser fftSize perf-tier-dependent; v5: applied LIVE via setFftSize; v6: tiers halved to 256/512/1024; v7: L/R labels bottom-left (clear of the corner buttons); v8: Wave auto-gain (partial normalization) + float time-domain read; v9: dropped a stale "ping-pong delay" from the stereo-sources list — the delay is mono; v10: dropped the phaser and the DJ FX from that same list (neither can create L≠R), and the Background's layout prose now matches REQ-5; v11: a drag handle on the top edge resizes the scope (REQ-19), height persisted as a device-scoped workspace pref (REQ-20) — the first thing about this panel that survives a reload
owner: status201
related:
  - architecture
  - performance-mode
  - compressor
  - runtime-performance
source:
  - src/ui/components/scope.ts        # NOT touched by v11 — see REQ-19
  - src/ui/components/resize-handle.ts
  - src/state/scope-height.ts
  - src/audio/engine.ts
  - src/ui/studio-api.ts
  - src/ui/app.ts
  - src/ui/styles/layout.module.css
  - src/ui/onboarding/help-content.ts
```

## Background / Why

The bottom panel hosts a live oscilloscope/analyser (`Scope`) tapped **pre-master**
so the display is independent of the master-volume knob. It already toggles between
a **Wave** (time-domain) and a **Spectrum** (frequency) view via a single button.

The synth's signal is **stereo** — three things produce L≠R content: the
**reverb** (a 2-channel decorrelated IR, so it is mono-in/stereo-out), the **LFO
auto-pan** (`synthPan`), and the **drum tracks' per-track pans**. Everything else
in the chain is channel-transparent: it can carry an existing stereo image but
cannot create one. The scope down-mixes to mono, so that motion is invisible.
(This list has now shed three wrong entries. A "ping-pong delay" went in v9 —
there has never been one; `effects/delay.ts` is a single mono `DelayNode` with a
damped feedback loop. The **phaser** and the **DJ FX** went in v10: the phaser is
one shared allpass chain driven by one shared LFO, and the DJ FX is one
`BiquadFilterNode` plus stutter/fill/tape-stop, which are timeline and tempo
operations. None of them touches channels.)
This feature adds an orthogonal **Mono/Stereo** toggle: Mono keeps the
existing single full-panel trace (the down-mix, the default); Stereo splits the
panel into two equal regions — **LEFT** then **RIGHT**, side by side on a wide
panel and stacked on a narrow one (REQ-5) — each drawn with the same
Wave/Spectrum renderer.

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

**Wave auto-gain (v8).** The Wave view drew at a fixed 1:1 scale, so it only
looked like an oscilloscope for material running into clip. A song peaking at
−25 dBFS drew a trace ~6 % of the panel height — a flat line, useless. A real
scope has a volts/div knob for exactly this; here it **auto-ranges** instead.
(Note the panel height itself is now the user's to set — REQ-19. The auto-gain
scales to whatever height it is given; the two are independent.) The
normalization is deliberately **partial**: a fractional exponent compresses the
level scale rather than flattening it, so quiet songs become legible *and* a loud
song still visibly reads louder than a soft one. The Wave view is therefore
explicitly **not** a calibrated level meter — the Spectrum peak-hold (REQ-10/11)
remains the honest readout, and it is unaffected.

**Resizable panel (v11).** The scope has always been locked to a **130 px** grid
track, which after the wrap's padding and border leaves the canvas ~112 CSS px. In
*stacked* stereo (REQ-5, narrow panels) that is ~54 px per channel — legible, but
not enjoyable, and the Wave view's whole point is that it is nice to watch. So the
panel's top edge gets a **drag handle**: pull it up to make the scope taller, to a
ceiling of exactly **twice** the original height (260 px), with the original height
as the floor.

The handle resizes the **grid row**, not the canvas. That is the entire trick, and
it buys two things for free:

- The scope and the **PITCH / OCT / MOD** wheel strips share the same row
  (`.bottomTop` is `grid-template-columns: 120px 1fr`), and `Strip` already
  re-renders its thumb from a `ResizeObserver`. So the wheels grow *with* the scope,
  which is what makes the resize read as "the instrument's bottom half got taller"
  rather than "one panel inflated".
- `Scope` needs **no change at all**. Its buffers are sized by `fftSize`, not by
  pixels, and its own `ResizeObserver` → `measure()` already re-allocates the bitmap
  and invalidates the gradient cache (REQ-16). Height was never baked in.

Where the extra space comes from is a question the layout had already answered
before this feature existed: `.app`'s bottom row is `1fr` under a `100dvh`
`min-height`, and `.bottom` floors the keyboard at `minmax(160px, 1fr)`. So a
growing scope consumes the keyboard's slack first, stops at the keyboard's floor,
and only then does the page scroll. The keyboard is never squeezed out of reach.

## Requirements

- **REQ-1** — The `Engine` exposes two extra per-channel analysers, `analyserL`
  (left) and `analyserR` (right), tapped at the **same point** as the existing mono
  `analyser` (post-`masterComp`, pre-`master`), so all three stay independent of the
  volume knob. The audio path to `master`/destination is unchanged (lossless
  split→merge), so every analyser sits in the live render path and is pulled.
- **REQ-2** — All three analysers use the **same** `fftSize` and
  `smoothingTimeConstant` (0.2), so per-channel buffers are uniform and the three
  views are visually comparable. `fftSize` is **perf-tier-dependent** (v4/v5,
  halved in v6): **256 / 512 / 1024** for weak / medium / strong
  (`EngineOptions.analyserFftSize`
  seeds the boot value, default 1024; from `PERF_PROFILES` — see
  [performance-mode](performance-mode.md) REQ-12). Because `AnalyserNode.fftSize`
  is settable at runtime, a tier change applies it **live** (v5) via
  `Scope.setFftSize(n)`, which sets `fftSize` on all three analysers and
  **reallocates** each channel's time-domain + frequency read buffers to match —
  no reload, exactly like `setFps`.
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
  a faint `L`/`R` label. The label is anchored at its region's **bottom-left**
  (`textBaseline: 'bottom'`, inset 4 px), **not** the top-left: the two corner
  overlay buttons — Mono/Stereo (`top: 8px; left: 8px`) and Wave/Spectrum
  (`top: 8px; right: 8px`) — sit flush with the canvas corners inside the
  8 px-padded `.scopeWrap`, so a top-anchored `L` is completely hidden behind the
  Mono/Stereo button. The bottom edge is the only quadrant free of overlay chrome
  in **both** stereo layouts (side-by-side and stacked). This is the same dodge
  the peak-dB readout already makes by centring horizontally.
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
- **REQ-16** (performance) — The redraw loop must do **no per-frame layout read and
  no per-frame DOM mutation**: the canvas bitmap is sized from a `ResizeObserver`
  (cached CSS box + dpr), not by reading `clientWidth`/`clientHeight` inside the
  rAF loop, and the `dataset` mirror only writes on change (REQ-15). So an animated
  scope costs a single composited canvas raster, not a full page
  layout/style/layerize/paint each frame. Environments without `ResizeObserver`
  (jsdom under unit test) fall back to measuring on draw — behaviour unchanged.
  (v3) The spectrum bar gradient is likewise **cached per region** (keyed by the
  region's `y`/`h`, invalidated on resize) instead of `createLinearGradient`
  allocating every frame — no per-frame canvas-object allocation on the steady
  path.
- **REQ-17** (v8) — The **Wave** view applies an **auto-gain** so quiet material
  still draws a readable trace. The gain is a **partial** normalization —
  `clamp((WAVE_TARGET_PEAK / peak) ** WAVE_NORM_STRENGTH, 1, WAVE_MAX_GAIN)`,
  computed by the pure `waveGainTarget(peak)`. `WAVE_NORM_STRENGTH < 1` is what
  keeps loud louder than soft: in dB the drawn peak is
  `STRENGTH·TARGET_dB + (1−STRENGTH)·peak_dB`, i.e. a monotonic *compression* of
  the level scale, never a flattening. Three bounds make it safe: the gain floor
  of **1** means a clipping signal is never *shrunk*; the `WAVE_MAX_GAIN` ceiling
  and a **silence gate** (`peak <= WAVE_SILENCE_PEAK` → gain snaps to 1) together
  mean silence draws a flat line instead of blooming into amplified noise. The
  scaled sample is **clamped to `[-1, 1]`** before it maps to Y, so an overshoot
  can never paint outside its region (there is no `ctx.clip()`; in stacked stereo
  an unclamped trace would bleed into the neighbouring channel).
  Smoothing is a frame-rate-independent one-pole (`updateWaveGain(gain, peak,
  dtSec)`) with **asymmetric** time constants: the gain **falls fast**
  (`WAVE_GAIN_FALL_TAU`) when the signal gets louder, so a transient cannot fly
  off-screen, and **rises slowly** (`WAVE_GAIN_RISE_TAU`) when it gets quieter, so
  the trace does not pump. `dtSec <= 0` (the first frame after the tab-hidden
  pause, where `lastTs` is reset) leaves the gain untouched.
  The gain is **shared across L and R**, not held per channel: one `waveGain` on
  the `Scope`, driven by the maximum peak over every region drawn this frame.
  Per-channel gains would blow a hard-panned quiet side up to match the loud one
  and destroy the stereo image the Stereo view exists to show. The gain is
  **frozen while in Spectrum** (it is neither updated nor decayed), the mirror
  image of how the peak-hold freezes in Wave (REQ-10).
- **REQ-18** (v8) — The Wave read is **float**: `getFloatTimeDomainData` into a
  per-channel `Float32Array` (reallocated by `setFftSize` exactly like the byte
  buffers were). `getByteTimeDomainData` quantises to 1/128, so a −25 dBFS signal
  occupies ~7 of 128 steps and any real boost would paint a visible staircase;
  float also lets the `[-1,1]` clamp see genuine above-0-dBFS excursions that the
  byte path had already hard-limited to 0/255. The auto-gain must add **no
  measurable per-frame cost** (REQ-16, `runtime-performance`): the peak scan is
  **fused into the existing draw loop** — the frame draws with the *previous*
  frame's peak (one frame of lag, ~16 ms, imperceptible) while accumulating this
  frame's peak in the same pass. So the added cost is one `abs` + one compare per
  sample inside a loop already issuing `lineTo`, plus one `Math.exp` per frame,
  and **no allocation on the steady path**. The applied gain is mirrored to
  `el.dataset.waveGain` under the same change-only-write rule as the peak mirror
  (REQ-15), so a steady scope still performs no per-frame attribute write.
- **REQ-19** (v11) — A **resize handle** (`data-testid="scope-resize-handle"`) sits
  on the scope panel's **top edge**. Dragging it vertically resizes the shared bottom
  grid row between `SCOPE_H_MIN` (130 px, the pre-v11 fixed height) and `SCOPE_H_MAX`
  (260 px, exactly twice it), by writing a single CSS custom property `--scope-h` as
  an inline style on the `.bottom` element; `.bottom`'s first grid track is
  `var(--scope-h, 130px)`, so the **default is still expressed in CSS** and the app
  renders identically when nothing has been dragged and when storage is unavailable.
  Because the wheel strips share that row, they resize with the scope — this is a
  consequence of the row, not separate code. The handle is a **sibling of the canvas**
  (appended to `.scopeWrap`, like the two corner toggle buttons), so a press on it can
  never reach the canvas `click` listener and reset the peak-hold (REQ-13) — the same
  structural dodge, with no `stopPropagation`. `Scope` itself is **not modified**: the
  height change reaches it through its existing `ResizeObserver` (REQ-16).
  The handle's **appearance and interaction** come from its own CSS module; its
  **position and size** come from a consumer class in `layout.module.css`
  (`.scopeResize`), the same split `.scopeToggle` already makes against
  `switch.module.css` — only the consumer knows what the handle must sit clear of.
  That width shrinks to fit and drops out below 350 px; see the Gesture inventory.
- **REQ-20** (v11) — The height **persists**, device-scoped, under
  `websynth.ui.scope.height` (see Persistence). It is read once at boot and applied
  **before** first paint so there is no visible jump, clamped on read so a hand-edited
  or stale value can never produce an unusable panel, and written **once on
  pointer release** — never per pointer move.
- **REQ-21** (v11, performance) — The resize must not violate the app-wide cost
  contract ([runtime-performance](runtime-performance.md)). Three obligations: the
  `pointermove`/`pointerup` listeners are **window-scoped and gesture-scoped** —
  attached on `pointerdown`, removed on `pointerup`/`pointercancel` *and* in
  `destroy()` (REQ-3 there); the layout is **measured once** on `pointerdown` and the
  stroke reuses it; and the `--scope-h` write is **rAF-coalesced** — a move stores the
  pending value and schedules at most one frame, so a fast drag costs one style write
  and one bitmap re-allocation **per frame**, not per event. At rest the handle holds
  no global listener and costs nothing.

## Technical design

### Gesture inventory — the resize handle (v11)

The [recipe](../recipes/design-an-interaction.md) step-1 artefact for the one new
interactive control this feature adds. Everything else on this panel is a plain
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

**Horizontally it is not free**, and the measured numbers set the rule. The handle has
to thread between the two corner toggles, which are ~58 px and ~53 px wide plus their
8 px insets — about 127 px of the panel's width whatever the screen. So the hit box
is `min(64px, calc(100% - 140px))`: full width where there is room, shrinking rather
than overlapping where there is not. Measured left/right clearance, viewport width →
gap: 1440 → 522/527, 768 → 204/209, 430 → 35/40, 390 → 15/20, 375 → 7/12, 360 → 4/9.
Below **350 px** the remaining gap cannot hold a hittable grip at all, so the handle
is **dropped** rather than shown unhittable — a stored height still applies, it just
cannot be changed on that screen. (A fixed 96 px box was the first attempt and
overlapped the Mono/Stereo button by 1 px at 390 px, which would have swallowed that
button's last pixel column; the shrink-to-fit width is what replaced it.)

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
  setFftSize(fftSize: number): void;     // v5: set all three analysers' fftSize live + reallocate read buffers
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

// Pure, exported, canvas-free — the Wave auto-gain (v8, REQ-17):
const WAVE_TARGET_PEAK   = 0.9;    // fraction of half-height a fully-normalized trace reaches
const WAVE_NORM_STRENGTH = 0.85;   // 1 = full normalization, 0 = none; <1 keeps loud louder than soft
const WAVE_MAX_GAIN      = 32;     // ceiling, so a noise floor is never blown up
const WAVE_SILENCE_PEAK  = 0.0005; // ~-66 dBFS; at/below this the gain snaps to unity (flat line)
const WAVE_GAIN_FALL_TAU = 0.05;   // s — gain dropping (signal got louder): fast, no overshoot
const WAVE_GAIN_RISE_TAU = 0.6;    // s — gain rising  (signal got quieter): slow, no pumping
function waveGainTarget(peak: number): number;                              // the clamped target gain
function updateWaveGain(gain: number, peak: number, dtSec: number): number; // asymmetric one-pole toward it
```

`Engine` (`src/audio/engine.ts`) — new public fields `analyserL`, `analyserR`.
`StudioApi` (`src/ui/studio-api.ts`) — new `readonly analyserL`/`analyserR`.

The resize handle (v11) — a generic vertical resizer, deliberately **not** coupled to
`Scope`. It writes a CSS custom property on a target element and reports commits; it
knows nothing about canvases, analysers or grids:

```ts
// src/ui/components/resize-handle.ts
interface ResizeHandleOptions {
  target: HTMLElement;      // element the custom property is written on
  cssVar: string;           // e.g. '--scope-h'
  min: number;              // px, inclusive
  max: number;              // px, inclusive
  initial: number;          // starting height (already clamped by the caller)
  defaultValue: number;     // what double-tap / Home resets to
  onCommit(px: number): void;  // fired on release / key commit — NOT per move
  testId: string;
  label: string;            // aria-label + title
}

class ResizeHandle {
  readonly el: HTMLElement;
  constructor(opts: ResizeHandleOptions);
  get value(): number;        // current height in px
  set(px: number): void;      // clamped; writes the custom property + aria-valuenow
  destroy(): void;            // detaches drag + key listeners, cancels a pending frame
}
```

```ts
// src/state/scope-height.ts — device-scoped workspace pref (same class as perf-mode)
const SCOPE_H_MIN = 130;      // px — the pre-v11 fixed height, the floor
const SCOPE_H_MAX = 260;      // px — exactly twice it, the ceiling
const SCOPE_H_DEFAULT = 130;  // px — SCOPE_H_MIN; what a fresh boot and a reset give
const SCOPE_H_STEP = 8;       // px — arrow-key increment
function clampScopeHeight(px: number): number;   // NaN / non-finite -> SCOPE_H_DEFAULT
function readScopeHeight(): number;              // clamped; default on miss/garbage/throw
function writeScopeHeight(px: number): void;     // clamped; swallows quota/private-mode
```

It is written generically because a resizer has no business knowing about the scope —
but it is specced **here**, not in its own facility spec, because the scope is its
only consumer. A second consumer is what would earn it a spec of its own.

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

Wave auto-gain (REQ-17/18) — one gain for the whole display, not per channel:

```yaml
WAVE_TARGET_PEAK: 0.9        # a fully-normalized trace would reach 90% of the half-height
WAVE_NORM_STRENGTH: 0.85     # partial normalization; 1 = flatten every song to the same height
WAVE_MAX_GAIN: 32            # ceiling (binds below ~-36 dBFS)
WAVE_SILENCE_PEAK: 0.0005    # ~-66 dBFS silence gate
WAVE_GAIN_FALL_TAU: 0.05     # s, gain decreasing (louder signal) — fast
WAVE_GAIN_RISE_TAU: 0.6      # s, gain increasing (quieter signal) — slow

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
# Drawn height vs source peak (the "loud still reads louder" curve):
#     0 dBFS -> gain  1.0x -> 100%      -25 dBFS -> gain 10.6x -> 59%
#    -6 dBFS -> gain  1.7x ->  83%      -36 dBFS -> gain 31.5x -> 50%
#   -12 dBFS -> gain  2.9x ->  73%     <-66 dBFS -> gain  1.0x -> flat (gated)
#
# Scope state: waveGain (init 1) + wavePeak (this-frame max |v| over ALL regions,
#   reset each frame). Dataset mirror el.dataset.waveGain (1 dp), Wave-view only.
```

Panel height (REQ-19/20) — one number, one CSS custom property:

```yaml
SCOPE_H_MIN: 130       # px, the pre-v11 fixed row height
SCOPE_H_MAX: 260       # px, 2 * MIN
SCOPE_H_DEFAULT: 130   # px, == MIN
SCOPE_H_STEP: 8        # px, arrow-key increment
DOUBLE_TAP_MS: 350     # ms window for the hand-rolled double-tap

# .bottom  grid-template-rows: var(--scope-h, 130px) minmax(160px, 1fr)
#            row 1 = .bottomTop (wheels 120px | scope 1fr)  <- the resized row
#            row 2 = keyboard, floored at 160px
# drag: h = clamp(startH + (startY - clientY), MIN, MAX)    # up = taller
# clampScopeHeight(px) = Number.isFinite(px) ? min(max(round(px), MIN), MAX) : DEFAULT
```

### Layer touchpoints & ordering

- **`Engine` constructor** builds the analyser tap. Replace the single
  `masterComp.output → analyser → master` link with a lossless split→merge so all
  three analysers are pulled (see Visual aids):
  `masterComp.output → splitter` ; `splitter[0] → analyserL`, `splitter[1] →
  analyserR` ; `analyserL → merger[0]`, `analyserR → merger[1]` ; `merger →
  analyser → master → destination`. `analyserL/R` are configured (the resolved
  tier's `analyserFftSize`, smoothing 0.2) before use. `ChannelSplitterNode`/`ChannelMergerNode` are created
  with 2 ports.
- **`main.ts`** passes the concrete `Engine` (which now structurally satisfies the
  widened `StudioApi`) to `mountApp`; `window.__synth.engine` therefore exposes
  `analyserL`/`analyserR` (DEV only) for E2E assertions.
- **`app.ts` `buildBottom`** constructs `new Scope({ mono: engine.analyser, left:
  engine.analyserL, right: engine.analyserR }, { fps: PERF_PROFILES[resolveTier()].fps })`,
  returns the scope so `mountApp` can bind the live `setFps` + `setFftSize` hooks
  (perf-mode), and adds the
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
  on a dedicated static underlay, `.scopeScreen` — not on the animated canvas, and not
  on `.scopeWrap`, which carries only the panel frame — so it is not re-rastered each
  frame.
- **`Scope.drawSpectrum`** owns the peak-hold (v2): after the existing
  `getByteFrequencyData` read it takes the max byte over the same visible bins,
  converts with `byteToDisplayDb`, updates `channel.peakDb` via `decayPeak` (from a
  clamped inter-frame `dt`), then draws the dashed line + dB label and mirrors the
  value onto `el.dataset`. The constructor binds a `click` listener on `el` →
  `resetPeak()` (removed in `destroy`). No `engine.ts`/`app.ts` change — the peak
  line, label and reset are entirely inside the component; the toggle buttons already
  sit outside the canvas.
- **`Scope.drawWave` + `draw`** own the auto-gain (v8). `draw()` updates the shared
  `waveGain` from the *previous* frame's `wavePeak` and the clamped `dt`, then zeroes
  `wavePeak`, **before** the region loop — and only while `mode === 'wave'`, so the
  gain freezes in Spectrum. `drawWave` reads `getFloatTimeDomainData` and, in the one
  existing per-sample loop, accumulates `max |v|` into `this.wavePeak` while drawing
  the clamped, scaled sample — no second pass. Like the peak-hold this is entirely
  inside the component: **no `engine.ts`, `studio-api.ts` or `app.ts` change**, no
  new button and no new `data-testid` (the gain rides the existing `scope-canvas`
  dataset). `clearPeakDataset` becomes `clearDatasetMirror` so the `waveGain` key is
  dropped on the same rare transitions.
- **`ResizeHandle` + `buildBottom`** own the resize (v11), and **nothing else does**.
  `layout.module.css` changes one declaration — `.bottom`'s first grid track becomes
  `var(--scope-h, 130px)`. `buildBottom` reads `readScopeHeight()`, sets `--scope-h`
  on the `.bottom` element *before* it is mounted (REQ-20: no first-paint jump), and
  appends a `ResizeHandle` to `.scopeWrap` after the two toggle buttons, with
  `onCommit: writeScopeHeight`. The handle is returned alongside the `Scope` so its
  `destroy()` sits wherever `scope.destroy()` does. **No change to `scope.ts`,
  `engine.ts` or `studio-api.ts`** — if an implementation finds itself editing them,
  the approach has drifted (the height reaches `Scope` through REQ-16's observer).

### Persistence

**The panel height, and nothing else.**

| State | Where | Why |
| --- | --- | --- |
| Wave/Spectrum, Mono/Stereo, peak-hold, wave gain | in-memory only | *View* state — what you are looking at right now. Not part of a sound or a song, and cheap to re-pick. Every boot starts at **Wave + Mono** with no held peak. |
| Panel height | `localStorage` `websynth.ui.scope.height` | *Workspace* state — how the instrument is arranged on **this** screen. |

v11 does not soften the original rule, it draws the line the rule was always
implying: a height is not a view mode, it is furniture. It joins the device-scoped
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

Scenario: Stereo channel labels clear the corner overlay buttons (regression)
  Given the scope is in Stereo mode
  Then each region's L/R label is drawn at that region's bottom-left, inset 4px
  And neither label is overlapped by the Mono/Stereo button at the canvas top-left
  Nor by the Wave/Spectrum button at the canvas top-right
  And this holds in both the side-by-side and the stacked stereo layout
# pinned by: design contract (REQ-6); canvas text is not assertable from the DOM

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
  And this holds because the handle is a sibling of the canvas, not a child (REQ-13)
# pinned by: tests/ui/resize-handle.test.ts

Scenario: The handle holds no global listener at rest (REQ-21)
  Given a mounted resize handle that is not being dragged
  Then it has registered no window pointermove listener
  When a drag starts and then ends
  Then the listeners are attached for the stroke and detached on release
  And destroy() detaches them and cancels any pending frame
# pinned by: tests/ui/resize-handle.test.ts
```

## Tests & verification

- Unit: `tests/ui/scope-regions.test.ts` — pure `scopeRegions` geometry (mono single
  region; stereo two stacked halves tiling the panel; tags/labels); the peak-hold
  helpers `byteToDisplayDb`/`dbToFrac`/`decayPeak`; the Wave auto-gain helpers
  `waveGainTarget`/`updateWaveGain` (unity at/above full scale and below the silence
  gate, the `WAVE_MAX_GAIN` ceiling, monotonic drawn height, asymmetric fall/rise,
  frame-rate independence); and `Scope.resetPeak()` clearing the dataset mirror —
  `npm test`.
- Unit: `tests/state/scope-height.test.ts` (v11) — `clampScopeHeight` at and past both
  ends, rounding, and non-finite input; `readScopeHeight`/`writeScopeHeight` round-trip
  over `tests/storage-mock.ts`, with a missing key, garbage, an out-of-range value and
  a throwing storage all resolving to a usable height without escaping an error.
- Unit: `tests/ui/resize-handle.test.ts` (v11) — **one case per gesture-inventory
  row**: drag writes the custom property and clamps at both ends; a press with no
  movement changes nothing and commits nothing; double-tap inside `DOUBLE_TAP_MS`
  resets (and outside it does not); `ArrowUp`/`ArrowDown` step by `SCOPE_H_STEP`,
  `Home` resets, `aria-valuenow` follows; `onCommit` fires on release, not per move;
  no `window` `pointermove` listener at rest and none left after release or
  `destroy()` (spied `add/removeEventListener`, as `tests/ui/knob.test.ts` does).
- E2E: `e2e/scope.spec.ts` — default "Mono", toggle to "Stereo" and back,
  orthogonality with Wave/Spectrum, the `analyserL`/`analyserR` data path via
  `window.__synth.engine`, the Spectrum peak readout rising with sound +
  click-to-reset (`canvas.dataset.peak`), and the Wave `canvas.dataset.waveGain`
  mirror appearing in Wave and clearing in Spectrum. (v11) Dragging
  `scope-resize-handle` upward grows the canvas, grows a wheel strip by the same
  delta, and survives a `reload()` — `npm run e2e`.
- Typecheck: `npm run typecheck`.
- **By eye (ADR-010)** — the auto-gain is a *look*, so a green suite does not verify
  it. Load a quiet demo (**Nocturne**) and a loud one (**Mordor**) in Wave
  view: the quiet one must draw a readable trace (roughly half the panel) and the
  loud one must still draw visibly taller. Then check silence settles flat, a
  transient from silence does not paint outside its region, and Stereo keeps the L/R
  height difference on hard-panned material. `WAVE_NORM_STRENGTH` and
  `WAVE_MAX_GAIN` are the two knobs to retune.
- **By eye (v11)** — the resize is likewise a *look* and a *feel*. Drag the handle to
  the ceiling and check: the trace and the spectrum bars scale cleanly with no
  stretching artefact; the L/R labels still sit clear at each region's bottom-left in
  **both** stereo layouts; the CRT bezel (`.scopeScreen`) still frames the canvas
  exactly; the wheel strips grow with it and their thumbs stay on value; and the
  keyboard gives up its slack down to its 160 px floor and then hands over to a page
  scroll rather than collapsing. Repeat at phone width — the grip must still clear
  both corner buttons. The drag itself must track the pointer without lag or rubber
  banding.
- Dev-bridge assertions: `window.__synth.engine.analyserL` (DEV only); peak readout
  via the canvas `dataset.peak`/`peakL`/`peakR`; applied wave gain via
  `dataset.waveGain`.

## Open questions / future

- Stereo orientation is **responsive**: side-by-side on wide panels (the L↔R
  spatial mental model reads naturally), stacked (dual-trace) on small screens where
  two side-by-side traces would each be too narrow. `STEREO_SIDE_BY_SIDE_MIN_W`
  (480 px) is the single tunable threshold, decided from the canvas width so it
  tracks actual available space rather than the viewport.
- A future **goniometer / Lissajous** (X-Y L-vs-R) view could reuse `analyserL/R`;
  out of scope here.
- The Wave auto-gain (v8) is deliberately **not exposed** — no third overlay button
  on an already three-cornered panel, and no persisted preference *of its own*. If a
  "1×" (calibrated) escape hatch is ever wanted, `WAVE_NORM_STRENGTH = 0` is already
  the whole implementation of it; the open question is only where the toggle would
  live. (v11 note: the panel now does persist one thing — its height — but that is
  workspace state, not a view mode. The argument against persisting *view* state is
  unchanged; see Persistence.)
- `ResizeHandle` (v11) is written generically — it writes a CSS custom property on a
  target and knows nothing about scopes — but it is specced here rather than in its
  own facility spec because the scope is its only consumer. A **second** consumer
  (resizable floating windows are the obvious candidate) is what would earn it a spec
  of its own, and the lift would be a move, not a rewrite.
- The 2× ceiling is a **fixed** 260 px, not a fraction of the viewport. On a very tall
  display there is headroom left unused; on a very short one the ceiling is reachable
  only by pushing the page into a scroll. A viewport-relative ceiling was rejected as
  a rule you cannot see: the handle would stop at a different place on every screen,
  and "twice as tall" is a promise the user can check.
- There is still **no trigger / zero-crossing sync**, so the trace free-runs and
  drifts horizontally. Unrelated to the gain, but the next thing that would make the
  Wave view read like a scope.
