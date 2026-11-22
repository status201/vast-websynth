// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mountSongPanel } from './song-panel-harness';
import { demoNames, demoMetaFor, demoFileFor } from '../../src/state/song';
import { demoFacts } from '../../src/state/demo-meta';
import { DEMO_BLURBS } from '../../src/state/demo-blurbs';
import styles from '../../src/ui/styles/song-panel.module.css';

/**
 * demo-library.md REQ-the-blurbs-load-after-boot (v6): the row's tooltips carry the
 * facts when it is built and gain the blurbs once the idle import lands.
 *
 * No demo is named (tests/no-shipped-demo-names.test.ts): one with a note and one
 * without are picked from what ships.
 */

const blurbOf = (name: string): string | undefined => {
  const file = demoFileFor(name);
  return file ? DEMO_BLURBS[file] : undefined;
};
const button = (name: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="song-demo-${CSS.escape(name)}"]`)!;

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('the demo row gains its blurbs after boot', () => {
  it('shows the facts at once and the blurb once the idle import lands', async () => {
    vi.useFakeTimers();
    mountSongPanel();
    const withNote = demoNames().find((n) => blurbOf(n) && demoMetaFor(n))!;
    const withoutNote = demoNames().find((n) => !blurbOf(n) && demoMetaFor(n) && demoFacts(demoMetaFor(n)!))!;
    expect(withNote).toBeDefined();
    expect(withoutNote).toBeDefined();

    const facts = demoFacts(demoMetaFor(withNote)!);
    expect(button(withNote).title).toBe(`${withNote} — ${facts}`);

    // jsdom has no requestIdleCallback: the fallback timeout starts the import.
    vi.advanceTimersByTime(2000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(button(withNote).title).toBe(`${withNote} — ${facts} — ${blurbOf(withNote)}`));
    expect(button(withNote).getAttribute('aria-label')).toBe(`${withNote}. ${facts} — ${blurbOf(withNote)}`);
    expect(button(withoutNote).title).toBe(`${withoutNote} — ${demoFacts(demoMetaFor(withoutNote)!)}`);
  });
});

describe('the demo row starts its own line (song-mode.md REQ-the-demo-row-starts-its-own-line)', () => {
  it('puts the full-width break right before the Demos: label', () => {
    mountSongPanel();
    const label = document.querySelector<HTMLElement>('[data-help="song.demos"]')!;
    const before = label.previousElementSibling as HTMLElement | null;
    expect(before?.classList.contains(styles.ioBreak!)).toBe(true);
    expect(before?.textContent).toBe('');
  });
});
