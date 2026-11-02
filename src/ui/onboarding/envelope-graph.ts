// The ADSR graph drawn under the AMP / FILTER ENV help badges
// (envelope-help-graph.md). Pure drawing: it is handed an envelope, its knob
// readouts and two words of labelling, and knows nothing of params, the bus or
// which envelope it is. The copy around it lives in help-widgets.ts.
import { adsrCurve, type Adsr } from '../../utils/envelope-curve';
import styles from '../styles/tour.module.css';

/** Floor share of the A/D/R time width per span, so a 1 ms attack stays visible
 *  and labelled (REQ-phase-widths-are-proportional-with-a-floor). */
export const ENV_GRAPH_MIN_PHASE = 0.15;

/** Share of the plot the key-held plateau takes. Fixed: how long it lasts is the
 *  player's, not the patch's (REQ-times-are-spans-and-sustain-is-a-level). */
const HOLD_SHARE = 0.24;

// viewBox geometry, in user units.
const G = { w: 320, h: 160, left: 36, right: 10, top: 20, bottom: 112, bracket: 120 };

const SVG_NS = 'http://www.w3.org/2000/svg';

/** What the graph says about itself: its accessible name and its level axis. */
export interface EnvelopeGraphLabels {
  /** "Amp envelope" — the start of the SVG's aria-label. */
  title: string;
  /** "volume" — the word up the level axis. */
  axis: string;
  /** Each knob's formatted readout, exactly as the knob shows it. */
  values: Record<keyof Adsr, string>;
}

/** An SVG element with attributes and a class — never a `style` attribute
 *  (REQ-the-graph-is-accessible-and-csp-safe). */
function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  cls?: string,
  text?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (cls) node.setAttribute('class', cls);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Widths for the A, D and R spans: proportional to their times, but none below
 * `ENV_GRAPH_MIN_PHASE` of `total`. A span that would fall under the floor is
 * pinned to it and the rest share what is left, proportionally.
 */
export function phaseWidths(times: readonly number[], total: number): number[] {
  const floor = total * ENV_GRAPH_MIN_PHASE;
  const pinned = times.map(() => false);
  let widths = times.map(() => 0);
  for (let pass = 0; pass < times.length; pass++) {
    const freeTime = times.reduce((s, t, i) => (pinned[i] ? s : s + t), 0);
    const freeWidth = total - floor * pinned.filter(Boolean).length;
    widths = times.map((t, i) => (pinned[i] ? floor : (freeWidth * t) / freeTime));
    let changed = false;
    widths.forEach((w, i) => {
      if (!pinned[i] && w < floor) {
        pinned[i] = true;
        changed = true;
      }
    });
    if (!changed) break;
  }
  return widths.map((w) => Math.max(w, floor));
}

