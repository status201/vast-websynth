import { describe, it, expect, vi, afterEach } from 'vitest';
import { installShortcuts } from '../../src/ui/shortcuts';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { UiBridge } from '../../src/ui/ui-bridge';
import type { StudioApi } from '../../src/ui/studio-api';

function setup(seekOpts: { refuse?: boolean } = {}) {
  const bus = new ParamBus();
  registerDefaults(bus);
  const bridge = new UiBridge();
  vi.spyOn(bridge, 'pressKey');
  // Only the note/transport path is exercised here; engine is a cast stub.
  // Every install adds a window-level handler that never detaches, so the seek
  // members must be present on ALL of them — a Home press reaches every stub,
  // and a missing `seekTo` would throw inside a leaked listener.
  const clock = { playing: false, step: 0, cue: 0 };
  const seekTo = vi.fn((step: number) => {
    if (seekOpts.refuse) return false;
    clock.step = clock.cue = step;
    return true;
  });
  const engine = {
    panic: vi.fn(),
    perf: { setFill: vi.fn() },
    clock,
    seekTo,
    canSeek: () => !seekOpts.refuse,
  } as unknown as StudioApi;
  installShortcuts(engine, bus, bridge);
  return { bus, bridge, clock, seekTo };
}

function keydown(target: EventTarget, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function modKeydown(target: EventTarget, key: string, init: KeyboardEventInit = {}): boolean {
  // Returns false when preventDefault was called (per dispatchEvent contract).
  return target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
}

describe('installShortcuts editable-field guard', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not play a note when typing in a textarea', () => {
    const { bridge } = setup();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    keydown(ta, 'z');
    expect(bridge.pressKey).not.toHaveBeenCalled();
  });

  it('still plays a note when the key is pressed outside an editable field', () => {
    const { bridge } = setup();
    keydown(document.body, 'z');
    expect(bridge.pressKey).toHaveBeenCalledTimes(1);
  });
});

describe('installShortcuts Ctrl/Cmd+Z routing (pattern-undo.md REQ-10)', () => {
  // ONE install for the whole describe: every setup() adds a window-level
  // handler that never detaches, and a leaked bridge returning true would
  // preventDefault in later tests. The per-test mock is reassigned instead.
  const { bridge } = setup();

  afterEach(() => {
    document.body.innerHTML = '';
    bridge.undoActiveMachine = () => false;
  });

  it('routes Ctrl+Z to the bridge and prevents default when an undo ran', () => {
    const undo = vi.fn(() => true);
    bridge.undoActiveMachine = undo;
    const unprevented = modKeydown(document.body, 'z', { ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(unprevented).toBe(false);
  });

  it('leaves the default alone when no undo ran (bridge returns false)', () => {
    const undo = vi.fn(() => false);
    bridge.undoActiveMachine = undo;
    const unprevented = modKeydown(document.body, 'z', { metaKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(unprevented).toBe(true);
  });

  it('keeps native undo inside editable fields', () => {
    const undo = vi.fn(() => true);
    bridge.undoActiveMachine = undo;
    const input = document.createElement('input');
    document.body.appendChild(input);
    modKeydown(input, 'z', { ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
  });

  it('ignores the Shift (redo) and Alt variants', () => {
    const undo = vi.fn(() => true);
    bridge.undoActiveMachine = undo;
    modKeydown(document.body, 'z', { ctrlKey: true, shiftKey: true });
    modKeydown(document.body, 'z', { ctrlKey: true, altKey: true });
    expect(undo).not.toHaveBeenCalled();
  });
});

// input-control.md REQ-9 / onboarding.md REQ-19. One install for the describe,
// like the others above: every setup() leaks a window handler.
describe('installShortcuts ? toggles the help badges (input-control.md REQ-9)', () => {
  const { bus, bridge } = setup();

  afterEach(() => {
    document.body.innerHTML = '';
    bus.set('master.pitchBend', 0);
  });

  it('routes ? to the bridge without bending pitch', () => {
    const toggle = vi.fn();
    bridge.toggleHelpBadges = toggle;
    const unprevented = modKeydown(document.body, '?', { shiftKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(unprevented).toBe(false);
    // The '/' pitch-bend branch must never see it — e.key for Shift+/ is '?'.
    expect(bus.get('master.pitchBend')).toBe(0);
  });

  it('leaves ? alone inside an editable field', () => {
    const toggle = vi.fn();
    bridge.toggleHelpBadges = toggle;
    const input = document.createElement('input');
    document.body.appendChild(input);
    modKeydown(input, '?', { shiftKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });

  it('still bends pitch on a bare / (regression)', () => {
    const toggle = vi.fn();
    bridge.toggleHelpBadges = toggle;
    keydown(document.body, '/');
    expect(bus.get('master.pitchBend')).toBe(-1);
    expect(toggle).not.toHaveBeenCalled();
  });
});

// transport-position.md REQ-11. One install for the whole describe (see the
// note above): every setup() leaks a window handler, so a second one would
// double-count the seeks asserted here.
describe('installShortcuts transport position (transport-position.md REQ-11)', () => {
  const { bridge, clock, seekTo } = setup();

  afterEach(() => {
    document.body.innerHTML = '';
    seekTo.mockClear();
    clock.playing = false;
    clock.step = 0;
    clock.cue = 0;
  });

  it('Home returns to the top and prevents default', () => {
    clock.step = 200;
    const unprevented = modKeydown(document.body, 'Home');
    expect(seekTo).toHaveBeenCalledWith(0);
    expect(unprevented).toBe(false);
  });

  it('Shift+Arrow moves one bar without shifting the keyboard octave', () => {
    clock.playing = true;
    clock.step = 16 * 3 + 5; // bar 3, mid-bar
    modKeydown(document.body, 'ArrowRight', { shiftKey: true });
    expect(seekTo).toHaveBeenLastCalledWith(16 * 4);

    // The octave shift shares these keys, so prove Shift+Arrow did not move it:
    // 'z' must still sound C4. Clear the held-key latch first — this install is
    // created at collection time, so it saw the 'z' presses of earlier describes
    // (which never sent a matching keyup) and would swallow a repeat.
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'z', bubbles: true }));
    bridge.pressKey = vi.fn();
    keydown(document.body, 'z');
    expect(bridge.pressKey).toHaveBeenCalledWith(60); // still C4, the default
  });

  it('Shift+ArrowLeft goes back a bar and never below bar 1', () => {
    clock.playing = true;
    clock.step = 16 * 2;
    modKeydown(document.body, 'ArrowLeft', { shiftKey: true });
    expect(seekTo).toHaveBeenLastCalledWith(16);

    clock.playing = true;
    clock.step = 3; // bar 0
    modKeydown(document.body, 'ArrowLeft', { shiftKey: true });
    expect(seekTo).toHaveBeenLastCalledWith(0);
  });

  it('moves relative to the CUE while stopped, matching what the ruler shows', () => {
    clock.playing = false;
    clock.step = 999; // where playback happened to halt — not what Play will use
    clock.cue = 16 * 5;
    modKeydown(document.body, 'ArrowRight', { shiftKey: true });
    expect(seekTo).toHaveBeenLastCalledWith(16 * 6);
  });

  it('leaves the key alone when the seek is refused', () => {
    const refused = setup({ refuse: true });
    // Both installs see the press; the refusing one must not preventDefault.
    const unprevented = modKeydown(document.body, 'Home');
    expect(refused.seekTo).toHaveReturnedWith(false);
    expect(unprevented).toBe(false); // the permissive install still prevented
  });
});
