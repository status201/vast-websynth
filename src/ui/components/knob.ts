import styles from '../styles/knob.module.css';
import type { ParamBus, ParamDef } from '../../state/params';
import { toNorm, fromNorm } from '../../utils/taper';
import { clamp01 } from '../../utils/math';
import { formatParam } from '../format-param';
import { modDepthDeps, modDepthFor, modOffsetFor, modSignFor } from '../../state/mod-depth';
import { tempoLockFor } from '../../state/tempo-lock';
import { createTempoLock, type TempoLock } from './tempo-lock';

export interface KnobOptions {
  bus: ParamBus;
  paramId: string;
  label?: string;
  size?: number;
  /**
   * Soft ceiling in **param units** (10 = 10 Hz, not a fraction): above it the
   * value arc stops filling, so travel the engine does not act on reads as dead
   * rather than live (knob-soft-ceiling.md REQ-1). Paint only — the drag, the
   * pointer line and the readout still cover the whole registered range.
   */
  uiMax?: number;
}

const SWEEP_DEG = 280; // Knob sweeps from -140° to +140°
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Decimal places kept when rounding the indicator angle / arc dash for the
 * repaint guards in `render`. Two places is ~0.005° and ~0.01 px on a 56 px
 * dial — far below anything a display can resolve, so the rounding is invisible
 * while collapsing the redundant writes an automated sweep produces.
 */
const ROTATION_PRECISION = 2;
const ARC_PRECISION = 2;

/** Radius of the modulation range ring — inside the value arc's 26, so the two
 *  never overlap and a bipolar band stays visible on both sides of the value. */
const MOD_ARC_R = 21;

/** Angular width of the live-position tick, in degrees of the knob's sweep. */
const MARKER_DEG = 7;

export class Knob {
  readonly el: HTMLElement;
  private readonly indicator: HTMLElement;
  private readonly arc: SVGCircleElement;
  private readonly valueLabel: HTMLElement;
  private readonly def: ParamDef;
  private unsubscribe: () => void = () => {};
  private dragging = false;
  private startY = 0;
  private startValue = 0;
  private fine = false;
  private lastTap = 0;
  private disabled = false;
  private circumference: number;
  /** Soft ceiling as a normalized position — converted once on set, not per
   *  frame. `1` (the default) means no ceiling. See `setUiMax`. */
  private uiMaxNorm = 1;
  /** The dead-travel marker, built on demand — see `paintDead`. */
  private dead: SVGCircleElement | null = null;
  /**
   * The tempo lock, on the handful of params that have one (tempo-lock.md REQ-1).
   * `undefined` for every other knob, which therefore grows no extra node and
   * takes no extra subscription.
   */
  private lock: TempoLock | undefined;
  /**
   * The modulation range arc, built on demand — most knobs never have one, and a
   * knob nothing modulates must cost nothing (mod-matrix.md REQ-8).
   */
  private modArc: SVGCircleElement | null = null;
  /** Reach of the routes pointed here, in **param units**. 0 = no arc. */
  private modDepth = 0;
  private lastModDash = '';
  /**
   * Live position inside the band, from sources the main thread already knows — the
   * mod wheel today. `null` when there are none, which is the usual case.
   */
  private modOffset: number | null = null;
  private modMarker: SVGCircleElement | null = null;
  private lastMarkerDash = '';
  /** -1 when every route here is inverted; 0 when mixed or none; 1 when all positive. */
  private modSign: -1 | 0 | 1 = 0;
  /** Last values actually written to the DOM — see `render`. */
  private lastDeg = '';
  private lastDash = '';
  private lastLabel = '';

