// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderDemoLibrary, openDemoLibrary } from '../../src/ui/components/demo-library';
import { HELP_TOPICS } from '../../src/ui/onboarding/help-content';
import { ParamBus } from '../../src/state/params';
import { demoNames, demoMetaFor, demoFileFor } from '../../src/state/song';
import { DEMO_BLURBS } from '../../src/state/demo-blurbs';
import { demoFacts } from '../../src/state/demo-meta';
import styles from '../../src/ui/styles/demo-library.module.css';

/**
 * demo-library.md REQ-the-library-reads-without-loading / REQ-the-loaded-demo-carries-an-info-button.
 *
 * No demo is named: the list is whatever `demoNames()` ships
 * (tests/no-shipped-demo-names.test.ts), so every expectation is read from it.
 */

const entries = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-testid="demo-library-entry"]')];
const entryName = (e: HTMLElement): string => e.querySelector('h3')!.textContent!;
/** A demo's blurb, from the lazy blurbs module (demo-library.md REQ-the-blurbs-load-after-boot). */
const blurbFor = (name: string): string | undefined => {
  const file = demoFileFor(name);
  return file ? DEMO_BLURBS[file] : undefined;
};
const loadOf = (e: HTMLElement): HTMLButtonElement =>
  e.querySelector<HTMLButtonElement>('[data-testid="demo-library-load"]')!;
const moreOf = (e: HTMLElement): HTMLButtonElement | null =>
  e.querySelector<HTMLButtonElement>('[data-testid="demo-library-more"]');

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('renderDemoLibrary', () => {
  it('lists every demo in row order, each with its facts, and loads nothing', () => {
    const loadDemo = vi.fn(async () => {});
    const close = vi.fn();
    const list = renderDemoLibrary({ loadDemo, close });

    const names = demoNames();
    expect(names.length).toBeGreaterThan(0);
    expect(entries(list).map(entryName)).toEqual(names);
    for (const e of entries(list)) {
      const meta = demoMetaFor(entryName(e));
      if (meta && demoFacts(meta)) expect(e.textContent).toContain(demoFacts(meta));
    }
    expect(loadDemo).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('sets each blurb as text, never as HTML', () => {
    const list = renderDemoLibrary({ loadDemo: async () => {}, close: () => {} });
    const withBlurb = entries(list).filter((e) => blurbFor(entryName(e)));
    expect(withBlurb.length).toBeGreaterThan(0);
    for (const e of withBlurb) {
      const blurb = blurbFor(entryName(e))!;
      const p = [...e.querySelectorAll('p')].find((x) => x.textContent === blurb);
      expect(p, entryName(e)).toBeTruthy();
      expect(p!.children.length).toBe(0); // no markup parsed out of the data
    }
  });

  it('Load closes first, then loads that demo', () => {
    const calls: string[] = [];
    const list = renderDemoLibrary({
      loadDemo: async (n) => { calls.push(`load ${n}`); },
      close: () => calls.push('close'),
    });
    const last = entries(list).at(-1)!;
    last.querySelector<HTMLButtonElement>('[data-testid="demo-library-load"]')!.click();
    expect(calls).toEqual(['close', `load ${entryName(last)}`]);
  });

  it('marks the focused entry as loaded: unfolded, and its button reads Loaded (v4)', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
    // A demo with notes, so there is something to unfold — chosen from the data.
    const focus = demoNames().filter((n) => blurbFor(n)).at(-1)!;
    const list = renderDemoLibrary({ loadDemo: async () => {}, close: () => {}, focus });
    const marked = entries(list).filter((e) => e.getAttribute('aria-current') === 'true');
    expect(marked.map(entryName)).toEqual([focus]);

    for (const e of entries(list)) {
      const load = loadOf(e);
      const isFocus = entryName(e) === focus;
      expect(load.textContent, entryName(e)).toBe(isFocus ? 'Loaded' : 'Load');
      expect(load.disabled, entryName(e)).toBe(isFocus);
    }
    expect(moreOf(marked[0]!)!.getAttribute('aria-expanded')).toBe('true');
    expect(moreOf(marked[0]!)!.textContent).toBe('Less');
  });

  it('marks nothing without a focus', () => {
    const list = renderDemoLibrary({ loadDemo: async () => {}, close: () => {} });
    expect(list.querySelector('[aria-current]')).toBeNull();
  });
});

describe('a blurb folds to its first line (REQ-a-blurb-folds-to-its-first-line)', () => {
  it('starts folded, and each toggle unfolds only its own entry', () => {
    const list = renderDemoLibrary({ loadDemo: async () => {}, close: () => {} });
    const withBlurb = entries(list).filter((e) => blurbFor(entryName(e)));
    expect(withBlurb.length).toBeGreaterThan(1);
    // A demo without notes has nothing to fold.
    for (const e of entries(list)) expect(!!moreOf(e), entryName(e)).toBe(withBlurb.includes(e));
    for (const e of withBlurb) {
      expect(moreOf(e)!.getAttribute('aria-expanded')).toBe('false');
      expect(moreOf(e)!.textContent).toBe('More');
    }

    const [first, second] = withBlurb as [HTMLElement, HTMLElement];
    moreOf(first)!.click();
    expect(moreOf(first)!.getAttribute('aria-expanded')).toBe('true');
    expect(moreOf(first)!.textContent).toBe('Less');
    expect(moreOf(second)!.getAttribute('aria-expanded')).toBe('false');

    moreOf(first)!.click();
    expect(moreOf(first)!.getAttribute('aria-expanded')).toBe('false');
    expect(moreOf(first)!.textContent).toBe('More');
  });

  it('drops the toggle AND the clamp of a blurb that fits its first line, once laid out', () => {
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1; });
    const list = renderDemoLibrary({ loadDemo: async () => {}, close: () => {} });
    const [short, long] = entries(list).filter((e) => blurbFor(entryName(e))) as [HTMLElement, HTMLElement];
    // jsdom lays nothing out, so give the two blurbs the heights a browser would.
    // The blurb is what the toggle controls.
    const blurbOf = (e: HTMLElement): HTMLElement =>
      document.getElementById(moreOf(e)!.getAttribute('aria-controls')!)!;
    const size = (p: HTMLElement, client: number, scroll: number): void => {
      Object.defineProperty(p, 'clientHeight', { value: client });
      Object.defineProperty(p, 'scrollHeight', { value: scroll });
    };
    document.body.appendChild(list);
    const shortBlurb = blurbOf(short);
    const longBlurb = blurbOf(long);
    size(shortBlurb, 19, 19);
    size(longBlurb, 19, 76);
    (frame as unknown as FrameRequestCallback)(0);

    expect(moreOf(short)).toBeNull();
    expect(moreOf(long)).not.toBeNull();
    // Unclamped, so a narrower window later wraps it in full rather than hiding
    // its end behind an ellipsis with no toggle to undo it.
    expect(shortBlurb.classList.contains(styles.folded!)).toBe(false);
    expect(longBlurb.classList.contains(styles.folded!)).toBe(true);
  });

  it('keeps every toggle while nothing is laid out (the safe way to be wrong)', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
    const list = renderDemoLibrary({ loadDemo: async () => {}, close: () => {} });
    const withBlurb = entries(list).filter((e) => blurbFor(entryName(e)));
    expect(withBlurb.every((e) => moreOf(e) !== null)).toBe(true);
  });
});

