// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildSongPanel } from '../../src/ui/panels/song-panel';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { Arrangement } from '../../src/audio/transport/arrangement';
import { UiBridge } from '../../src/ui/ui-bridge';
import { demoNames, demoMetaFor, demoFileFor } from '../../src/state/song';
import { demoFacts } from '../../src/state/demo-meta';
import { DEMO_BLURBS } from '../../src/state/demo-blurbs';
import { TestClock } from '../audio/transport/test-clock';
import { installLocalStorageMock } from '../storage-mock';

/**
 * demo-library.md REQ-the-blurbs-load-after-boot (v6): the row's tooltips carry the
 * facts when it is built and gain the blurbs once the idle import lands.
 *
 * No demo is named (tests/no-shipped-demo-names.test.ts): one with a note and one
 * without are picked from what ships.
 */

/** Every property another stub, every call one too — whatever the panel reaches for. */
function anything(): unknown {
  const fn = function () { /* stub */ };
  const proxy: unknown = new Proxy(fn, {
    get: (_t, key) => {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === Symbol.iterator) return function* () { /* empty */ };
      if (key === 'then') return undefined;
      return proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

function panel(): void {
  installLocalStorageMock();
  const bus = new ParamBus();
  registerDefaults(bus);
  const patterns = new PatternStore();
  const arrangement = new Arrangement(patterns, new TestClock());
  const stub = anything() as Record<PropertyKey, unknown>;
  const engine = new Proxy(stub, {
    get: (t, key) => key === 'arrangement' ? arrangement : key === 'patterns' ? patterns : t[key],
  }) as never;
  const a = anything() as never;
  document.body.appendChild(buildSongPanel(bus, engine, a, a, new UiBridge(), a, a).el);
}

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
    panel();
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
