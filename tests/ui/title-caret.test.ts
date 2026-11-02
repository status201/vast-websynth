// @vitest-environment node
//
// Drift pin for iconography.md REQ-a-title-caret-is-cap-high. An FX title's
// caret is exactly as tall as the title's capitals, sized in the CSS `cap` unit
// so it holds in whichever face renders. jsdom resolves neither `cap` nor a CSS
// Module, so this reads the sources as text; the rendered size is checked by eye.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');
const css = (rel: string): string => src(rel).replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^}]*)\\}`).exec(sheet);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1]!.replace(/\s+/g, ' ');
}

describe('FX title carets are cap-high (iconography.md REQ-a-title-caret-is-cap-high)', () => {
  it('one global rule sizes the glyph: 16/7 cap, its empty rows trimmed', () => {
    // caretDown spans 7 of 16 units, from 4.95 down to 11.95 (ui-icons.ts).
    const decls = rule(css('styles/base.css'), '.cap-caret > svg.ui-icon');
    expect(decls).toContain('width: calc(1cap * 16 / 7)');
    expect(decls).toContain('height: calc(1cap * 16 / 7)');
    expect(decls).toContain('margin-block: calc(-1cap * 4.95 / 7) calc(-1cap * 4.05 / 7)');
    expect(src('ui/components/ui-icons.ts')).toContain('M1.2 4.95 L8 11.95 L14.8 4.95 Z');
  });

  it('both FX-title carets wear it, and nothing else restates the sizing', () => {
    expect(src('ui/components/fx-slot-picker.ts')).toContain('cap-caret');
    expect(src('ui/components/dropdown.ts')).toContain('cap-caret');
    for (const m of ['fx-slot-picker', 'dropdown']) {
      expect(css(`ui/styles/${m}.module.css`)).not.toContain('1cap');
    }
  });

  it('the slot picker caret takes its title\'s font-size', () => {
    expect(rule(css('ui/styles/fx-slot-picker.module.css'), '.caret'))
      .toContain('font-size: var(--fx-title-size, 11px)');
  });

  it('the sampler FX label and its caret read one --fx-title-size', () => {
    const sheet = css('ui/styles/fx-group.module.css');
    expect(rule(sheet, '.root')).toContain('--fx-title-size: 9px');
    expect(rule(sheet, '.label')).toContain('font-size: var(--fx-title-size)');
  });

  it('the titled dropdown caret takes the legend\'s font-size', () => {
    const sheet = css('ui/styles/dropdown.module.css');
    const legendSize = /font-size: (\d+px)/.exec(rule(sheet, '.legend'))![1];
    expect(rule(sheet, '.root.titled .caret')).toContain(`font-size: ${legendSize}`);
  });
});