describe('openDemoLibrary', () => {
  it('opens the list in a modal, and Load closes it', () => {
    const loadDemo = vi.fn(async () => {});
    openDemoLibrary({ loadDemo });
    const list = document.querySelector('[data-testid="demo-library"]')!;
    expect(list).toBeTruthy();
    entries(list)[0]!.querySelector<HTMLButtonElement>('[data-testid="demo-library-load"]')!.click();
    expect(loadDemo).toHaveBeenCalledWith(demoNames()[0]);
  });
});

describe('the song.demos help topic (REQ-info-mode-badges-the-demo-row-once)', () => {
  it('renders the library and loads through the ctx loader', () => {
    const t = HELP_TOPICS['song.demos'];
    expect(typeof t.body).toBe('function');
    const loadDemo = vi.fn(async () => {});
    const close = vi.fn();
    const node = (t.body as (c: Parameters<Exclude<typeof t.body, string>>[0]) => Node)(
      { bus: new ParamBus(), close, loadDemo, loadedDemo: null },
    ) as HTMLElement;
    expect(entries(node).length).toBe(demoNames().length);
    entries(node)[0]!.querySelector<HTMLButtonElement>('[data-testid="demo-library-load"]')!.click();
    expect(close).toHaveBeenCalledOnce();
    expect(loadDemo).toHaveBeenCalledWith(demoNames()[0]);
  });

  it('marks the loaded demo exactly as the row ⓘ does — both doors, one library (v5)', () => {
    const t = HELP_TOPICS['song.demos'];
    const loaded = demoNames().at(-1)!;
    const node = (t.body as (c: Parameters<Exclude<typeof t.body, string>>[0]) => Node)(
      { bus: new ParamBus(), close: () => {}, loadDemo: async () => {}, loadedDemo: loaded },
    ) as HTMLElement;
    const marked = entries(node).filter((e) => e.getAttribute('aria-current') === 'true');
    expect(marked.map(entryName)).toEqual([loaded]);
    expect(loadOf(marked[0]!).textContent).toBe('Loaded');
  });
});
