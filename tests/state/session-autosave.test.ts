import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionAutosave, SESSION_KEY } from '../../src/state/session-autosave';
import { Song, type SongFile } from '../../src/state/song';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { Arrangement } from '../../src/audio/transport/arrangement';
import { XyPadStore } from '../../src/state/xy-pad';
import { TestClock } from '../audio/transport/test-clock';
import { installLocalStorageMock } from '../storage-mock';

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
    expect(store.has(SESSION_KEY)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(capture).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(store.get(SESSION_KEY)!);
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

  it('flushes a pending save on pagehide', () => {
    const { bus, capture } = build();
    bus.set('filter.cutoff', 50);
    window.dispatchEvent(new Event('pagehide'));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(store.has(SESSION_KEY)).toBe(true);
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
      expect(s.bytes).toBe(store.get(SESSION_KEY)!.length);
      expect(s.savedAt).toBeTypeOf('number');
    });

    it('still reports the size of a corrupt payload (edge)', () => {
      store.set(SESSION_KEY, 'not json');
      expect(SessionAutosave.stats()).toEqual({ bytes: 8, savedAt: null });
    });
  });
});

// Type-level check that the injected capture matches Song.capture's output.
const _typecheck: (f: () => SongFile) => SessionAutosave = (f) => new SessionAutosave(f);
void _typecheck;
