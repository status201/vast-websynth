import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ParamBus } from '../../src/state/params';
import { demoNames } from '../../src/state/song';
import { installEasterEgg, EGG_DEMO, type EasterEggDeps } from '../../src/ui/shell/easter-egg';
import { showToast, isToastShowing } from '../../src/ui/components/toast';

// rickroll-easter-egg.md. EGG_DEMO is imported, never spelled
// (tests/no-shipped-demo-names.test.ts).

const HOOK = [56, 58, 61, 58, 65, 65, 63]; // A♭3 B♭3 D♭4 B♭3 F4 F4 E♭4
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

interface Rig {
  bus: ParamBus;
  deps: EasterEggDeps;
  loadDemo: ReturnType<typeof vi.fn>;
  startTransport: ReturnType<typeof vi.fn>;
  state: { loaded: string | null; playing: boolean; names: string[]; t: number };
  playHook: (notes?: number[]) => void;
}

let uninstall: (() => void) | null = null;

function rig(over: Partial<Rig['state']> = {}): Rig {
  const bus = new ParamBus();
  const state = { loaded: null as string | null, playing: false, names: ['Other', EGG_DEMO], t: 0, ...over };
  const loadDemo = vi.fn(async (name: string) => { state.loaded = name; });
  const startTransport = vi.fn(() => { state.playing = true; });
  const deps: EasterEggDeps = {
    bus,
    loadDemo,
    loadedDemo: () => state.loaded,
    isPlaying: () => state.playing,
    startTransport,
    demoNames: () => state.names,
    now: () => state.t,
  };
  uninstall = installEasterEgg(deps);
  const playHook = (notes = HOOK): void => {
    for (const n of notes) {
      state.t += 250;
      bus.noteOn(n);
      bus.noteOff(n);
    }
  };
  return { bus, deps, loadDemo, startTransport, state, playHook };
}

const offerShowing = () => byId('easter-egg-toast') !== null;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('rickroll easter egg', () => {
  beforeEach(() => {
    showToast({ message: 'clear' }).dismiss(); // toast module state outlives the DOM
    document.body.innerHTML = '';
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    vi.useRealTimers();
  });

  it('the shipped library carries the egg\'s demo (REQ-the-egg-is-inert-without-its-demo)', () => {
    expect(demoNames()).toContain(EGG_DEMO);
  });

  it('playing the hook offers the song and changes nothing (REQ-a-match-offers-never-loads)', () => {
    const r = rig();
    r.playHook();
    expect(offerShowing()).toBe(true);
    expect(byId('easter-egg-toast')!.textContent).toContain('Never gonna give you up');
    expect(byId('toast-action')!.textContent).toBe('Play it');
    expect(r.loadDemo).not.toHaveBeenCalled();
    expect(r.startTransport).not.toHaveBeenCalled();
  });

  it('note-offs do not count (REQ-only-human-notes-count)', () => {
    const r = rig();
    for (const n of HOOK) { r.state.t += 250; r.bus.noteOff(n); }
    expect(isToastShowing()).toBe(false);
  });

  it('Play it loads through the demo door and starts a stopped transport once (REQ-the-offer-plays-through-the-demo-door)', async () => {
    const r = rig();
    r.playHook();
    (byId('toast-action') as HTMLButtonElement).click();
    await flush();
    expect(r.loadDemo).toHaveBeenCalledTimes(1);
    expect(r.loadDemo).toHaveBeenCalledWith(EGG_DEMO);
    expect(r.startTransport).toHaveBeenCalledTimes(1);
  });

  it('a running transport is not toggled off (REQ-the-offer-plays-through-the-demo-door)', async () => {
    const r = rig({ playing: true });
    r.playHook();
    (byId('toast-action') as HTMLButtonElement).click();
    await flush();
    expect(r.loadDemo).toHaveBeenCalledWith(EGG_DEMO);
    expect(r.startTransport).not.toHaveBeenCalled();
  });

  it('a declined load starts nothing (REQ-the-offer-plays-through-the-demo-door)', async () => {
    const r = rig();
    r.loadDemo.mockImplementation(async () => { /* shadow question cancelled: nothing loads */ });
    r.playHook();
    (byId('toast-action') as HTMLButtonElement).click();
    await flush();
    expect(r.startTransport).not.toHaveBeenCalled();
  });

  it('never replaces a live toast (REQ-the-egg-never-takes-a-toast)', () => {
    const r = rig();
    showToast({ message: 'Loaded "x"', actionLabel: 'Undo', testId: 'song-undo-toast' });
    r.playHook();
    expect(byId('song-undo-toast')).not.toBeNull();
    expect(offerShowing()).toBe(false);
  });

  it('is quiet while its own song is loaded (REQ-the-egg-is-quiet-over-its-own-song)', () => {
    const r = rig({ loaded: EGG_DEMO });
    r.playHook();
    expect(isToastShowing()).toBe(false);
  });

  it('an offer closed with ✕ silences the egg (REQ-an-offer-not-taken-silences-the-egg)', () => {
    const r = rig();
    r.playHook();
    (byId('toast-dismiss') as HTMLButtonElement).click();
    r.playHook();
    expect(isToastShowing()).toBe(false);
  });

  it('an offer that timed out silences the egg too (REQ-an-offer-not-taken-silences-the-egg)', () => {
    vi.useFakeTimers();
    const r = rig();
    r.playHook();
    vi.advanceTimersByTime(8000);
    expect(isToastShowing()).toBe(false);
    r.playHook();
    expect(isToastShowing()).toBe(false);
  });

  it('a taken offer does not silence it (REQ-an-offer-not-taken-silences-the-egg)', async () => {
    const r = rig();
    r.playHook();
    (byId('toast-action') as HTMLButtonElement).click();
    await flush();
    r.state.loaded = 'Other'; // the player moved on to another song
    r.playHook();
    expect(offerShowing()).toBe(true);
  });

  it('no demo, no egg (REQ-the-egg-is-inert-without-its-demo)', () => {
    const r = rig({ names: ['Other'] });
    r.playHook();
    expect(isToastShowing()).toBe(false);
    expect(r.loadDemo).not.toHaveBeenCalled();
  });

  it('uninstall stops listening', () => {
    const r = rig();
    uninstall!();
    uninstall = null;
    r.playHook();
    expect(isToastShowing()).toBe(false);
  });
});
