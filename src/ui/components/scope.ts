import styles from '../styles/scope.module.css';
import { onPaletteChange } from '../theme-colors';
import { backingScale, onUiScaleChange, toLocal } from '../ui-scale';
import {
  type ScopeMode,
  type ScopeChannels,
  type ScopeRegion,
  scopeRegions,
  SPECTRUM_DB_TOP,
  SPECTRUM_DB_RANGE,
  byteToDisplayDb,
  updatePeak,
  WAVE_SILENCE_PEAK,
  updateWaveGain,
  SPECTRUM_F_MAX,
  SPECTRUM_COL_W,
  fracToFreq,
  formatHzFull,
} from './scope-math';
import {
  SpectrumCaches, drawMidline, drawLabel, drawWave, drawBars, drawZoneBands, drawZoneNames,
  drawTicks, drawCursorLine, drawPeak,
} from './scope-render';

// The pure half is re-exported, so this stays the scope's one public module.
export * from './scope-math';


/**
 * The analyser's sample rate, defensively. `AnalyserNode.context` is non-optional
 * in the DOM types but absent on the unit suites' stubs, and an unguarded read
 * would take both of them down.
 */
function sampleRateOf(analyser: AnalyserNode): number {
  const sr = (analyser as { context?: { sampleRate?: number } }).context?.sampleRate;
  return typeof sr === 'number' && sr > 0 ? sr : 48000;
}

export interface ScopeAnalysers {
  /** Mono down-mix (the default view). */
  mono: AnalyserNode;
  /** Left/right channel taps — required for the stereo view. */
  left?: AnalyserNode;
  right?: AnalyserNode;
}

export interface ScopeOptions {
  /**
   * Target redraw rate (frames per second). The loop throttles to this via a
   * timestamp accumulator, so it stays correct on high-refresh displays;
   * `fps >= 60` means "draw every frame". Lower fps cuts main-thread work that
   * contends with the audio callback on weaker devices. Default 60.
   * (perf-mode REQ-scope-renderers-are-rect-scoped)
   */
  fps?: number;
}

/** Target redraw rate when none is given, and the fallback for a nonsense one. */
const DEFAULT_FPS = 60;

/**
 * Liveness (v16, REQ-the-scope-proves-it-is-painting..38). v12 made `start()` restartable; it did not make
 * anything *call* it. Every trigger was an event, and each one bought exactly one
 * `requestAnimationFrame` — so a renderer that dropped that single callback ended the
 * panel for the life of the page. These four numbers are the whole supervision.
 */

/** How often the watchdog looks. Low-frequency, and it returns at once while hidden. */
export const SCOPE_WATCHDOG_MS = 1000;

/** No rAF callback for this long (visible) means the frame chain is dead. (REQ-a-watchdog-restarts-a-stalled-loop) */
export const SCOPE_STALL_MS = 1200;

/**
 * Frames arriving but no paint landing for this long means the layout box is gone,
 * not the loop. Must clear the weak tier's 15 fps draw interval (67 ms) with room.
 */
export const SCOPE_PAINT_STALL_MS = 1500;

/** A `contextrestored` that has not arrived by now is not going to. (REQ-waiting-for-contextrestored-is-bounded) */
export const CONTEXT_RESTORE_MS = 3000;

/**
 * Minimum gap between two canvas rebuilds. A machine whose GPU process is really
 * gone answers `isContextLost()` truthfully every time, and without this the ~1 Hz
 * watchdog would mint a fresh canvas and a fresh bitmap every second for as long as
 * the page lived — turning a recovery into a leak. Recovery is still automatic when
 * the GPU comes back; it is only the retry rate that is bounded. (REQ-a-lost-context-is-escaped-by-replacing-the-canvas)
 */
export const REBUILD_MIN_GAP_MS = 5000;

/**
 * Quiet frames for this long put the loop to sleep (REQ-a-scope-with-nothing-to-show-sleeps):
 * a rAF chain is a main-thread frame every vsync even when each frame redraws a
 * flat line, and every such frame also restyles any running CSS animation.
 */
export const SCOPE_SLEEP_AFTER_MS = 500;

/** How often a sleeping scope reads its analysers for sound — and nothing else. */
export const SCOPE_WAKE_POLL_MS = 50;

/** The bottom of the Spectrum's dB scale: a held peak here has nothing left to fall. */
const SPECTRUM_FLOOR_DB = SPECTRUM_DB_TOP - SPECTRUM_DB_RANGE;

/** What the panel knows about its own liveness — the Debug panel's row. (REQ-the-panel-says-whether-it-is-drawing) */
export interface ScopeHealth {
  /** Sleeping with nothing to show (REQ-a-scope-with-nothing-to-show-sleeps): not drawing, and not stalled. */
  asleep: boolean;
  /** A frame arrived recently AND a paint landed recently. */
  drawing: boolean;
  frameAgeMs: number;
  paintAgeMs: number;
  /** False when `measure()` has never found a non-zero box — nothing to draw into. */
  hasBox: boolean;
  contextLost: boolean;
  /** Times the watchdog or a control restarted a stalled loop. */
  restarts: number;
  /** Times the canvas element had to be replaced to escape a lost context. */
  rebuilds: number;
  /** Times `contextlost` fired. */
  losses: number;
}

/** Min ms between drawn frames for a target fps; 0 = draw every frame. */
function fpsToInterval(fps: number): number {
  // A non-finite or non-positive rate would give NaN/Infinity here — a loop that
  // spins and never draws, which is the black panel of REQ-the-redraw-loop-can-always-restart by another route.
  const f = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
  return f >= 60 ? 0 : 1000 / f;
}

