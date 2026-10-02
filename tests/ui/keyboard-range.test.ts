import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { keyboardRange, whiteKeyPx, MAX_OCTAVES, MAX_WHITE_PX } from '../../src/ui/keyboard-range';

/** keyboard-range.md — the width → range rule. Widths are the keys' content box
 *  at each viewport, as measured in Chromium (viewport − ~98px of chrome). */
describe('keyboardRange', () => {
  it('keeps every ordinary screen on C3–B5 (REQ-the-range-follows-the-width)', () => {
    for (const width of [0, 1342, 1822, 2462]) {         // unlaid, 1440, 1920, 2560
      expect(keyboardRange(width, false)).toEqual({ startOctave: 3, octaves: 3 });
    }
  });

  it('keeps a phone on C4–B5', () => {
    expect(keyboardRange(0, true)).toEqual({ startOctave: 4, octaves: 2 });
    expect(keyboardRange(340, true)).toEqual({ startOctave: 4, octaves: 2 });
  });

  it('gives an ultrawide more keys, not wider ones', () => {
    expect(keyboardRange(3342, false)).toEqual({ startOctave: 2, octaves: 4 }); // 3440×1440
    expect(keyboardRange(5022, false)).toEqual({ startOctave: 1, octaves: 6 }); // 5120×1440
    const { octaves } = keyboardRange(5022, false);
    expect(5022 / (octaves * 7)).toBeLessThanOrEqual(MAX_WHITE_PX);
  });

  it('grows down first, then alternates (REQ-the-range-grows-down-first)', () => {
    const at = (octaves: number) => keyboardRange(octaves * 7 * MAX_WHITE_PX, false);
    expect(at(4)).toEqual({ startOctave: 2, octaves: 4 }); // C2–B5
    expect(at(5)).toEqual({ startOctave: 2, octaves: 5 }); // C2–B6
    expect(at(6)).toEqual({ startOctave: 1, octaves: 6 }); // C1–B6
  });

  it('never reaches past MIDI 127 at OCT +2 (REQ-the-range-never-exceeds-midi)', () => {
    const r = keyboardRange(20000, false);
    expect(r.octaves).toBe(MAX_OCTAVES);
    const lowest = (r.startOctave + 1) * 12;
    const highest = lowest + r.octaves * 12 - 1;
    expect(lowest - 24).toBeGreaterThanOrEqual(0);
    expect(highest + 24).toBeLessThanOrEqual(127);
  });
});

describe('whiteKeyPx', () => {
  it('is the keys’ width shared by every white key, in whole px', () => {
    expect(whiteKeyPx(2462, 3)).toBe(117);   // 2462 / 21 = 117.2
    expect(whiteKeyPx(5022, 6)).toBe(120);   // 5022 / 42 = 119.6
    expect(whiteKeyPx(0, 3)).toBe(0);
    expect(whiteKeyPx(-5, 3)).toBe(0);       // a collapsed box, never a negative var
  });
});

/**
 * REQ-key-height-follows-key-width bounds the keyboard ROW by the KEY width, so its CSS adds the chrome
 * between the two as a literal 30px. That number is a sum of paddings and a border
 * declared in two other rules, one of them in another stylesheet; if either moves,
 * the band silently shifts. Read as text — CSS Modules never resolve under test —
 * the way tests/ui/panel-header-height.test.ts pins its sum.
 */
describe('the key-height band’s 30px is the keyboard’s actual chrome', () => {
  const bottom = readFileSync('src/ui/styles/bottom.module.css', 'utf8');
  const keys = readFileSync('src/ui/styles/keyboard.module.css', 'utf8');
  /** The declarations of the first top-level `selector { … }` rule — top level within the
   *  file's `@layer` block, so indented exactly its two spaces (css-cascade-layers.md). */
  const rule = (css: string, selector: string): string => {
    const start = css.search(new RegExp('(^|\\n) {0,2}' + selector.replace('.', '\\.') + '\\s*\\{'));
    expect(start, `${selector} not found`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', start);
    return css.slice(open + 1, css.indexOf('}', open));
  };
  /** A declaration's single px value, e.g. `padding: 8px` → 8. */
  const px = (decls: string, prop: string): number => {
    const m = new RegExp('(^|[;\\s])' + prop + ':\\s*(\\d+)px').exec(decls);
    expect(m, `${prop} is not a single px value`).not.toBeNull();
    return Number(m![2]);
  };

  it('adds up to the wrap padding + border + the keys’ padding, top and bottom', () => {
    const wrap = rule(bottom, '.keyboardWrap');
    const chrome = 2 * (px(wrap, 'padding') + px(wrap, 'border') + px(rule(keys, '.root'), 'padding'));
    expect(chrome).toBe(30);
    // …and it is what both bounds add.
    expect(wrap.match(/\+ 30px\)/g)).toHaveLength(2);
  });
});