  constructor(private readonly opts: KnobOptions) {
    const bus = opts.bus;
    const def = bus.def(opts.paramId);
    if (!def) throw new Error(`Unknown param: ${opts.paramId}`);
    this.def = def;

    this.el = document.createElement('div');
    this.el.className = styles.root!;
    this.el.dataset.testid = `knob-${opts.paramId}`;
    if (opts.size) this.el.style.setProperty('--knob-size', `${opts.size}px`);

    const label = document.createElement('div');
    label.className = styles.label!;
    const labelText = opts.label ?? this.deriveLabel(opts.paramId);
    label.textContent = labelText;
    this.el.appendChild(label);

    const dial = document.createElement('div');
    dial.className = styles.dial!;

    this.indicator = document.createElement('div');
    this.indicator.className = styles.indicator!;
    dial.appendChild(this.indicator);

    const svgNS = SVG_NS;
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', styles.arc!);
    svg.setAttribute('viewBox', '0 0 56 56');
    const trackCircle = document.createElementNS(svgNS, 'circle');
    trackCircle.setAttribute('class', styles.track!);
    trackCircle.setAttribute('cx', '28');
    trackCircle.setAttribute('cy', '28');
    trackCircle.setAttribute('r', '26');
    const valueCircle = document.createElementNS(svgNS, 'circle');
    valueCircle.setAttribute('class', styles.value!);
    valueCircle.setAttribute('cx', '28');
    valueCircle.setAttribute('cy', '28');
    valueCircle.setAttribute('r', '26');
    this.circumference = 2 * Math.PI * 26;
    const dashOn = (this.circumference * SWEEP_DEG) / 360;
    const dashOff = this.circumference - dashOn;
    valueCircle.setAttribute('stroke-dasharray', `${dashOn} ${dashOff}`);
    // Rotate so the sweep starts at -140° from top
    valueCircle.setAttribute('transform', `rotate(${90 + (360 - SWEEP_DEG) / 2} 28 28)`);
    trackCircle.setAttribute('stroke-dasharray', `${dashOn} ${dashOff}`);
    trackCircle.setAttribute('transform', `rotate(${90 + (360 - SWEEP_DEG) / 2} 28 28)`);
    svg.appendChild(trackCircle);
    svg.appendChild(valueCircle);
    dial.appendChild(svg);

    this.arc = valueCircle;
    this.el.appendChild(dial);

    this.valueLabel = document.createElement('div');
    this.valueLabel.className = styles.num!;
    this.el.appendChild(this.valueLabel);

    // Drag listeners are attached to `window` on pointerdown and removed on
    // pointerup/destroy (see specs/recipes/add-a-ui-component.md) — a
    // constructor-attached window listener would leak on every rebuilt Knob
    // (the drum tuning strip rebuilds on track change) and run on every page
    // pointer move.
    dial.addEventListener('pointerdown', this.onPointerDown);

    // Before the subscribe: `subscribe` fires immediately, so the very first
    // paint already honours the ceiling and no separate repaint is needed.
    if (opts.uiMax !== undefined) this.applyUiMax(opts.uiMax);

    // Self-wiring, ADR-008 — the same shape as the `modDepthDeps` block below:
    // the knob asks whether its *own* param can be locked to the tempo and grows
    // the control only if so (tempo-lock.md REQ-1). Almost none can, so almost
    // every knob builds nothing here. Before the value subscription, so the very
    // first paint already shows the derived readout.
    const quantity = tempoLockFor(opts.paramId);
    if (quantity !== undefined) {
      const lock = createTempoLock({
        bus,
        paramId: opts.paramId,
        quantity,
        label: labelText,
        host: {
          setSynced: (on) => this.el.classList.toggle('synced', on),
          repaint: () => this.render(bus.get(opts.paramId)),
        },
      });
      this.lock = lock;
      // The glyph hangs in the gutter to the left of the label; the chip is a
      // **sibling** of the dial, never a child — the drag listener lives on the
      // dial, so a chip inside it would start a drag (tempo-lock.md REQ-3).
      this.el.classList.add(styles.hasLock!);
      label.insertBefore(lock.lock, label.firstChild);
      this.el.insertBefore(lock.chip, this.valueLabel);
      // `createTempoLock` paints once from its own immediate subscription fire,
      // which lands before `this.lock` exists — so the readout it produced is the
      // raw param value. Repaint now that the lock can be consulted.
      this.render(bus.get(opts.paramId));
    }

    this.unsubscribe = bus.subscribe(opts.paramId, (v) => this.render(v));

    // Self-wiring, ADR-008: the knob asks whether anything can modulate *it* and
    // subscribes only if so. `modDepthDeps` is empty for all but a handful of params,
    // so the ~100 knobs on the faceplate overwhelmingly subscribe to nothing here.
    const deps = modDepthDeps(opts.paramId);
    if (deps.length > 0) {
      const read = (id: string): number => bus.get(id);
      const refresh = (): void => {
        this.setModDepth(modDepthFor(opts.paramId, read));
        this.setModOffset(modOffsetFor(opts.paramId, read));
        // The band itself carries the sign, so an inverted route is visible on the
        // faceplate with the matrix window shut (mod-matrix.md REQ-13).
        this.setModSign(modSignFor(opts.paramId, read));
      };
      const unsubs = deps.map((id) => bus.subscribe(id, refresh));
      const dropValue = this.unsubscribe;
      this.unsubscribe = (): void => {
        dropValue();
        for (const u of unsubs) u();
      };
    }
  }