/** An analyser paired with its reusable time-domain + frequency buffers. */
interface Channel {
  analyser: AnalyserNode;
  /** Float, not byte: 8-bit quantises to 1/128, which the auto-gain would magnify
   *  into a visible staircase on quiet material. (REQ-the-wave-read-is-float) */
  wave: Float32Array<ArrayBuffer>;
  freq: Uint8Array<ArrayBuffer>;
  /** Held max level in displayed dB for the Spectrum peak-hold; -Infinity = cleared. */
  peakDb: number;
  /** Seconds left on the hold plateau before the held peak starts to fall. */
  peakHoldS: number;
}

export class Scope {
  /**
   * The canvas. Mutable because REQ-a-lost-context-is-escaped-by-replacing-the-canvas can replace the element underneath: a 2D
   * context that is lost cannot be re-acquired — `getContext('2d')` hands back the
   * same dead one — so a fresh element is the only escape. Callers still see a
   * read-only `el`.
   */
  private canvas: HTMLCanvasElement;
  get el(): HTMLCanvasElement { return this.canvas; }
  private mode: ScopeMode = 'wave';
  private channels: ScopeChannels = 'mono';
  private rafId = 0;
  private running = false;
  /** Min ms between drawn frames; 0 = every frame. Set by fps (live via setFps). */
  private frameInterval: number;
  /** rAF timestamp of the last drawn frame; throttles the loop to frameInterval. */
  private lastDrawTs = 0;
  /**
   * `performance.now()` at the top of the last rAF callback — before the fps
   * throttle, so it tracks the frame *chain* and not the draw rate. The one thing
   * `running` could never tell us: that flag latches true over a dead chain (REQ-the-scope-proves-it-is-painting).
   */
  private lastFrameTs = 0;
  /**
   * `performance.now()` after the last `draw()` that returned without throwing.
   * Proves `syncSize()` passed and nothing threw — NOT that pixels landed. Its job
   * is to separate a dead chain from a live one drawing into no layout box.
   */
  private lastPaintTs = 0;
  /**
   * `performance.now()` when `contextlost` fired; **-1** = not waiting on a restore.
   * Not 0: `performance.now()` is 0 at the document's first instant, and a sentinel
   * a real reading can collide with is a bug that only shows up on a fast boot.
   */
  private lostAt = -1;
  private restarts = 0;
  private rebuilds = 0;
  /** `performance.now()` of the last rebuild; -1 = never. Rate-limits the retry. */
  private lastRebuildAt = -1;
  private losses = 0;
  /** The ~1 Hz supervisor. `window.setInterval` id; 0 = not running. (REQ-a-watchdog-restarts-a-stalled-loop) */
  private watchdog = 0;
  /**
   * Sleeping with nothing to show (REQ-a-scope-with-nothing-to-show-sleeps): no
   * frame armed, only `wakePoll` running. `start()` and `stop()` both clear it, so
   * every way back into this component wakes it without knowing about sleep.
   */
  private asleep = false;
  /** The wake poll's `window.setInterval` id; 0 = not polling. */
  private wakePoll = 0;
  /** Whether the frame just drawn showed anything that can still change by itself. */
  private frameBusy = true;
  /** `performance.now()` of the first quiet frame in the current run of them; -1 = none. */
  private quietSince = -1;
  private ctx: CanvasRenderingContext2D | null;
  private readonly mono: Channel;
  private readonly left: Channel | null;
  private readonly right: Channel | null;
  private bitmapW = 0;
  private bitmapH = 0;
  /** Cached CSS layout box + devicePixelRatio, refreshed only by the ResizeObserver. */
  private cssW = 0;
  private cssH = 0;
  /** Gradients, column→bin edges and rulers — allocated once, not per frame (scope-render.ts). */
  private readonly caches = new SpectrumCaches();
  /** Problem-band overlay (REQ-a-zones-toggle). Spectrum-only, memory-only, default off. */
  private zones = false;
  /** Pointer position in canvas CSS px while hovering the Spectrum; null = none. */
  private hoverX: number | null = null;
  private hoverY: number | null = null;
  /** Whether the hover listeners are currently attached (they are mode-scoped). */
  private hoverBound = false;
  /** Cached cursor label + the rounded Hz it was built from (no per-frame string). */
  private cursorHz = -1;
  private cursorLabel = '';
  /** Whether a region actually drew the cursor this frame — see the end of `draw`. */
  private cursorShown = false;
  private dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  private ro: ResizeObserver | null = null;
  /**
   * Unsubscribes the theme-change wake: a sleeping scope would keep the old
   * theme's screen until a signal woke it (ui-themes.md REQ-a-theme-change-repaints-the-canvases).
   */
  private readonly offPalette: () => void;
  /** Unsubscribes the UI-scale re-measure. */
  private readonly offScale: () => void;
  /** Last value mirrored to each dataset key — lets us skip redundant per-frame writes. */
  private readonly mirrored: {
    peak: string; peakL: string; peakR: string; waveGain: string; zones: string; cursorHz: string;
    rebuilds: string;
  } = { peak: '', peakL: '', peakR: '', waveGain: '', zones: '', cursorHz: '', rebuilds: '' };
  /** Timestamp of the previous drawn frame; 0 = none yet (peak decay is dt-based). */
  private lastTs = 0;
  /**
   * Wave auto-gain, shared by *every* region rather than held per channel (REQ-the-wave-view-auto-gains):
   * per-channel gains would blow a hard-panned quiet side up to match the loud one
   * and erase the stereo image the Stereo view exists to show.
   */
  private waveGain = 1;
  /**
   * Max |sample| seen across all regions in the frame being drawn. It feeds the
   * *next* frame's gain — accumulating it during the draw pass costs nothing,
   * whereas a pre-pass to get it first would double the per-sample work. (REQ-the-wave-read-is-float)
   */
  private wavePeak = 0;

