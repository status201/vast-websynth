// Each synth section names itself, so a theme can colour it
// (specs/features/ui-themes.md REQ-pastel-tints-each-panel).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSynthPanels } from '../../src/ui/panels/synth-panels';
import { buildFxRack } from '../../src/ui/panels/fx-rack';
import { createPanel, type PanelTint } from '../../src/ui/components/panel';
import { ParamBus, registerDefaults } from '../../src/state/params';
import panelStyles from '../../src/ui/styles/panel.module.css';
import fxStyles from '../../src/ui/styles/fx-rack.module.css';

const TINTS: PanelTint[] = ['osc', 'mixer', 'filter', 'env', 'mod', 'fx'];

const bus = () => { const b = new ParamBus(); registerDefaults(b); return b; };
const css = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the panels name their section', () => {
  it('tints the eight synth panels by what they do', () => {
    const el = buildSynthPanels(bus());
    const panels = [...el.querySelectorAll<HTMLElement>(`.${panelStyles.panel!}`)];
    // The heading each panel shows: a plain title, or the tabbed LFO panel's first tab.
    const named = panels.map((p) => [p.textContent!.trim().split(/\s{2,}|\n/)[0]!, p.dataset.tint]);
    const tintOf = (title: RegExp) => named.find(([t]) => title.test(t!))?.[1];
    expect(panels).toHaveLength(8);
    expect(tintOf(/^OSC 1/)).toBe('osc');
    expect(tintOf(/^OSC 2/)).toBe('osc');
    expect(tintOf(/^SUB \/ UNI/)).toBe('osc');
    expect(tintOf(/^MIXER/)).toBe('mixer');
    expect(tintOf(/^FILTER(?! ENV)/)).toBe('filter');
    expect(tintOf(/^AMP ENV/)).toBe('env');
    expect(tintOf(/^FILTER ENV/)).toBe('env');
    expect(tintOf(/^LFO/)).toBe('mod');
    expect(panels.every((p) => TINTS.includes(p.dataset.tint as PanelTint))).toBe(true);
  });

  it('tints every FX group "fx"', () => {
    // jsdom has no matchMedia; the rack's fold asks it whether the viewport is compact.
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const { el } = buildFxRack(bus());
    const groups = [...el.querySelectorAll<HTMLElement>(`.${fxStyles.fxPanel!}`)];
    expect(groups.length).toBeGreaterThan(3);
    expect(groups.map((g) => g.dataset.tint)).toEqual(groups.map(() => 'fx'));
    vi.unstubAllGlobals();
  });

  it('leaves a panel built without a tint untinted', () => {
    expect(createPanel('X', () => {}).dataset.tint).toBeUndefined();
    expect(createPanel('X', () => {}, undefined, 'env').dataset.tint).toBe('env');
  });
});

describe('a tint is a token (REQ-pastel-tints-each-panel)', () => {
  const theme = css('src/styles/theme.css');
  const root = /:root\s*\{([^{}]*)\}/.exec(theme)![1]!;

  it('maps each data-tint to its own token, which is the plain panel on :root', () => {
    for (const t of TINTS) {
      expect(theme, t).toMatch(new RegExp(`\\[data-tint="${t}"\\]\\s*\\{\\s*--panel-tint:\\s*var\\(--panel-tint-${t}\\);\\s*\\}`));
      expect(root, t).toMatch(new RegExp(`--panel-tint-${t}:\\s*var\\(--panel\\);`));
    }
  });

  it('paints the panel and the FX group chrome from the tint, the plain panel its fallback', () => {
    for (const [file, cls] of [['panel.module.css', 'panel'], ['fx-rack.module.css', 'fxPanel']] as const) {
      const block = new RegExp(`\\.${cls}\\s*\\{([^{}]*)\\}`).exec(css(`src/ui/styles/${file}`))![1]!;
      expect(block, file).toMatch(/background:\s*var\(--panel-tint,\s*var\(--panel\)\);/);
    }
  });
});
