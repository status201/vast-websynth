/**
 * The signal-flow map: the poster inlined, a camera on it, hotspots for the
 * zones and a panel that says where you are (specs/features/signal-flow-map.md).
 *
 * Generic on purpose: it is handed the SVG text and the zone manifest and knows
 * nothing about the synth. The maths is `camera.ts`, the walks over the zones
 * `zones.ts`; this file is the DOM and the gestures.
 */
import styles from '../styles/signal-flow.module.css';
import switchStyles from '../styles/switch.module.css';
import { createButton } from '../components/button';
import { UI_ICONS } from '../components/ui-icons';
import { localRect, toLocal } from '../ui-scale';
import {
  clampView, ease, fitRect, lerpView, panBy, reshape, zoomAt, OVERVIEW_PAD,
  type Rect, type Size, type View,
} from './camera';
import {
  ancestors, childrenOf, hotspotsFor, resolveLink, tourIndex, tourStep, zoneById,
  type Spot, type Zone, type ZoneManifest,
} from './zones';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** A press that moves less than this (px) is a tap, not a drag. */
const TAP_SLOP = 6;
const DOUBLE_TAP_MS = 320;
const TWEEN_MS = 420;
/** The margin around a picked zone, as a fraction of its size. */
const ZONE_PAD = 0.035;
/** The keyboard / button zoom step. */
const ZOOM_STEP = 1.4;
/** A zone narrower than this on screen (px) keeps its outline but not its label. */
const MIN_LABEL_ZONE_PX = 56;
/** Before the stage has a size (not laid out yet; jsdom). */
const FALLBACK: Size = { w: 1200, h: 700 };

export interface SignalFlowMapOptions {
  /** The poster, as SVG text — a bundled constant, never user input (REQ-the-poster-is-csp-safe). */
  svgText: string;
  manifest: ZoneManifest;
}

interface Press {
  x: number;
  y: number;
}

interface Hotspot {
  zone: Zone;
  label: HTMLElement;
}

export class SignalFlowMap {
  readonly root: HTMLElement;

  private readonly m: ZoneManifest;
  private readonly bounds: Rect;
  private readonly stage: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly hotLayer: SVGGElement;
  /** The rings a deep link draws around its blocks. */
  private readonly spotLayer: SVGGElement;
  private readonly labelLayer: HTMLElement;
  private readonly panel: {
    crumbs: HTMLElement;
    title: HTMLElement;
    blurb: HTMLElement;
    ringed: HTMLElement;
    prev: HTMLButtonElement;
    next: HTMLButtonElement;
    count: HTMLElement;
    listHead: HTMLElement;
    list: HTMLElement;
  };

  private view: View;
  private size: Size = FALLBACK;
  private laidOut = false;
  /** Still framing the picked zone (no pan or zoom since): a resize re-frames it. */
  private framing = true;
  private focusId: string | null = null;
  private hotspots: Hotspot[] = [];
  private raf = 0;
  private readonly ro: ResizeObserver | null;

  // Gesture state: the pointers down, and the view + pointers when it began.
  private readonly down = new Map<number, Press>();
  private start: { view: View; presses: Press[] } | null = null;
  private dragged = false;
  /** This gesture has had two pointers down at once: a pinch, never a tap. */
  private multi = false;
  private lastTap = { t: 0, x: 0, y: 0 };