  constructor(analysers: ScopeAnalysers, opts: ScopeOptions = {}) {
    this.frameInterval = fpsToInterval(opts.fps ?? DEFAULT_FPS);
    this.canvas = makeCanvas();
    this.ctx = this.canvas.getContext('2d');
    this.mono = makeChannel(analysers.mono);
    this.left = analysers.left ? makeChannel(analysers.left) : null;
    this.right = analysers.right ? makeChannel(analysers.right) : null;
    // Pause the redraw loop while the tab is hidden — a backgrounded scope is
    // pure wasted main-thread work that can starve the audio thread on mobile.
    document.addEventListener('visibilitychange', this.onVisibility);
    this.offPalette = onPaletteChange(this.onEnsureLive);
    // A UI scale change can leave the canvas's CSS box alone and still change the
    // bitmap it needs (ui-scale.md REQ-canvases-stay-sharp-at-any-scale).
    this.offScale = onUiScaleChange(this.onScaleChange);
    // A bfcache restore can reach a visible page without a visibilitychange
    // (REQ-becoming-visible-re-measures) — and it is exactly the path that drops a queued frame.
    window.addEventListener('pageshow', this.onVisibility);
    // Two more ways back in (REQ-every-public-mutator-is-a-recovery-path). A renderer that was frozen and resumed while
    // already visible fires neither of the two above. `focus` is deliberately NOT
    // capturing: it does not bubble, so a capturing listener would route every knob
    // and button in the app through `ensureLive`.
    window.addEventListener('focus', this.onEnsureLive);
    // Page Lifecycle; absent from TS's DocumentEventMap and inert off Chromium.
    document.addEventListener('resume' as 'visibilitychange', this.onEnsureLive);
    // Track the canvas's layout box so the rAF loop never reads clientWidth/Height
    // (a per-frame forced reflow). jsdom (unit tests) has no ResizeObserver — the
    // draw path measures itself in that case (see syncSize).
    if (typeof ResizeObserver !== 'undefined') this.ro = new ResizeObserver(() => this.measure());
    this.attachCanvas();
    // The supervisor (REQ-a-watchdog-restarts-a-stalled-loop). Everything above is an *event*, and v16 exists
    // because every event in this component turned out to be one-shot.
    if (typeof window !== 'undefined') {
      this.watchdog = window.setInterval(this.onWatchdog, SCOPE_WATCHDOG_MS);
    }
    this.start();
  }

  /**
   * Every registration that belongs to the canvas *element*, in one place. The
   * constructor, `destroy()` and `rebuildCanvas()` all go through this pair — a
   * listener added in one of three places and forgotten in the others is the next
   * bug of exactly this kind. (REQ-a-lost-context-is-escaped-by-replacing-the-canvas)
   */
  private attachCanvas(): void {
    // Clicking the graph resets the Spectrum peak-hold. The listener is on the
    // canvas itself; the Wave/Spectrum + Mono/Stereo buttons are siblings (not
    // children) of it, so clicking a button never resets — "anywhere but the
    // buttons" with no stopPropagation needed. (REQ-clicking-the-graph-resets-the-peak)
    this.canvas.addEventListener('click', this.onClick);
    // A backgrounded tab can have its canvas backing store reclaimed. The
    // browser only ever restores a lost 2D context if the page asks it to, so
    // these two are the difference between "blank for a moment" and "blank for
    // the life of the page" (REQ-canvas-context-loss-is-survivable).
    this.canvas.addEventListener('contextlost', this.onContextLost);
    this.canvas.addEventListener('contextrestored', this.onContextRestored);
    this.ro?.observe(this.canvas);
    // The hover pair is mode-scoped (REQ-hovering-reads-out-a-frequency), so it only comes back in Spectrum.
    // `detachCanvas` cleared `hoverBound` on the way out, which is why this can
    // just ask for the binding it wants — the two are always called as a pair.
    if (this.mode === 'spectrum') this.bindHover();
  }

  private detachCanvas(): void {
    this.unbindHover();
    this.ro?.unobserve(this.canvas);
    this.canvas.removeEventListener('click', this.onClick);
    this.canvas.removeEventListener('contextlost', this.onContextLost);
    this.canvas.removeEventListener('contextrestored', this.onContextRestored);
  }

  setMode(m: ScopeMode): void {
    // Every control is a recovery path (REQ-every-public-mutator-is-a-recovery-path). Poking a button is what a user does
    // to a dead panel, and until v16 it was the one thing that could not help: these
    // setters write a field the loop was going to read. A no-op when healthy.
    this.ensureLive();
    this.mode = m;
    // Leaving Spectrum must drop the held-peak readout; re-entering re-acquires it.
    this.clearDatasetMirror();
    // The cursor belongs to the Spectrum's frequency axis, so it goes with it —
    // and its listeners are attached only while that axis is on screen (REQ-hovering-reads-out-a-frequency).
    this.clearHover();
    if (m === 'spectrum') { this.bindHover(); this.mirrorZones(); } else this.unbindHover();
  }

  /** Show/hide the problem-band overlay. Spectrum-only, memory-only. (REQ-a-zones-toggle) */
  setZones(on: boolean): void {
    this.ensureLive();   // REQ-every-public-mutator-is-a-recovery-path
    this.zones = on;
    this.mirrorZones();
  }

