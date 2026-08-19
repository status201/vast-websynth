import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionAutosave, SESSION_KEY } from '../../src/state/session-autosave';
import { Song, type SongFile } from '../../src/state/song';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { Arrangement } from '../../src/audio/transport/arrangement';
import { XyPadStore } from '../../src/state/xy-pad';
import { TestClock } from '../audio/transport/test-clock';
import { installLocalStorageMock, installSessionStorageMock } from '../storage-mock';

/**
 * v8 (REQ-12): the session lives at `websynth.session.<tabId>`, where the id
 * comes from sessionStorage. Tests read the same place the implementation does
 * rather than being handed a test-only accessor.
 */
const TAB_ID_KEY = 'websynth.session.tab';
const ownKey = (): string => `websynth.session.${sessionStorage.getItem(TAB_ID_KEY)}`;
/** Every stored session payload, whichever tab wrote it. */
const sessionKeys = (store: Map<string, string>): string[] =>
  [...store.keys()].filter((k) => k === 'websynth.session' || k.startsWith('websynth.session.'));

function build(debounceMs = 1500) {
  const bus = new ParamBus();
  registerDefaults(bus);
  const patterns = new PatternStore();
  const clock = new TestClock();
  const arr = new Arrangement(patterns, clock);
  const xy = new XyPadStore();
  const capture = vi.fn(() => Song.capture(bus, patterns, arr, 'Session', xy));
  const autosave = new SessionAutosave(capture, { debounceMs });
  autosave.attach({ bus, patterns, arr, xy });
  return { bus, patterns, clock, arr, xy, capture, autosave };
}

