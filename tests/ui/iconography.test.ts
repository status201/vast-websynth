// @vitest-environment node
//
// Drift pin for the icon rule (specs/features/iconography.md).
//
// Nothing else in the repo can catch this. A glyph regression is a *string*
// change — `b.textContent = '✕'` typechecks perfectly — and the bug it causes is
// invisible on the machine that writes it: the desktop font stack happens to
// have all these characters, so the arrows only come apart on Android, where
// `--sans` falls back to Roboto and then per-character to a symbol or emoji
// font. This reads the source as text and fails the moment an icon character
// reaches the DOM again.
//
// The rule it enforces is REQ-1/REQ-2: a glyph that *labels a control* is drawn
// (`ui-icons.ts`), a glyph that is *punctuation inside a sentence* is text. So
// the pin does not ban these code points outright — it bans them from the places
// a control's label is written.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UI_DIR = fileURLToPath(new URL('../../src/ui/', import.meta.url));

/**
 * The code points that must be drawn, never typed (REQ-1). Deliberately *not*
 * every non-ASCII character: `— – … • − ≤ ≥ ≈ ’ “ ”` are typography, and the
 * flow arrows in prose ("Distortion → Wah") are punctuation under REQ-2.
 *
 * `→` and `↔` are absent for that reason — they are far more often prose here
 * than a label, and `assignments` below catches the label case anyway.
 */
const ICON_CHARS = '←↑↓‹›◀▶⏮▾▸✕✓⚙❐✎☰✨💡🎲↺↗ⓘ⌫';
const ICON_RE = new RegExp(`[${ICON_CHARS}]`, 'u');

/** Assignments that put a string on screen as a control's label. */
const ASSIGNMENT_RE =
  /(?:\.textContent\s*=|\.innerHTML\s*=|\b(?:label|title|ariaLabel|heading)\s*:)\s*([^\n]*)/g;

/** Every `.ts` file under src/ui, as {file, source}. */
function readSources(): Array<{ file: string; src: string }> {
  const out: Array<{ file: string; src: string }> = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = dir + name;
      if (statSync(full).isDirectory()) walk(`${full}/`, `${prefix}${name}/`);
      else if (name.endsWith('.ts')) out.push({ file: prefix + name, src: readFileSync(full, 'utf8') });
    }
  };
  walk(UI_DIR, '');
  return out;
}

/** Strip comments — an icon character *named* in a doc comment is how
 *  `ui-icons.ts` documents which glyph each entry replaces, and must stay legal. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const sources = readSources();

describe('the icon rule (specs/features/iconography.md)', () => {
  it('read the UI sources at all', () => {
    // Guards the guard: a walker that matched nothing would make every
    // assertion below vacuously true.
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.some((s) => s.file === 'components/ui-icons.ts')).toBe(true);
  });

  it('never writes an icon character into a control label (REQ-1, REQ-6)', () => {
    const offenders: string[] = [];
    for (const { file, src } of sources) {
      if (file === 'components/ui-icons.ts') continue; // the set documents its own glyphs
      const code = stripComments(src);
      for (const m of code.matchAll(ASSIGNMENT_RE)) {
        if (ICON_RE.test(m[1]!)) offenders.push(`${file}: ${m[0]!.trim()}`);
      }
    }
    // Empty, both as a set and as a message: the failure has to name the line,
    // or the next person gets "expected 1 to be 0" and no idea which glyph.
    expect(offenders).toEqual([]);
  });

  it('draws every glyph it names, in one set (REQ-4)', () => {
    const icons = sources.find((s) => s.file === 'components/ui-icons.ts')!.src;
    // The set is the single home: each entry is an `icon(...)` call, and the
    // shared `INFO_SHAPE` is what keeps the header's ⓘ from drifting from the
    // one help copy points at.
    expect(icons).toContain('export const INFO_SHAPE');
    expect(icons.match(/^\s{2}\w+: icon\(/gm)?.length ?? 0).toBeGreaterThan(15);

    const header = sources.find((s) => s.file === 'components/header-icons.ts')!.src;
    expect(header).toContain("import { INFO_SHAPE } from './ui-icons'");
  });

  it('leaves no inline colour on a glyph (REQ-1)', () => {
    // `currentColor` is the whole point: it is what lets a state class tint a
    // glyph that knows nothing about that state.
    const icons = sources.find((s) => s.file === 'components/ui-icons.ts')!.src;
    expect(icons).not.toMatch(/(?:fill|stroke)="(?!none")[^"]*"/);
  });

  it('hides every drawn glyph from assistive tech (REQ-3)', () => {
    const icons = sources.find((s) => s.file === 'components/ui-icons.ts')!.src;
    // One wrapper builds them all, so one `aria-hidden` covers the set.
    expect(icons).toContain('aria-hidden="true"');
  });

  it('keeps prose punctuation as text (REQ-2)', () => {
    // The boundary, pinned from the other side: these are the same arrow
    // characters, left alone because they join words rather than name controls.
    const help = sources.find((s) => s.file === 'onboarding/help-content.ts')!.src;
    expect(help).toContain('Distortion → Wah → Phaser');
    expect(help).toContain('dark ↔ bright');
  });
});