  /** Whether the problem-band overlay is on. */
  get zonesOn(): boolean { return this.zones; }

  /** Clear the Spectrum peak-hold (also bound to a canvas click). (REQ-clicking-the-graph-resets-the-peak) */
  resetPeak(): void {
    this.ensureLive();   // REQ-every-public-mutator-is-a-recovery-path
    for (const c of [this.mono, this.left, this.right]) {
      if (!c) continue;
      c.peakDb = -Infinity;
      c.peakHoldS = 0;
    }
    this.clearDatasetMirror();
  }

  /** Switch mono/stereo. Stereo needs both channel analysers; falls back to mono. */
  setChannels(c: ScopeChannels): void {
    this.ensureLive();   // REQ-every-public-mutator-is-a-recovery-path
    this.channels = c === 'stereo' && this.left && this.right ? 'stereo' : 'mono';
    // The set of active peak keys (peak vs peakL/peakR) changes with the layout.
    this.clearDatasetMirror();
  }

  /** The effective channel layout (mono unless stereo was set with both analysers). */
  get channelMode(): ScopeChannels { return this.channels; }

  private readonly onVisibility = (): void => {
    if (document.hidden) { this.stop(); return; }
    // ResizeObserver will not fire for a box that comes back the size it left,
    // so a hidden spell that zeroed the layout would otherwise leave `cssW/cssH`
    // stale and every draw early-returning. `measure()` refuses a 0×0 read, so
    // this can only help (REQ-becoming-visible-re-measures).
    this.measure();
    this.start();
  };