describe('SessionAutosave', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageMock();
    installSessionStorageMock(); // a fresh tab identity per test
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('debounces many edits into one validated write', () => {
    const { bus, patterns, capture } = build();
    bus.set('filter.cutoff', 42);
    patterns.setDrumCell(0, 3, { on: true });
    patterns.setSeqStep(0, { on: true, note: 60 });
    vi.advanceTimersByTime(1499);
    expect(sessionKeys(store)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(capture).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(store.get(ownKey())!);
    expect(payload.v).toBe(1);
    const file = Song.fromJSON(JSON.stringify(payload.file));
    expect(file).not.toBeNull();
    expect(file!.params['filter.cutoff']).toBe(42);
    expect(file!.drumBanks[0]![0]![3]!.on).toBe(true);
  });

  it('each edit re-arms the debounce (no write while editing continues)', () => {
    const { bus, capture } = build();
    for (let i = 0; i < 5; i++) {
      bus.set('filter.cutoff', 40 + i);
      vi.advanceTimersByTime(1000);
    }
    expect(capture).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('playback bar ticks never write; structural chain edits do', () => {
    const { clock, arr, capture } = build();
    // Structural change → a write.
    arr.setDrumChain([0, 1], true);
    vi.advanceTimersByTime(1500);
    expect(capture).toHaveBeenCalledTimes(1);
    // Bar boundaries notify Arrangement listeners but change nothing structural.
    clock.fireStart();
    clock.fireTicks(64); // 4 bars
    vi.advanceTimersByTime(5000);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  // runtime-performance.md REQ-5 / motion-sequencer.md REQ-15. Automation writes
  // at frame rate; if they reached `onChange` they would re-arm the debounce
  // faster than it can elapse and the session would never be written at all.
  it('automation writes never re-arm the debounce', () => {
    const { bus, capture } = build();

    // 200 frames of a sliding automation lane, well past the debounce window.
    for (let i = 0; i < 200; i++) {
      bus.withoutChangeSignal(() => bus.set('filter.cutoff', 40 + (i % 50)));
      vi.advanceTimersByTime(16);
    }
    expect(capture).not.toHaveBeenCalled(); // nothing armed it — nothing to write
    expect(sessionKeys(store)).toEqual([]);

    // A real edit still arms it, and now the debounce actually elapses even
    // though automation keeps writing on top.
    bus.set('transport.bpm', 128);
    for (let i = 0; i < 200; i++) {
      bus.withoutChangeSignal(() => bus.set('filter.cutoff', 40 + (i % 50)));
      vi.advanceTimersByTime(16);
    }
    expect(capture).toHaveBeenCalledTimes(1);
    expect(store.has(ownKey())).toBe(true);
  });

  it('flushes a pending save on pagehide', () => {
    const { bus, capture } = build();
    bus.set('filter.cutoff', 50);
    window.dispatchEvent(new Event('pagehide'));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(store.has(ownKey())).toBe(true);
    // No pending save → flush is a no-op (no double write).
    window.dispatchEvent(new Event('pagehide'));
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('load() round-trips a valid autosave', () => {
    const { bus } = build();
    bus.set('transport.bpm', 133);
    vi.advanceTimersByTime(1500);
    const file = SessionAutosave.load();
    expect(file).not.toBeNull();
    expect(file!.name).toBe('Session');
    expect(file!.params['transport.bpm']).toBe(133);
  });

  it('load() clears the key on corrupt JSON', () => {
    store.set(SESSION_KEY, '{not json');
    expect(SessionAutosave.load()).toBeNull();
    expect(store.has(SESSION_KEY)).toBe(false);
  });

  it('load() clears the key on a payload that is not a song', () => {
    store.set(SESSION_KEY, JSON.stringify({ v: 1, savedAt: 0, file: { format: 'nope' } }));
    expect(SessionAutosave.load()).toBeNull();
    expect(store.has(SESSION_KEY)).toBe(false);
  });

  it('load() returns null when no autosave exists (fresh boot)', () => {
    expect(SessionAutosave.load()).toBeNull();
  });

  it('a throwing setItem is swallowed (quota / private mode)', () => {
    const { bus } = build();
    vi.stubGlobal('localStorage', {
      ...localStorage,
      setItem: () => { throw new Error('quota'); },
      getItem: () => null,
      removeItem: () => {},
    } as unknown as Storage);
    bus.set('filter.cutoff', 55);
    expect(() => vi.advanceTimersByTime(1500)).not.toThrow();
  });

  it('the autosave key lives outside the song-slot namespace', () => {
    const { bus } = build();
    bus.set('filter.cutoff', 60);
    vi.advanceTimersByTime(1500);
    expect(SESSION_KEY.startsWith('websynth.song.')).toBe(false);
    expect(Song.list()).not.toContain(SESSION_KEY);
  });

  // debug-panel.md — the readout behind the Debug panel's Session row.
  describe('stats()', () => {
    it('is null with nothing stored, and reports size + age once written', () => {
      expect(SessionAutosave.stats()).toBeNull();

      const { bus } = build();
      bus.set('filter.cutoff', 60);
      vi.advanceTimersByTime(1500);

      const s = SessionAutosave.stats()!;
      expect(s.bytes).toBe(store.get(ownKey())!.length);
      expect(s.savedAt).toBeTypeOf('number');
    });

    it('still reports the size of a corrupt payload (edge)', () => {
      store.set(SESSION_KEY, 'not json');
      expect(SessionAutosave.stats()).toEqual({ bytes: 8, savedAt: null });
    });

    // REQ-13 — stats() is on the Debug panel's poll and the payload is the
    // whole session, so the age is scanned out of a prefix, never parsed.
    it('reads the age without parsing the payload', () => {
      const { bus } = build();
      bus.set('filter.cutoff', 60);
      vi.advanceTimersByTime(1500);
      const writtenAt = Date.now();

      const parse = vi.spyOn(JSON, 'parse');
      try {
        const s = SessionAutosave.stats()!;
        expect(s.savedAt).toBe(writtenAt);
        expect(parse).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
    });

    it('reports no age when savedAt is out of the scanned prefix (edge)', () => {
      // The prefix bound is what stops the scan reaching into `file` — a
      // payload shaped the other way round must lose the age, not report a
      // number lifted from the song.
      const odd = JSON.stringify({ v: 1, file: { pad: 'x'.repeat(200) }, savedAt: 123 });
      store.set(SESSION_KEY, odd);
      expect(SessionAutosave.stats()).toEqual({ bytes: odd.length, savedAt: null });
    });
  });
});

/**
 * REQ-12 (v8), regression. Two tabs used to share one key, so whichever was
 * switched away from flushed its own — often older — session over the other's.
 * Because song-mode makes motion authoritative on apply, a stale session does not
 * merely fail to restore motion, it BLANKS it: params and patterns look fine and
 * the automation is quietly gone. That is what this prevents.
 */
describe('SessionAutosave per-tab isolation (v8, REQ-12)', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageMock();
    installSessionStorageMock();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Run `fn` as if in another tab: a different sessionStorage identity. */
  function asOtherTab<T>(fn: () => T): T {
    const mine = sessionStorage.getItem(TAB_ID_KEY);
    sessionStorage.setItem(TAB_ID_KEY, 'othertab');
    try {
      return fn();
    } finally {
      if (mine === null) sessionStorage.removeItem(TAB_ID_KEY);
      else sessionStorage.setItem(TAB_ID_KEY, mine);
    }
  }

  it('a second tab writing never touches the first tab\'s session', () => {
    const first = build();
    first.bus.set('filter.cutoff', 42);
    vi.advanceTimersByTime(1500);
    const firstKey = ownKey();
    const firstPayload = store.get(firstKey)!;

    asOtherTab(() => {
      const second = build();
      second.bus.set('filter.cutoff', 99);
      vi.advanceTimersByTime(1500);
    });

    expect(store.get(firstKey)).toBe(firstPayload); // byte-identical, untouched
    expect(sessionKeys(store)).toHaveLength(2);
  });

  it('restores this tab\'s own session in preference to a newer foreign one', () => {
    const { bus } = build();
    bus.set('filter.cutoff', 42);
    vi.advanceTimersByTime(1500);

    asOtherTab(() => {
      const other = build();
      other.bus.set('filter.cutoff', 99);
      vi.advanceTimersByTime(1500); // newer, but not ours
    });

    expect(SessionAutosave.load()!.params['filter.cutoff']).toBe(42);
  });

  it('falls back to the most recent session when this tab has none', () => {
    asOtherTab(() => {
      const other = build();
      other.bus.set('filter.cutoff', 77);
      vi.advanceTimersByTime(1500);
    });
    // A brand-new tab: no session of its own, so the closed tab's is restored.
    expect(SessionAutosave.load()!.params['filter.cutoff']).toBe(77);
  });

  it('keeps at most MAX_SESSIONS, never dropping its own', () => {
    for (let i = 0; i < 5; i++) {
      store.set(`websynth.session.old${i}`, JSON.stringify({ v: 1, savedAt: i + 1, file: {} }));
    }
    const { bus } = build();
    bus.set('filter.cutoff', 42);
    vi.advanceTimersByTime(1500);

    expect(sessionKeys(store)).toHaveLength(3);
    expect(store.has(ownKey())).toBe(true); // ours survives the prune
  });

  it('restores a pre-v8 session from the legacy key, and never writes it again', () => {
    const legacy = build();
    legacy.bus.set('filter.cutoff', 55);
    vi.advanceTimersByTime(1500);
    // Re-shape the store as a pre-v8 install: one session, under the old key.
    store.set(SESSION_KEY, store.get(ownKey())!);
    store.delete(ownKey());

    expect(SessionAutosave.load()!.params['filter.cutoff']).toBe(55);

    const next = build();
    next.bus.set('filter.cutoff', 60);
    vi.advanceTimersByTime(1500);
    expect(JSON.parse(store.get(SESSION_KEY)!).file.params['filter.cutoff']).toBe(55);
    expect(JSON.parse(store.get(ownKey())!).file.params['filter.cutoff']).toBe(60);
  });

  it('clear() removes every stored session, legacy key included', () => {
    const { bus } = build();
    bus.set('filter.cutoff', 42);
    vi.advanceTimersByTime(1500);
    store.set(SESSION_KEY, JSON.stringify({ v: 1, savedAt: 1, file: {} }));

    SessionAutosave.clear();
    expect(sessionKeys(store)).toEqual([]);
  });
});

// Type-level check that the injected capture matches Song.capture's output.
const _typecheck: (f: () => SongFile) => SessionAutosave = (f) => new SessionAutosave(f);
void _typecheck;
