// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderEnvelopeHelp } from '../../src/ui/onboarding/help-widgets';
import { phaseWidths, ENV_GRAPH_MIN_PHASE } from '../../src/ui/onboarding/envelope-graph';
import { HELP_TOPICS, type HelpContext } from '../../src/ui/onboarding/help-content';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { noteToHz } from '../../src/utils/tempo';

/** The ADSR graph under the AMP / FILTER ENV badges (envelope-help-graph.md). */

function ctxWith(values: Record<string, number> = {}): HelpContext {
  const bus = new ParamBus();
  registerDefaults(bus);
  for (const [id, v] of Object.entries(values)) bus.set(id, v);
  return { bus, close: () => {}, loadDemo: async () => {}, loadedDemo: null };
}

const render = (which: 'amp' | 'fil', values?: Record<string, number>) =>
  renderEnvelopeHelp(ctxWith(values), which);

const fmt = (ctx: HelpContext, id: string) => ctx.bus.def(id)!.format!(ctx.bus.get(id));

describe('envelope help graph', () => {
  it('both badges are live bodies', () => {
    expect(typeof HELP_TOPICS.ampenv.body).toBe('function');
    expect(typeof HELP_TOPICS.filterenv.body).toBe('function');
  });

  it('labels the default amp envelope with the knobs’ own readouts', () => {
    const ctx = ctxWith();
    const root = renderEnvelopeHelp(ctx, 'amp');
    const svg = root.querySelector('svg')!;
    expect(svg).toBeTruthy();
    const text = svg.textContent!;
    for (const key of ['attack', 'decay', 'sustain', 'release']) {
      expect(text).toContain(fmt(ctx, `env.amp.${key}`));
    }
    for (const letter of ['A', 'D', 'S', 'R']) {
      expect(svg.querySelector(`[data-env-label="${letter}"]`), letter).toBeTruthy();
    }
    expect(text).toContain('key held');
  });

  it('names A, D and R as times and S as a level', () => {
    const items = [...render('amp').querySelectorAll('li')].map((li) => li.textContent!);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatch(/^Attack \(time\)/);
    expect(items[1]).toMatch(/^Decay \(time\)/);
    expect(items[2]).toMatch(/^Sustain \(level, not a time\)/);
    expect(items[3]).toMatch(/^Release \(time\)/);
  });

  it('puts the sustain line at the sustain level', () => {
    const y = (s: number) =>
      Number(render('amp', { 'env.amp.sustain': s }).querySelector('[data-env-sustain]')!.getAttribute('y1'));
    const top = y(1);
    const bottom = y(0);
    expect(bottom).toBeGreaterThan(top);
    expect(y(0.25)).toBeCloseTo(bottom - (bottom - top) * 0.25, 0);
  });

  it('keeps a 1 ms attack visible next to a 6 s release', () => {
    const svg = render('amp', { 'env.amp.attack': 0.001, 'env.amp.release': 6 }).querySelector('svg')!;
    const span = (l: string) => Number(svg.querySelector(`[data-env-label="${l}"]`)!.getAttribute('data-env-span'));
    const timeWidth = span('A') + span('D') + span('R');
    expect(span('A') / timeWidth).toBeGreaterThanOrEqual(ENV_GRAPH_MIN_PHASE - 0.01);
    expect(span('R')).toBeGreaterThan(span('A'));
  });

  it('phaseWidths is proportional above the floor and sums to the total', () => {
    expect(phaseWidths([1, 1, 2], 100).map(Math.round)).toEqual([25, 25, 50]);
    const w = phaseWidths([0.001, 0.2, 6], 100);
    expect(w[0]).toBeCloseTo(100 * ENV_GRAPH_MIN_PHASE, 9);
    expect(w[1]).toBeCloseTo(100 * ENV_GRAPH_MIN_PHASE, 9);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9);
  });

  it('the filter caption gives the sweep in Hz', () => {
    const ctx = ctxWith();
    const cutoff = ctx.bus.get('filter.cutoff');
    const amount = ctx.bus.get('filter.envAmount');
    const text = renderEnvelopeHelp(ctx, 'fil').textContent!;
    const hz = (n: number) => {
      const v = noteToHz(n);
      return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v.toFixed(0)} Hz`;
    };
    expect(text).toContain(hz(cutoff));
    expect(text).toContain(hz(cutoff + amount));
    expect(text).toContain(hz(cutoff + amount * ctx.bus.get('env.fil.sustain')));
    expect(text).toMatch(/opens the cutoff/);
  });

  it('says plainly when ENV is 0, and when it sweeps down', () => {
    expect(render('fil', { 'filter.envAmount': 0 }).textContent).toMatch(/currently does nothing/);
    const down = render('fil', { 'filter.envAmount': -24 }).textContent!;
    expect(down).toMatch(/runs down/);
    expect(down).not.toMatch(/currently does nothing/);
  });

  it('is CSP-safe and labelled for assistive tech', () => {
    for (const which of ['amp', 'fil'] as const) {
      const root = render(which);
      expect(root.querySelectorAll('[style]')).toHaveLength(0);
      const svg = root.querySelector('svg')!;
      expect(svg.getAttribute('role')).toBe('img');
      const label = svg.getAttribute('aria-label')!;
      for (const word of ['attack', 'decay', 'sustain', 'release']) expect(label).toContain(word);
    }
  });
});