  /**
   * Without `preventDefault()` here the browser never restores the context and
   * the panel stays blank forever — that one line is REQ-canvas-context-loss-is-survivable. What v12 missed is
   * that `stop()` was then the last thing that ever happened to this panel: a lost
   * context restores *lazily*, so stopping is how you stop giving the browser any
   * reason to restore one, and no control could undo it. `lostAt` bounds the wait
   * (REQ-waiting-for-contextrestored-is-bounded) — note this path needs no backgrounding at all, since a GPU-process
   * crash fires `contextlost` on a visible, foregrounded tab.
   */
  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.lostAt = performance.now();
    this.losses++;
    this.stop();
  };

  private readonly onContextRestored = (): void => {
    this.lostAt = -1;
    // The restored context comes back with a blank bitmap of unknown size and
    // no cached gradients; force `measure()` past its unchanged-size check.
    this.dropCaches();
    this.bitmapW = 0;
    this.bitmapH = 0;
    this.measure();
    this.start();
  };

  private readonly onClick = (): void => { this.resetPeak(); };

  /** `window` focus and the Page Lifecycle `resume` — see the constructor. (REQ-every-public-mutator-is-a-recovery-path) */
  private readonly onEnsureLive = (): void => { this.ensureLive(); };
  private readonly onScaleChange = (): void => { this.measure(); this.wake(); };

  /**
   * Restart the loop if — and **only** if — it has actually stalled. The guard is
   * the point: this runs from six controls, a window focus and a page resume, so on
   * a healthy scope it must force no layout read and re-arm no frame. (REQ-every-public-mutator-is-a-recovery-path)
   */
  ensureLive(): void {
    if (document.hidden) return;
    if (this.contextDead()) { this.rebuildCanvas(); return; }
    // Still inside the restore window we asked for: REQ-canvas-context-loss-is-survivable says stay stopped, and
    // restarting would only spend frames on a context whose every method is a no-op.
    if (this.lostAt >= 0) return;
    // A sleeping loop is not a stall: wake it, uncounted, so the change this call
    // is about gets drawn (REQ-a-scope-with-nothing-to-show-sleeps).
    if (this.asleep) { this.wake(); return; }
    if (this.running && performance.now() - this.lastFrameTs < SCOPE_STALL_MS) return;
    this.restart();
  }

  /**
   * Is the context provably gone? Both signals are free (REQ-scope-detection-is-free-or-it-does-not-happen): the browser's own
   * answer where it has one, and a `contextlost` we acknowledged that was never
   * answered. Never a pixel read-back — that costs the panel its GPU acceleration to
   * ask whether it has any, and a lost 2D context makes every method a silent no-op
   * rather than throwing, so the fill such a probe reads back is the thing under test.
   */
  private contextDead(): boolean {
    const ctx = this.ctx as (CanvasRenderingContext2D & { isContextLost?: () => boolean }) | null;
    if (!ctx) return false;
    if (ctx.isContextLost?.() === true) return true;
    return this.lostAt >= 0 && performance.now() - this.lostAt > CONTEXT_RESTORE_MS;
  }

  /** Re-measure and re-arm, counting it — the one recovery both callers share. */
  private restart(): void {
    this.restarts++;
    this.measure();
    this.start();
  }

  /**
   * The supervisor (REQ-a-watchdog-restarts-a-stalled-loop). Every *other* way back into this component is an event,
   * and v16 exists because each of them buys exactly one frame — drop it and the
   * panel is over. A timer does not have to guess which event the platform sends.
   */
  private readonly onWatchdog = (): void => {
    // While hidden the loop is *meant* to be stopped (performance-mode REQ-scope-fps-and-fft-apply-live,
    // runtime-performance REQ-visibility-gating-is-for-pixels-not-sound). First line, so a background tab pays nothing.
    if (document.hidden) return;
    if (this.contextDead()) { this.rebuildCanvas(); return; }
    // Inside the restore window — REQ-canvas-context-loss-is-survivable's pause is deliberate, and it is the only
    // period in which a stopped loop on a visible page is correct.
    if (this.lostAt >= 0) return;
    // Asleep is the other period in which a stopped loop on a visible page is
    // correct: the wake poll owns it (REQ-a-scope-with-nothing-to-show-sleeps).
    if (this.asleep) return;
    const now = performance.now();
    if (!this.running || now - this.lastFrameTs > SCOPE_STALL_MS) { this.restart(); return; }
    // Frames are arriving but nothing is landing: `draw()` is early-returning on
    // `syncSize()`, i.e. the layout box is gone — that is a measure, never a rebuild.
    // A panel with genuinely no box has nothing to draw, and `health.hasBox` says so.
    if (now - this.lastPaintTs > SCOPE_PAINT_STALL_MS) this.measure();
  };

  /**
   * Escape a lost context the only way there is: a **new canvas element**.
   * `getContext('2d')` on a canvas whose context is lost hands back that same dead
   * context, and `canvas.width = canvas.width` resets the bitmap, not the context.
   * (REQ-a-lost-context-is-escaped-by-replacing-the-canvas)
   */
  private rebuildCanvas(): void {
    // Rate-limited: see REBUILD_MIN_GAP_MS. A dead GPU never stops saying so.
    const now = performance.now();
    if (this.lastRebuildAt >= 0 && now - this.lastRebuildAt < REBUILD_MIN_GAP_MS) return;
    const next = makeCanvas();
    // Take the context FIRST. Never trade a live canvas for one we cannot draw into.
    const ctx = next.getContext('2d');
    if (!ctx) return;
    this.detachCanvas();
    const old = this.canvas;
    this.canvas = next;
    this.ctx = ctx;
    // `replaceWith` on an unparented node is a silent no-op (the unit suite never
    // mounts the canvas), so the field swap above stands on its own.
    if (old.parentNode) old.replaceWith(next);
    // A fresh element carries none of the attributes, but `mirrored` still holds the
    // last values — and those are change-only writes (REQ-the-scope-canvas-carries-a-testid), so without this the
    // replacement would never expose a single readout again.
    this.clearDatasetMirror();
    this.dropCaches();
    this.bitmapW = 0;
    this.bitmapH = 0;
    this.lostAt = -1;
    this.lastRebuildAt = now;
    this.rebuilds++;
    this.attachCanvas();
    this.mirrorRebuilds();
    this.measure();
    this.start();
  }

  /** What the panel knows about its own liveness — the Debug panel's row. (REQ-the-panel-says-whether-it-is-drawing) */
  get health(): ScopeHealth {
    // Plain subtraction, no "0 means never" sentinel: `start()` seeds both and the
    // constructor always calls it, so an unseeded field would read as a huge age —
    // which is the honest answer anyway, and one less special case at t = 0.
    const now = performance.now();
    const frameAgeMs = now - this.lastFrameTs;
    const paintAgeMs = now - this.lastPaintTs;
    return {
      asleep: this.asleep,
      drawing: this.running && frameAgeMs < SCOPE_STALL_MS && paintAgeMs < SCOPE_PAINT_STALL_MS,
      frameAgeMs,
      paintAgeMs,
      hasBox: this.cssW > 0 && this.cssH > 0,
      contextLost: this.contextDead(),
      restarts: this.restarts,
      rebuilds: this.rebuilds,
      losses: this.losses,
    };
  }

  /**
   * Hover cursor (REQ-hovering-reads-out-a-frequency). `offsetX/offsetY` are already relative to the canvas's
   * padding box, so this forces no layout — a `getBoundingClientRect()` here would
   * be a reflow on every pointer move. Mouse only: hover has no touch equivalent,
   * and a finger drag that left a cursor line behind reads as a bug.
   */
  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    // Viewport px → the canvas's own CSS px, which cssW/cssH are in (ui-scale.md
    // REQ-coordinates-are-converted-at-the-read). A divide, never a layout read.
    this.hoverX = toLocal(e.offsetX);
    this.hoverY = toLocal(e.offsetY);
    // The cursor readout is drawn by the loop, so a sleeping one wakes for it.
    this.wake();
  };

  private readonly onPointerLeave = (): void => { this.clearHover(); };

  private bindHover(): void {
    if (this.hoverBound) return;
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.hoverBound = true;
  }

  private unbindHover(): void {
    if (!this.hoverBound) return;
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.hoverBound = false;
  }

  private clearHover(): void {
    this.hoverX = null;
    this.hoverY = null;
    this.cursorHz = -1;
    this.cursorLabel = '';
    this.mirrorCursor('');
  }

  /** The channel feeding a region tag (left/right fall back to mono if absent). */
  private channelFor(tag: ScopeRegion['tag']): Channel {
    if (tag === 'left') return this.left ?? this.mono;
    if (tag === 'right') return this.right ?? this.mono;
    return this.mono;
  }

  /**
   * Measure the canvas layout box and resize its bitmap to match. This reads
   * layout (clientWidth/Height) so it runs only from the ResizeObserver (on an
   * actual resize), never from the rAF loop. The cached CSS size + dpr feed `draw`.
   */
  private measure(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = backingScale(); // devicePixelRatio × the UI scale; no DOM read
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    // Nothing moved: keep the caches. This is what makes `measure()` cheap enough to
    // call from a 1 Hz watchdog and from every window focus (REQ-a-watchdog-restarts-a-stalled-loop/37) — otherwise
    // each call would throw away the gradients, the ruler and the bin edges and make
    // the next frame rebuild all three. `onContextRestored` zeroes `bitmapW/H` first,
    // so its forced path still gets through.
    if (w === this.cssW && h === this.cssH && dpr === this.dpr
        && bw === this.bitmapW && bh === this.bitmapH) return;
    this.dropCaches(); // region boxes moved — gradients, ruler and bin edges are stale
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    if (bw !== this.bitmapW || bh !== this.bitmapH) {
      this.canvas.width = bw;
      this.canvas.height = bh;
      this.bitmapW = bw;
      this.bitmapH = bh;
    }
    // A new box is a blank or stale bitmap: a sleeping loop wakes to repaint it
    // (REQ-a-scope-with-nothing-to-show-sleeps).
    this.wake();
  }

  /** Ready-to-draw guard from the cached size — no layout read in the rAF loop. */
  private syncSize(): boolean {
    // No ResizeObserver (jsdom): keep the old behaviour and measure on each draw.
    if (!this.ro) this.measure();
    return this.cssW > 0 && this.cssH > 0;
  }

  /** Change the target redraw rate live (e.g. a perf-mode tier switch). */
  setFps(fps: number): void {
    // `fpsToInterval` rejects a non-finite or non-positive rate for us.
    this.ensureLive();   // REQ-every-public-mutator-is-a-recovery-path
    this.frameInterval = fpsToInterval(fps);
  }

  /**
   * Change the analyser FFT size live (a perf-mode tier switch). `AnalyserNode.fftSize`
   * is settable at runtime — no graph rebuild — but the reusable read buffers are sized
   * to it, so reallocate each channel's `wave`/`freq` to match the new size.
   */
  setFftSize(fftSize: number): void {
    this.ensureLive();   // REQ-every-public-mutator-is-a-recovery-path
    for (const c of [this.mono, this.left, this.right]) {
      if (!c) continue;
      c.analyser.fftSize = fftSize;
      c.wave = new Float32Array(c.analyser.fftSize);
      c.freq = new Uint8Array(new ArrayBuffer(c.analyser.frequencyBinCount));
    }
    // The column→bin mapping is keyed on fftSize, so it is now stale (REQ-bars-are-drawn-per-pixel-column).
    this.dropCaches();
  }

  /**
   * Drop everything derived from the canvas box, the fftSize or the sample rate.
   * The three callers are the three moments any of those can change: a resize, a
   * perf-tier fftSize switch, and a restored (blank, unsized) canvas context.
   */
  private dropCaches(): void {
    this.caches.clear();
  }

  /**
   * Start (or restart) the redraw loop. Deliberately **not** guarded on
   * `running` (REQ-the-redraw-loop-can-always-restart): that guard was the only thing between a broken frame
   * chain and recovery. A frame the browser dropped while freezing the renderer,
   * or one that threw before re-arming, left `running` latched true with nothing
   * queued — and then every restart path in this component was a no-op, forever.
   * Cancelling first means a restart on a healthy loop is still exactly one
   * callback in flight.
   */
  private start(): void {
    this.clearSleep();
    cancelAnimationFrame(this.rafId);
    this.running = true;
    // Arming counts as a liveness event, so a just-started loop is not "stalled"
    // before its first frame has had a chance to arrive. If that frame never comes,
    // SCOPE_STALL_MS later the watchdog says so — which is exactly the grace period
    // we want, rather than a restart on every tick from construction onward.
    this.lastFrameTs = performance.now();
    this.lastPaintTs = this.lastFrameTs;
    // Throttle to frameInterval using the rAF timestamp, not a frame counter — a
    // counter would lock to the display's refresh rate (wrong on 120Hz panels).
    const loop = (now: number) => {
      if (!this.running) return;
      // Before the throttle, so this tracks the frame CHAIN and not the draw rate —
      // the watchdog's only evidence that the browser is still delivering (REQ-the-scope-proves-it-is-painting).
      this.lastFrameTs = performance.now();
      // Re-arm BEFORE drawing (REQ-one-bad-frame-cannot-end-the-loop). A throw in draw() then still reaches the
      // console — an invisible error is how this shipped — but the next frame is
      // already queued, so one bad frame cannot end the loop.
      this.rafId = requestAnimationFrame(loop);
      if (now - this.lastDrawTs >= this.frameInterval) {
        this.lastDrawTs = now;
        this.draw();
        // Only on the way out: a throw leaves this stale, which is exactly the
        // signal we want. Not evidence of pixels — see REQ-the-scope-proves-it-is-painting.
        this.lastPaintTs = performance.now();
        this.settle(this.lastPaintTs);
      }
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /**
   * After a drawn frame: a run of quiet ones `SCOPE_SLEEP_AFTER_MS` long puts the
   * loop to sleep (REQ-a-scope-with-nothing-to-show-sleeps). The frame on screen
   * is the last one drawn, which is exactly what it will go on showing.
   */
  private settle(now: number): void {
    if (this.frameBusy) { this.quietSince = -1; return; }
    if (this.quietSince < 0) { this.quietSince = now; return; }
    if (now - this.quietSince < SCOPE_SLEEP_AFTER_MS) return;
    this.stop();
    this.asleep = true;
    this.wakePoll = window.setInterval(this.onWakePoll, SCOPE_WAKE_POLL_MS);
  }

  /**
   * The sleeping scope's only work: read the analysers it would draw and wake on
   * a sample over the silence gate. No canvas, no layout, no dataset write.
   */
  private readonly onWakePoll = (): void => {
    if (this.pollChannel(this.mono)
      || (this.channels === 'stereo' && (this.pollChannel(this.left) || this.pollChannel(this.right)))) {
      this.wake();
    }
  };

  /** Back to drawing if asleep; a no-op on a running or stopped loop. Not a restart. */
  private wake(): void {
    if (this.asleep) this.start();
  }

  private pollChannel(c: Channel | null): boolean {
    if (!c) return false;
    c.analyser.getFloatTimeDomainData(c.wave);
    const data = c.wave;
    for (let i = 0; i < data.length; i++) {
      const v = data[i]!;
      if (v > WAVE_SILENCE_PEAK || v < -WAVE_SILENCE_PEAK) return true;
    }
    return false;
  }

  /** Leave sleep, whichever way the loop is going next. */
  private clearSleep(): void {
    this.asleep = false;
    this.quietSince = -1;
    if (this.wakePoll) { clearInterval(this.wakePoll); this.wakePoll = 0; }
  }

  private stop(): void {
    this.clearSleep();
    this.running = false;
    cancelAnimationFrame(this.rafId);
    // Forget the last frame time so the first frame after resuming has dt 0 — the
    // peak-hold must not decay across the (possibly long) paused-while-hidden gap.
    this.lastTs = 0;
    // Same reasoning for the fps throttle: no timestamp survives a stop.
    this.lastDrawTs = 0;
  }

  private draw(): void {
    // A frame that never got drawn proves nothing is quiet, so it never counts
    // toward sleep (REQ-a-scope-with-nothing-to-show-sleeps).
    this.frameBusy = true;
    if (!this.syncSize()) return;
    const ctx = this.ctx;
    if (!ctx) return;
    // Busy from here only if something on screen can still move by itself: a
    // hover cursor, sound (below, per view) or a peak-hold still falling.
    this.frameBusy = this.hoverX !== null;
    // Seconds since the previous frame, clamped — drives the dt-based peak decay
    // identically at ~30/60fps. The clamp caps any residual gap after a pause.
    const now = performance.now();
    const dt = this.lastTs ? Math.min((now - this.lastTs) / 1000, 0.1) : 0;
    this.lastTs = now;
    const dpr = this.dpr;
    // Set transform fresh each frame — no compounding.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Cached CSS box (kept in sync by the ResizeObserver) — no per-frame layout read.
    const w = this.cssW;
    const h = this.cssH;
    ctx.clearRect(0, 0, w, h);

    if (this.mode === 'wave') {
      // Gain for THIS frame comes from the LAST frame's peak (one frame ≈ 16ms of
      // lag — imperceptible, and it buys a single-pass draw). Only while in Wave, so
      // the gain freezes in Spectrum exactly as the peak-hold freezes in Wave.
      this.waveGain = updateWaveGain(this.waveGain, this.wavePeak, dt);
      this.wavePeak = 0;
      this.mirrorWaveGain();
    }

    this.cursorShown = false;

    // One renderer drives every region (DRY): mono = 1 region, stereo = 2.
    for (const region of scopeRegions(this.channels, w, h)) {
      const channel = this.channelFor(region.tag);
      if (this.mode === 'wave') this.paintWave(ctx, channel, region);
      else this.drawSpectrum(ctx, channel, region, dt);
      if (region.label) drawLabel(ctx, region);
    }
    // Wave: anything over the silence gate (which also snaps the auto-gain to 1,
    // so a silent trace is a still one).
    if (this.mode === 'wave' && this.wavePeak > WAVE_SILENCE_PEAK) this.frameBusy = true;

    // The pointer can be inside the canvas but outside every region — the stereo
    // centre gutter — where there is no frequency to report. No region drew a
    // cursor, so the readout must not keep showing the last one.
    if (!this.cursorShown && this.mirrored.cursorHz) {
      this.cursorHz = -1;
      this.mirrorCursor('');
    }
  }

  private paintWave(ctx: CanvasRenderingContext2D, channel: Channel, r: ScopeRegion): void {
    channel.analyser.getFloatTimeDomainData(channel.wave);
    this.wavePeak = drawWave(ctx, channel.wave, r, this.waveGain, this.wavePeak);
  }

  private drawSpectrum(
    ctx: CanvasRenderingContext2D,
    channel: Channel,
    r: ScopeRegion,
    dtSec: number,
  ): void {
    drawMidline(ctx, r);
    const analyser = channel.analyser;
    analyser.getByteFrequencyData(channel.freq);
    const data = channel.freq;
    const sampleRate = sampleRateOf(analyser);
    const fMax = Math.min(SPECTRUM_F_MAX, sampleRate / 2);
    // The plot is the whole region: no gutter is reserved for the Zones button.
    // On a panel narrow enough for the two to meet, the top tick label goes behind
    // the button — a deliberate trade, because reserving the width cost every
    // region a dead strip (and put an 80px hole down the middle of side-by-side
    // stereo) to protect one label at one end. (REQ-a-zones-toggle)
    const cols = Math.max(1, Math.floor(r.w / SPECTRUM_COL_W));
    const edges = this.caches.binEdges(cols, analyser.fftSize, sampleRate);

    // Bands go behind the bars; their names go in front, further down.
    if (this.zones) drawZoneBands(ctx, r, fMax);

    const maxByte = drawBars(ctx, r, data, edges, cols, this.caches.gradient(ctx, r));

    // Peak-hold: pushed up by the loudest visible bar, held briefly, then falls slowly.
    const next = updatePeak(
      { db: channel.peakDb, holdS: channel.peakHoldS },
      byteToDisplayDb(maxByte),
      dtSec,
    );
    channel.peakDb = next.db;
    channel.peakHoldS = next.holdS;
    // Spectrum: a bar off the floor, or a held peak still falling toward it.
    if (maxByte > 0 || channel.peakDb > SPECTRUM_FLOOR_DB) this.frameBusy = true;
    drawPeak(ctx, r, channel.peakDb);
    this.mirrorPeak(r.tag, channel.peakDb);
    drawTicks(ctx, r, this.caches.rulerFor(r.w, fMax));
    if (this.zones) drawZoneNames(ctx, r, fMax);
    this.paintCursor(ctx, r, fMax);
  }

  /**
   * The hover cursor (REQ-hovering-reads-out-a-frequency), for the region the
   * pointer is actually in — so in Stereo you read the channel you point at. The
   * label string is rebuilt only when the rounded frequency changes; the stroke
   * is scope-render.ts's.
   */
  private paintCursor(ctx: CanvasRenderingContext2D, r: ScopeRegion, fMax: number): void {
    const hx = this.hoverX;
    const hy = this.hoverY;
    if (hx === null || hy === null) return;
    if (hx < r.x || hx > r.x + r.w || hy < r.y || hy > r.y + r.h) return;
    const frac = (hx - r.x) / r.w;
    const hz = fracToFreq(frac, fMax);
    const rounded = hz < 1000 ? Math.round(hz) : Math.round(hz / 100) * 100;
    this.cursorShown = true;
    if (rounded !== this.cursorHz) {
      this.cursorHz = rounded;
      this.cursorLabel = formatHzFull(hz);
      this.mirrorCursor(`${rounded}`);
    }
    drawCursorLine(ctx, r, hx, hy, frac, this.cursorLabel);
  }

  /**
   * Mirror a region's held peak onto the canvas dataset for E2E (REQ-the-scope-canvas-carries-a-testid) — but only
   * when the formatted value changes, so a steady scope writes no attribute per frame
   * (a per-frame `data-*` write would dirty layout). The mirror still always reflects
   * the latest displayed value.
   */
  private mirrorPeak(tag: ScopeRegion['tag'], peakDb: number): void {
    const key = tag === 'left' ? 'peakL' : tag === 'right' ? 'peakR' : 'peak';
    const v = Number.isFinite(peakDb) ? peakDb.toFixed(1) : '';
    if (this.mirrored[key] === v) return;
    this.mirrored[key] = v;
    if (v) this.canvas.dataset[key] = v;
    else delete this.canvas.dataset[key];
  }

  /**
   * Mirror the applied Wave gain for E2E, under the same change-only-write rule as
   * `mirrorPeak` — a steady scope writes no attribute per frame (REQ-the-scope-canvas-carries-a-testid/16/18).
   */
  private mirrorWaveGain(): void {
    const v = this.waveGain.toFixed(1);
    if (this.mirrored.waveGain === v) return;
    this.mirrored.waveGain = v;
    this.canvas.dataset.waveGain = v;
  }

  /**
   * Drop every mirrored value. Only called on rare transitions (Wave/Mono-Stereo
   * switch, reset) — never per frame — so it clears unconditionally for correctness.
   */
  private clearDatasetMirror(): void {
    for (const key of ['peak', 'peakL', 'peakR', 'waveGain', 'zones', 'cursorHz'] as const) {
      this.mirrored[key] = '';
      delete this.canvas.dataset[key];
    }
  }

  /**
   * How many times the canvas had to be replaced (REQ-the-panel-says-whether-it-is-drawing). Under the same
   * change-only-write rule as the readouts above — which here means it is written
   * essentially never, because a rebuild is a once-in-a-session event at worst.
   */
  private mirrorRebuilds(): void {
    const v = String(this.rebuilds);
    if (this.mirrored.rebuilds === v) return;
    this.mirrored.rebuilds = v;
    this.canvas.dataset.rebuilds = v;
  }

  /** Mirror the overlay state for E2E — Spectrum-only, so cleared in Wave. (REQ-a-zones-toggle) */
  private mirrorZones(): void {
    const v = this.mode === 'spectrum' ? (this.zones ? 'on' : 'off') : '';
    if (this.mirrored.zones === v) return;
    this.mirrored.zones = v;
    if (v) this.canvas.dataset.zones = v;
    else delete this.canvas.dataset.zones;
  }

  /**
   * Mirror the frequency under the cursor. Written only when the rounded value
   * changes, and only while a mouse is over the graph — so a scope nobody is
   * pointing at still performs no attribute write at all. (REQ-the-scope-canvas-carries-a-testid/31)
   */
  private mirrorCursor(v: string): void {
    if (this.mirrored.cursorHz === v) return;
    this.mirrored.cursorHz = v;
    if (v) this.canvas.dataset.cursorHz = v;
    else delete this.canvas.dataset.cursorHz;
  }

  destroy(): void {
    this.stop();
    // The supervisor outlives a stopped loop by design — it must not outlive the
    // component (REQ-a-watchdog-restarts-a-stalled-loop).
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = 0; }
    this.detachCanvas();
    this.ro?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pageshow', this.onVisibility);
    window.removeEventListener('focus', this.onEnsureLive);
    this.offPalette();
    this.offScale();
    document.removeEventListener('resume' as 'visibilitychange', this.onEnsureLive);
  }
}

/** A blank scope canvas. Two callers: the constructor, and REQ-a-lost-context-is-escaped-by-replacing-the-canvas's rebuild. */
function makeCanvas(): HTMLCanvasElement {
  const el = document.createElement('canvas');
  el.className = styles.root!;
  el.dataset.testid = 'scope-canvas';
  return el;
}

function makeChannel(analyser: AnalyserNode): Channel {
  return {
    analyser,
    wave: new Float32Array(analyser.fftSize),
    freq: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
    peakDb: -Infinity,
    peakHoldS: 0,
  };
}