  constructor(opts: SignalFlowMapOptions) {
    this.m = opts.manifest;
    this.bounds = { x: 0, y: 0, w: this.m.width, h: this.m.height };

    this.root = el('div', styles.map);
    this.stage = el('div', styles.stage);
    this.stage.tabIndex = 0;
    this.stage.dataset.testid = 'signal-flow-map';
    this.stage.setAttribute('role', 'group');
    this.stage.setAttribute('aria-label', 'Signal-flow map. Arrow keys move, plus and minus zoom, Home shows everything.');

    this.svg = parsePoster(opts.svgText);
    this.svg.classList.add(styles.poster!);
    // The stage around the poster wears the poster's own paper, so its margins
    // read as more poster rather than as a frame.
    const paper = this.svg.querySelector(':scope > rect')?.getAttribute('fill');
    if (paper) this.stage.style.setProperty('--poster-bg', paper);
    this.spotLayer = document.createElementNS(SVG_NS, 'g');
    this.spotLayer.setAttribute('aria-hidden', 'true');
    this.hotLayer = document.createElementNS(SVG_NS, 'g');
    this.hotLayer.setAttribute('aria-hidden', 'true');
    this.svg.append(this.spotLayer, this.hotLayer);
    this.labelLayer = el('div', styles.labels);
    this.labelLayer.setAttribute('aria-hidden', 'true');

    this.stage.append(this.svg, this.labelLayer, this.buildZoomControls());
    const aside = el('aside', styles.panel);
    this.panel = this.buildPanel(aside);
    this.root.append(this.stage, aside);

    this.view = fitRect(this.bounds, this.size, OVERVIEW_PAD);
    this.listen();
    this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.measure()) : null;
    this.ro?.observe(this.stage);
    this.focus(null);
  }

  /** The picked zone; `null` at the overview. */
  get focused(): string | null {
    return this.focusId;
  }

  /** Pick a zone (`null` = the overview): panel, hotspots, and a zoom to it. */
  focus(id: string | null): void {
    this.go(id, []);
  }

  /**
   * Go to a deep link's place (REQ-a-help-topic-shows-its-place): the zone that
   * holds all of `ids` (zone or spot ids), with each spot ringed. `false` when
   * none of them is on the poster — the map is left where it was.
   */
  show(ids: readonly string[]): boolean {
    const target = resolveLink(this.m, ids);
    if (!target) return false;
    this.go(target.zone, target.spots);
    return true;
  }

  private go(id: string | null, spots: readonly Spot[]): void {
    const zone = id === null ? undefined : zoneById(this.m, id);
    this.focusId = zone ? zone.id : null;
    this.renderPanel(zone, spots);
    this.renderHotspots();
    this.renderRings(spots);
    this.frame();
  }

  /** A ring around each spot; any earlier rings go. */
  private renderRings(spots: readonly Spot[]): void {
    this.spotLayer.replaceChildren(...spots.map((sp) => {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('class', styles.ring!);
      r.dataset.testid = 'signal-flow-ring';
      r.dataset.spot = sp.id;
      const pad = 10;
      for (const [k, v] of [['x', sp.x - pad], ['y', sp.y - pad], ['width', sp.w + 2 * pad], ['height', sp.h + 2 * pad], ['rx', 16]] as const) {
        r.setAttribute(k, String(v));
      }
      return r;
    }));
  }

  /** Frame the picked zone (or the overview), and keep framing it through resizes. */
  private frame(): void {
    this.framing = true;
    this.animateTo(this.homeView());
  }

  /** Up one level (REQ-escape-steps-out-before-it-closes); `false` at the overview. */
  stepOut(): boolean {
    if (this.focusId === null) return false;
    this.focus(zoneById(this.m, this.focusId)?.parent ?? null);
    return true;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
  }

  // ── view ───────────────────────────────────────────────────────────────

  /** Where the current focus is framed: its zone, or the whole poster. */
  private homeView(): View {
    const zone = this.focusId === null ? undefined : zoneById(this.m, this.focusId);
    const v = zone ? fitRect(zone, this.size, ZONE_PAD) : fitRect(this.bounds, this.size, OVERVIEW_PAD);
    return clampView(v, this.bounds, this.size);
  }

  private setView(v: View): void {
    this.view = v;
    this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    this.placeLabels();
  }

  /** Move to `target`, animated unless motion is reduced or nothing is on screen yet. */
  private animateTo(target: View): void {
    this.stopAnimation();
    if (!this.laidOut || reducedMotion()) {
      this.setView(target);
      return;
    }
    const from = this.view;
    const t0 = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / TWEEN_MS);
      this.setView(lerpView(from, target, ease(t)));
      this.raf = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.raf = requestAnimationFrame(step);
  }

  private stopAnimation(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** A user move: immediate, and kept inside the limits. */
  private moveTo(v: View): void {
    this.framing = false;
    this.stopAnimation();
    this.setView(clampView(v, this.bounds, this.size));
  }

  private zoomAbout(factor: number, at?: [number, number]): void {
    const [px, py] = at ?? [this.view.x + this.view.w / 2, this.view.y + this.view.h / 2];
    this.moveTo(zoomAt(this.view, factor, px, py));
  }

  /** The stage's size changed (or is known for the first time). */
  private measure(): void {
    const r = this.stage.getBoundingClientRect();
    const local = localRect(r);
    if (local.width < 1 || local.height < 1) return;
    const next = { w: local.width, h: local.height };
    const first = !this.laidOut;
    const before = this.size;
    this.size = next;
    this.laidOut = true;
    // The panel's text can resize the stage mid-zoom (it sits under the stage on
    // a phone): while framing, aim at the new frame; after a user move, keep
    // their centre and scale.
    if (first) this.setView(this.homeView());
    else if (this.framing) this.animateTo(this.homeView());
    else this.moveTo(reshape(this.view, before, next));
  }

  /** A client point, in poster units under the current view. */
  private toPoster(clientX: number, clientY: number): [number, number] {
    const r = localRect(this.stage.getBoundingClientRect());
    const w = r.width || this.size.w;
    const h = r.height || this.size.h;
    const lx = toLocal(clientX) - r.left;
    const ly = toLocal(clientY) - r.top;
    return [this.view.x + (lx * this.view.w) / w, this.view.y + (ly * this.view.h) / h];
  }

  /** Poster units per screen px. */
  private unitsPerPx(): number {
    return this.view.w / this.size.w;
  }

  // ── hotspots ───────────────────────────────────────────────────────────

  private renderHotspots(): void {
    this.hotLayer.replaceChildren();
    this.labelLayer.replaceChildren();
    // A leaf offers its neighbours: quieter than an area's own parts.
    const near = this.focusId !== null && childrenOf(this.m, this.focusId).length === 0;
    this.hotLayer.classList.toggle(styles.near!, near);
    this.labelLayer.classList.toggle(styles.near!, near);
    this.hotspots = hotspotsFor(this.m, this.focusId).map((zone) => {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', styles.hot!);
      g.dataset.zone = zone.id;
      g.dataset.testid = 'signal-flow-zone';
      const rect = document.createElementNS(SVG_NS, 'rect');
      for (const [k, v] of [['x', zone.x], ['y', zone.y], ['width', zone.w], ['height', zone.h], ['rx', 14]] as const) {
        rect.setAttribute(k, String(v));
      }
      g.appendChild(rect);
      this.hotLayer.appendChild(g);
      const label = el('span', styles.label, zone.title);
      this.labelLayer.appendChild(label);
      return { zone, label };
    });
    this.placeLabels();
  }

  /** Each hotspot's label at its zone's top-left corner, in screen px, at a fixed size. */
  private placeLabels(): void {
    const k = 1 / this.unitsPerPx();
    for (const { zone, label } of this.hotspots) {
      const left = (zone.x - this.view.x) * k;
      const top = (zone.y - this.view.y) * k;
      const width = zone.w * k;
      const height = zone.h * k;
      const off = left + width < 0 || top + height < 0 || left > this.size.w || top > this.size.h
        || width < MIN_LABEL_ZONE_PX;
      label.hidden = off;
      if (off) continue;
      label.style.setProperty('--x', `${Math.max(left, 0) + 6}px`);
      label.style.setProperty('--y', `${Math.max(top, 0) + 6}px`);
      label.style.setProperty('--w', `${Math.max(width - 12, 40)}px`);
    }
  }

  /** The smallest hotspot under a poster point. */
  private hotspotAt(px: number, py: number): Zone | undefined {
    return this.hotspots
      .map((h) => h.zone)
      .filter((z) => px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h)
      .sort((a, b) => a.w * a.h - b.w * b.h)[0];
  }

  // ── panel ──────────────────────────────────────────────────────────────

  private buildPanel(aside: HTMLElement): SignalFlowMap['panel'] {
    const crumbs = el('nav', styles.crumbs);
    crumbs.setAttribute('aria-label', 'Where you are');
    const title = el('h3', styles.title);
    title.dataset.testid = 'signal-flow-title';
    title.setAttribute('aria-live', 'polite');
    const blurb = el('p', styles.blurb);
    const ringed = el('p', styles.ringed);
    ringed.dataset.testid = 'signal-flow-ringed';
    const steps = el('div', styles.steps);
    const prev = createButton({
      label: 'Prev', iconBefore: UI_ICONS.chevronLeft, className: switchStyles.root!, testId: 'signal-flow-prev',
      title: 'Back along the signal', onClick: () => this.walk(-1),
    });
    const next = createButton({
      label: 'Next', iconAfter: UI_ICONS.chevronRight, className: switchStyles.root!, testId: 'signal-flow-next',
      title: 'Follow the signal', onClick: () => this.walk(1),
    });
    const count = el('span', styles.count);
    steps.append(prev, count, next);
    const listHead = el('div', styles.listHead);
    const list = el('div', styles.list);
    const hint = el('p', styles.hint, 'Drag to move · scroll or pinch to zoom · Esc steps back');
    aside.append(crumbs, title, ringed, blurb, steps, listHead, list, hint);
    return { crumbs, title, blurb, ringed, prev, next, count, listHead, list };
  }

  private renderPanel(zone: Zone | undefined, spots: readonly Spot[] = []): void {
    const p = this.panel;
    const crumb = (label: string, id: string | null, testId?: string): HTMLButtonElement => createButton({
      label, className: styles.crumb!, testId, onClick: () => this.focus(id),
    });
    const sep = (): HTMLElement => el('span', styles.crumbSep, '›');
    const trail: HTMLElement[] = [];
    if (zone) {
      trail.push(crumb('Overview', null, 'signal-flow-overview'));
      for (const a of ancestors(this.m, zone.id)) trail.push(sep(), crumb(a.title, a.id));
    }
    p.crumbs.replaceChildren(...trail);
    p.crumbs.hidden = !zone;

    p.title.textContent = zone ? zone.title : 'Overview';
    p.blurb.textContent = zone ? zone.blurb : this.m.intro;
    p.ringed.textContent = spots.length ? `Ringed: ${spots.map((sp) => sp.title).join(' · ')}` : '';
    p.ringed.hidden = !spots.length;

    const id = zone?.id ?? null;
    p.prev.disabled = !tourStep(this.m, id, -1);
    p.next.disabled = !tourStep(this.m, id, 1);
    const at = tourIndex(this.m, id);
    p.count.textContent = at ? `${at} / ${this.m.tour.length}` : '';

    const kids = childrenOf(this.m, id);
    const offer = hotspotsFor(this.m, id);
    p.listHead.textContent = id === null ? 'Areas' : kids.length ? 'Inside' : 'Next door';
    p.list.replaceChildren(...offer.map((z) => {
      const b = createButton({ label: z.title, className: switchStyles.root!, testId: 'signal-flow-area', onClick: () => this.focus(z.id) });
      b.dataset.zone = z.id;
      return b;
    }));
    p.listHead.hidden = offer.length === 0;
  }

  private walk(dir: 1 | -1): void {
    const step = tourStep(this.m, this.focusId, dir);
    if (step) this.focus(step.to);
  }

  private buildZoomControls(): HTMLElement {
    const box = el('div', styles.zoom);
    box.append(
      createButton({ label: 'Zoom in', icon: UI_ICONS.plus, className: switchStyles.root!, testId: 'signal-flow-zoom-in', onClick: () => this.zoomAbout(ZOOM_STEP) }),
      createButton({ label: 'Zoom out', icon: UI_ICONS.minus, className: switchStyles.root!, testId: 'signal-flow-zoom-out', onClick: () => this.zoomAbout(1 / ZOOM_STEP) }),
      createButton({ label: 'Fit', title: 'Frame the picked area again', className: switchStyles.root!, testId: 'signal-flow-fit', onClick: () => this.frame() }),
    );
    // The buttons sit on the stage; a press on them is not the start of a drag.
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    return box;
  }

  // ── gestures (the gesture inventory in signal-flow-map.md) ─────────────

  private listen(): void {
    const s = this.stage;
    s.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.stopAnimation();
      this.down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { s.setPointerCapture(e.pointerId); } catch { /* jsdom, or a pointer already gone */ }
      if (this.down.size === 1) {
        this.dragged = false;
        this.multi = false;
      } else {
        this.multi = true;
      }
      this.start = { view: this.view, presses: this.snapshot() };
    });
    s.addEventListener('pointermove', (e) => {
      const p = this.down.get(e.pointerId);
      if (!p || !this.start) return;
      p.x = e.clientX;
      p.y = e.clientY;
      const [a, b] = [...this.down.values()];
      const [a0, b0] = this.start.presses;
      if (!a || !a0) return;
      if (b && b0) {
        this.dragged = true;
        this.pinch(a0, b0, a, b);
        return;
      }
      const dx = toLocal(a.x - a0.x);
      const dy = toLocal(a.y - a0.y);
      if (!this.dragged && Math.hypot(dx, dy) < TAP_SLOP) return;
      this.dragged = true;
      s.classList.add(styles.dragging!);
      const u = this.start.view.w / this.size.w;
      this.moveTo(panBy(this.start.view, -dx * u, -dy * u));
    });
    const end = (e: PointerEvent): void => {
      if (!this.down.has(e.pointerId)) return;
      const wasOnly = this.down.size === 1;
      this.down.delete(e.pointerId);
      // The fingers left behind start a fresh gesture from here.
      this.start = this.down.size ? { view: this.view, presses: this.snapshot() } : null;
      if (!this.down.size) s.classList.remove(styles.dragging!);
      if (e.type === 'pointerup' && wasOnly && !this.dragged && !this.multi) this.tap(e.clientX, e.clientY);
    };
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
    s.addEventListener('wheel', (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.size.h : 1;
      // A trackpad pinch arrives as a ctrl+wheel with small deltas: steeper.
      const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015));
      this.zoomAbout(factor, this.toPoster(e.clientX, e.clientY));
    }, { passive: false });
    s.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** Copies of the presses now: `down`'s own objects move with the pointers. */
  private snapshot(): Press[] {
    return [...this.down.values()].map((p) => ({ x: p.x, y: p.y }));
  }

  private pinch(a0: Press, b0: Press, a: Press, b: Press): void {
    if (!this.start) return;
    const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
    const d1 = Math.hypot(b.x - a.x, b.y - a.y);
    if (d0 < 1) return;
    const r = localRect(this.stage.getBoundingClientRect());
    const v0 = this.start.view;
    const u0 = v0.w / this.size.w;
    // The poster point that was under the fingers' midpoint stays under it.
    const mx0 = toLocal((a0.x + b0.x) / 2) - r.left;
    const my0 = toLocal((a0.y + b0.y) / 2) - r.top;
    const mx1 = toLocal((a.x + b.x) / 2) - r.left;
    const my1 = toLocal((a.y + b.y) / 2) - r.top;
    const px = v0.x + mx0 * u0;
    const py = v0.y + my0 * u0;
    const zoomed = zoomAt(v0, d1 / d0, px, py);
    const u1 = zoomed.w / this.size.w;
    this.moveTo(panBy(zoomed, (mx0 - mx1) * u1, (my0 - my1) * u1));
  }

  private tap(clientX: number, clientY: number): void {
    const [px, py] = this.toPoster(clientX, clientY);
    const hit = this.hotspotAt(px, py);
    if (hit) {
      this.lastTap.t = 0;
      this.focus(hit.id);
      return;
    }
    const now = performance.now();
    const near = Math.hypot(clientX - this.lastTap.x, clientY - this.lastTap.y) < 24;
    if (now - this.lastTap.t < DOUBLE_TAP_MS && near) {
      this.lastTap.t = 0;
      this.animateTo(clampView(zoomAt(this.view, 2, px, py), this.bounds, this.size));
      return;
    }
    this.lastTap = { t: now, x: clientX, y: clientY };
  }

  /** The stage's keys; a handled key goes no further (input-control.md). */
  private onKey(e: KeyboardEvent): void {
    // Ctrl/Cmd + = is page zoom, Alt + ← is Back: not the map's keys.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const v = this.view;
    const pan = (dx: number, dy: number): void => this.moveTo(panBy(v, dx * v.w * 0.1, dy * v.h * 0.1));
    switch (e.key) {
      case 'ArrowLeft': pan(-1, 0); break;
      case 'ArrowRight': pan(1, 0); break;
      case 'ArrowUp': pan(0, -1); break;
      case 'ArrowDown': pan(0, 1); break;
      case '+': case '=': this.zoomAbout(ZOOM_STEP); break;
      case '-': case '_': this.zoomAbout(1 / ZOOM_STEP); break;
      case 'Home': this.focus(null); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** The poster's root `<svg>`, adopted into this document and sized by CSS. */
function parsePoster(text: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) {
    throw new Error('signal-flow: the poster did not parse');
  }
  const svg = document.importNode(root, true) as unknown as SVGSVGElement;
  // The poster's <title> would be the native tooltip of every point on the map;
  // keep its text as the accessible name instead.
  const title = svg.querySelector(':scope > title');
  if (title) {
    svg.setAttribute('aria-label', title.textContent ?? '');
    svg.removeAttribute('aria-labelledby');
    title.remove();
  }
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