  /**
   * Paint the dial. Each of the three writes is guarded on what it is about to
   * *write* rather than on the incoming value, so the DOM never lags behind the
   * latest value at the resolution actually rendered (the same discipline as
   * `Scope.mirrorPeak` and `StepButton.setViz`; runtime-performance.md REQ-7).
   *
   * This matters because a knob is not only dragged: the motion sequencer
   * automates up to four params at frame rate, and a slow sweep re-writes the
   * same rounded angle and the same formatted string for many frames running.
   * The angle is rounded to ROTATION_PRECISION first — finer than a knob 56 px
   * across can show — which is what turns "almost always different" into
   * "usually the same".
   */
  private render(value: number): void {
    const norm = this.normalize(value);
    const startDeg = -SWEEP_DEG / 2;
    const deg = (startDeg + norm * SWEEP_DEG).toFixed(ROTATION_PRECISION);
    if (deg !== this.lastDeg) {
      this.lastDeg = deg;
      this.indicator.style.transform = `translateX(-50%) rotate(${deg}deg)`;
    }

    // The arc — and only the arc — stops at the soft ceiling
    // (knob-soft-ceiling.md REQ-2). Capping *before* the `lastDash` guard means a
    // value moving around above the ceiling writes nothing at all, so a capped
    // knob is cheaper to automate than an uncapped one, never dearer (REQ-7).
    const dashOn = (this.circumference * SWEEP_DEG) / 360;
    const visible = dashOn * Math.min(norm, this.uiMaxNorm);
    const dash = `${visible.toFixed(ARC_PRECISION)} ${(this.circumference - visible).toFixed(ARC_PRECISION)}`;
    if (dash !== this.lastDash) {
      this.lastDash = dash;
      this.arc.setAttribute('stroke-dasharray', dash);
    }

    // While tempo-locked the knob is not what sets the value, so the readout
    // shows the one that is — `2.67Hz`, `375ms` — formatted through the param's
    // own `format` (tempo-lock.md REQ-3). The dial is off screen in that state,
    // so the arc and pointer above keep tracking the stored value undisturbed.
    const label = this.formatValue(this.lock?.effectiveValue() ?? value);
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      this.valueLabel.textContent = label;
    }