/** The SVG itself (REQ-the-graph-draws-the-engines-curve, REQ-times-are-spans-and-sustain-is-a-level). */
export function envelopeGraph(env: Adsr, labels: EnvelopeGraphLabels): SVGSVGElement {
  const { values } = labels;
  // Hold for one decay's worth of model time, so the plateau shows the decay
  // finishing its approach to the sustain level.
  const curve = adsrCurve(env, env.decay);
  const plotW = G.w - G.left - G.right;
  const plotH = G.bottom - G.top;
  const holdW = plotW * HOLD_SHARE;
  const [aW, dW, rW] = phaseWidths([env.attack, env.decay, env.release], plotW - holdW) as [
    number,
    number,
    number,
  ];
  const holdX = G.left + aW + dW;
  const xs = [G.left, G.left + aW, holdX, holdX + holdW, holdX + holdW + rW];
  const ts = [0, curve.attackEnd, curve.decayEnd, curve.keyUp, curve.end];
  // Piecewise-linear time → x: each phase onto its own span.
  const xOf = (t: number): number => {
    for (let i = 1; i < ts.length; i++) {
      if (t <= ts[i]! || i === ts.length - 1) {
        const t0 = ts[i - 1]!;
        const span = ts[i]! - t0;
        const f = span > 0 ? Math.min(1, Math.max(0, (t - t0) / span)) : 1;
        return xs[i - 1]! + (xs[i]! - xs[i - 1]!) * f;
      }
    }
    return xs[xs.length - 1]!;
  };
  const yOf = (v: number): number => G.bottom - plotH * v;
  const f1 = (n: number): string => n.toFixed(1);

  const svg = svgEl('svg', { viewBox: `0 0 ${G.w} ${G.h}`, role: 'img' }, styles.envGraph!);
  svg.setAttribute(
    'aria-label',
    `${labels.title}: attack ${values.attack}, decay ${values.decay}, ` +
      `sustain ${values.sustain}, release ${values.release}`,
  );

  // Axes: level up the side, time along the bottom.
  svg.appendChild(svgEl('line', { x1: G.left, y1: G.top, x2: G.left, y2: G.bottom }, styles.envAxis!));
  svg.appendChild(svgEl('line', { x1: G.left, y1: G.bottom, x2: xs[4]!, y2: G.bottom }, styles.envAxis!));
  svg.appendChild(svgEl('text', { x: G.left - 4, y: G.top + 3, 'text-anchor': 'end' }, styles.envText!, 'peak'));
  svg.appendChild(svgEl('text', { x: G.left - 4, y: G.bottom + 3, 'text-anchor': 'end' }, styles.envText!, '0'));
  const yMid = (G.top + G.bottom) / 2;
  svg.appendChild(
    svgEl(
      'text',
      { x: 10, y: yMid, 'text-anchor': 'middle', transform: `rotate(-90 10 ${yMid})` },
      styles.envText!,
      labels.axis,
    ),
  );

  // Phase boundaries, and the key-down / key-up marks.
  for (const x of [xs[1]!, xs[2]!, xs[3]!]) {
    svg.appendChild(svgEl('line', { x1: x, y1: G.top, x2: x, y2: G.bottom }, styles.envGuide!));
  }
  svg.appendChild(svgEl('text', { x: G.left, y: G.top - 7, 'text-anchor': 'start' }, styles.envText!, 'key down'));
  svg.appendChild(svgEl('text', { x: xs[3]!, y: G.top - 7, 'text-anchor': 'middle' }, styles.envText!, 'key up'));

  // Sustain: a level, so a dashed horizontal line with its value.
  const sy = yOf(env.sustain);
  const sLine = svgEl('line', { x1: G.left, y1: f1(sy), x2: xs[3]!, y2: f1(sy) }, styles.envSustain!);
  sLine.dataset.envSustain = '';
  svg.appendChild(sLine);
  const sLabelY = sy - 4 < G.top + 8 ? sy + 10 : sy - 4;
  const sLabel = svgEl('text', { x: (xs[2]! + xs[3]!) / 2, y: f1(sLabelY), 'text-anchor': 'middle' }, styles.envText!);
  sLabel.dataset.envLabel = 'S';
  sLabel.appendChild(svgEl('tspan', {}, styles.envLetter!, 'S '));
  sLabel.appendChild(svgEl('tspan', {}, styles.envValue!, values.sustain));
  svg.appendChild(sLabel);

  // The curve itself, sampled from the engine's model, over a faint fill.
  const pts = curve.points.map((p) => `${f1(xOf(p.t))} ${f1(yOf(p.v))}`);
  svg.appendChild(svgEl('path', { d: `M ${G.left} ${G.bottom} L ${pts.join(' L ')} L ${f1(xs[4]!)} ${G.bottom} Z` }, styles.envFill!));
  svg.appendChild(svgEl('path', { d: `M ${pts.join(' L ')}` }, styles.envCurve!));

  // Time spans: a bracket under each of A, D and R with its letter and value;
  // the plateau's bracket is the key held, which no knob sets.
  const spans: { from: number; to: number; letter?: string; value: string }[] = [
    { from: xs[0]!, to: xs[1]!, letter: 'A', value: values.attack },
    { from: xs[1]!, to: xs[2]!, letter: 'D', value: values.decay },
    { from: xs[2]!, to: xs[3]!, value: 'key held' },
    { from: xs[3]!, to: xs[4]!, letter: 'R', value: values.release },
  ];
  for (const s of spans) {
    const a = s.from + 1.5;
    const b = s.to - 1.5;
    const y = G.bracket;
    svg.appendChild(
      svgEl(
        'path',
        { d: `M ${f1(a)} ${y - 4} L ${f1(a)} ${y} L ${f1(b)} ${y} L ${f1(b)} ${y - 4}` },
        s.letter ? styles.envBracket! : styles.envGuide!,
      ),
    );
    const cx = f1((s.from + s.to) / 2);
    if (s.letter) {
      const t = svgEl('text', { x: cx, y: y + 12, 'text-anchor': 'middle' }, styles.envLetter!, s.letter);
      t.dataset.envLabel = s.letter;
      t.dataset.envSpan = f1(s.to - s.from);
      svg.appendChild(t);
      svg.appendChild(svgEl('text', { x: cx, y: y + 24, 'text-anchor': 'middle' }, styles.envValue!, s.value));
    } else {
      svg.appendChild(svgEl('text', { x: cx, y: y + 12, 'text-anchor': 'middle' }, styles.envText!, s.value));
    }
  }
  return svg;
}