    if (this.modDepth > 0) this.paintModRange(value);
    if (this.modOffset !== null) this.paintModMarker(value);
  }

  /**
   * A tick showing where a **main-thread-knowable** source currently has this param —
   * the mod wheel (mod-matrix.md REQ-11).
   *
   * The band alone says how far a route *can* move the knob; for a control the player
   * is holding, that reads as nothing happening. This is the one source whose live
   * value costs nothing to know, so it is the one that gets a position.
   */
  private paintModMarker(value: number): void {
    const circ = 2 * Math.PI * MOD_ARC_R;
    const dashOn = (circ * SWEEP_DEG) / 360;
    const at = clamp01(this.normalize(value + (this.modOffset ?? 0)));
    const seg = (dashOn * MARKER_DEG) / SWEEP_DEG;
    // Centred on the position, so it does not drift off the end at the extremes.
    const start = Math.max(0, Math.min(dashOn - seg, dashOn * at - seg / 2));
    const dash = `${seg.toFixed(ARC_PRECISION)} ${(circ - seg).toFixed(ARC_PRECISION)}`;
    const offset = (-start).toFixed(ARC_PRECISION);
    const key = `${dash}|${offset}`;
    if (key === this.lastMarkerDash) return;
    this.lastMarkerDash = key;
    const m = this.ensureModMarker();
    m.setAttribute('stroke-dasharray', dash);
    m.setAttribute('stroke-dashoffset', offset);
  }

  private ensureModMarker(): SVGCircleElement {
    if (this.modMarker) return this.modMarker;
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', styles.modMarker!);
    c.setAttribute('cx', '28');
    c.setAttribute('cy', '28');
    c.setAttribute('r', String(MOD_ARC_R));
    c.setAttribute('transform', `rotate(${90 + (360 - SWEEP_DEG) / 2} 28 28)`);
    // Above the band it rides in, below the value arc.
    this.arc.parentNode!.insertBefore(c, this.arc);
    this.modMarker = c;
    return c;
  }

  /** Colour the band and tick by which way the routes push (REQ-13). */
  setModSign(sign: -1 | 0 | 1): void {
    if (sign === this.modSign) return;
    this.modSign = sign;
    this.el.classList.toggle(styles.modPos!, sign === 1);
    this.el.classList.toggle(styles.modNeg!, sign === -1);
  }

  /**
   * Set the live position, in **param units** offset from the knob's own value, or
   * `null` when no main-thread-knowable source targets this param.
   */
  setModOffset(offset: number | null): void {
    if (offset === this.modOffset) return;
    this.modOffset = offset;
    if (offset === null) {
      this.modMarker?.remove();
      this.modMarker = null;
      this.lastMarkerDash = '';
      return;
    }
    this.lastMarkerDash = '';
    this.render(this.opts.bus.get(this.opts.paramId));
  }

  /**
   * The band modulation can move this knob over: `value ± depth`, drawn behind the
   * value arc (mod-matrix.md REQ-8).
   *
   * Both ends are converted through the param's own taper rather than offsetting the
   * normalized position, so the arc is honest on a `power`-tapered knob like
   * `filter.resonance`, where equal param steps are not equal travel.
   *
   * This shows **reach, not position**. Where modulation currently *is* lives on the
   * audio thread and is per-voice — eight voices have eight different filter-envelope
   * values — so drawing it would need a port message per frame and an answer to
   * "which voice?". Reach costs nothing and answers the question a player actually
   * has: how far will this move?
   */
  private paintModRange(value: number): void {
    // Its own, smaller circumference: the band rides an INNER ring (MOD_ARC_R), not
    // the value arc's radius. Sharing the radius put the value arc on top of the
    // band's lower half, so a bipolar route — which swings both ways — read as
    // one-sided headroom.
    const circ = 2 * Math.PI * MOD_ARC_R;
    const dashOn = (circ * SWEEP_DEG) / 360;
    const lo = clamp01(this.normalize(value - this.modDepth));
    const hi = clamp01(this.normalize(value + this.modDepth));
    const seg = dashOn * Math.max(0, hi - lo);
    const dash = `${seg.toFixed(ARC_PRECISION)} ${(circ - seg).toFixed(ARC_PRECISION)}`;
    const offset = (-dashOn * lo).toFixed(ARC_PRECISION);
    const key = `${dash}|${offset}`;
    if (key === this.lastModDash) return;
    this.lastModDash = key;
    const arc = this.ensureModArc();
    arc.setAttribute('stroke-dasharray', dash);
    arc.setAttribute('stroke-dashoffset', offset);
  }

  private ensureModArc(): SVGCircleElement {
    if (this.modArc) return this.modArc;
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', styles.modRange!);
    c.setAttribute('cx', '28');
    c.setAttribute('cy', '28');
    c.setAttribute('r', String(MOD_ARC_R));
    c.setAttribute('transform', `rotate(${90 + (360 - SWEEP_DEG) / 2} 28 28)`);
    // Behind the value arc: the value is what you set, the band is context.
    this.arc.parentNode!.insertBefore(c, this.arc);
    this.modArc = c;
    return c;
  }

  /**
   * Set how far modulation can move this knob, in **param units**. `0` removes the
   * arc. Called by the self-wiring in the constructor; also usable directly.
   */
  setModDepth(depth: number): void {
    const d = Math.max(0, depth);
    if (d === this.modDepth) return;
    this.modDepth = d;
    if (d === 0) {
      this.modArc?.remove();
      this.modArc = null;
      this.lastModDash = '';
      return;
    }
    this.lastModDash = '';                       // force a repaint at the new depth
    this.render(this.opts.bus.get(this.opts.paramId));
  }

  private normalize(v: number): number {
    return toNorm(this.def, v);
  }

  private denormalize(n: number): number {
    return fromNorm(this.def, n);
  }

  private formatValue(v: number): string {
    return formatParam(this.def, v);
  }

  private deriveLabel(id: string): string {
    return id.split('.').pop()!.toUpperCase();
  }

  /**
   * Set (or clear, with `null`) the soft ceiling — the point past which the
   * value arc stops filling (knob-soft-ceiling.md REQ-4). Given in **param
   * units**, so `setUiMax(10)` on `lfo.rate` caps the arc at 10 Hz.
   *
   * Use this where the ceiling only applies in some states — the LFO RATE knob
   * is capped only while `lfo.dest === pulse`, because that is the only path the
   * engine clamps (oscillators.md REQ-9). Where a control is inert *entirely*,
   * `setDisabled` is the right treatment instead (REQ-8): a soft ceiling says
   * "this part of the travel does nothing", dimming says "none of it does".
   */
  setUiMax(max: number | null): void {
    if (!this.applyUiMax(max)) return;
    this.render(this.opts.bus.get(this.opts.paramId));
  }

  /** Shared by the constructor and `setUiMax`; returns whether it changed. The
   *  constructor skips the repaint because `subscribe` is about to paint anyway. */
  private applyUiMax(max: number | null): boolean {
    // `toNorm` does not clamp (only `fromNorm` does), so a ceiling outside
    // [min, max] is clamped here rather than producing an arc past full.
    const n = max === null ? 1 : clamp01(toNorm(this.def, max));
    if (n === this.uiMaxNorm) return false;
    this.uiMaxNorm = n;
    if (max === null || n >= 1) {
      delete this.el.dataset.uimax;
      this.dead?.remove();
      this.dead = null;
    } else {
      this.el.dataset.uimax = String(max);
      this.paintDead(n);
    }
    return true;
  }

  /**
   * Draw the dead travel: a dim red arc from the ceiling to the end of the sweep
   * (knob-soft-ceiling.md REQ-5). Built on demand and inserted *under* the value
   * arc, so a knob with no ceiling carries no extra node.
   *
   * Unlike `.track`/`.value` this arc does not start at the sweep origin, so it
   * needs a `stroke-dashoffset` — negative, which delays where the dash begins.
   * It depends only on the ceiling, never on the value, so it is painted here
   * rather than in `render` and costs nothing on the automation path.
   */
  private paintDead(n: number): void {
    if (!this.dead) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', styles.dead!);
      c.setAttribute('cx', '28');
      c.setAttribute('cy', '28');
      c.setAttribute('r', '26');
      c.setAttribute('transform', `rotate(${90 + (360 - SWEEP_DEG) / 2} 28 28)`);
      this.arc.parentNode!.insertBefore(c, this.arc);
      this.dead = c;
    }
    const dashOn = (this.circumference * SWEEP_DEG) / 360;
    const len = dashOn * (1 - n);
    this.dead.setAttribute(
      'stroke-dasharray',
      `${len.toFixed(ARC_PRECISION)} ${(this.circumference - len).toFixed(ARC_PRECISION)}`,
    );
    this.dead.setAttribute('stroke-dashoffset', (-(dashOn * n)).toFixed(ARC_PRECISION));
  }

  /**
   * Disable input (e.g. the BPM knob while slaved — midi-clock-sync REQ-14):
   * dims the control and blocks both dragging and the double-tap reset. The bus
   * value still repaints, so the dial keeps reflecting the (external) value.
   */
  setDisabled(on: boolean): void {
    this.disabled = on;
    this.el.classList.toggle(styles.disabled!, on);
    this.el.setAttribute('aria-disabled', String(on));
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.disabled) return; // blocks drag AND double-tap reset
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);

    const now = performance.now();
    if (now - this.lastTap < 300) {
      // Reset to the active preset/song value if one set it, else the global
      // default (see specs/features/param-reset-baseline.md).
      this.opts.bus.reset(this.opts.paramId);
      this.lastTap = 0;
      return;
    }
    this.lastTap = now;

    this.dragging = true;
    this.startY = e.clientY;
    this.startValue = this.opts.bus.get(this.opts.paramId);
    this.fine = e.shiftKey;
    this.el.classList.add('dragging');
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dy = this.startY - e.clientY;
    const sensitivity = this.fine || e.shiftKey ? 600 : 200;
    const deltaNorm = dy / sensitivity;
    const startNorm = this.normalize(this.startValue);
    const newValue = this.denormalize(startNorm + deltaNorm);
    this.opts.bus.set(this.opts.paramId, newValue);
  };

  private onPointerUp = (_: PointerEvent): void => {
    this.detachDragListeners();
    if (!this.dragging) return;
    this.dragging = false;
    this.el.classList.remove('dragging');
  };

  private detachDragListeners(): void {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }

  destroy(): void {
    this.unsubscribe();
    this.detachDragListeners();
    this.lock?.destroy();
  }
}
