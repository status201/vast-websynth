import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installShortcuts } from '../../src/ui/shortcuts';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { UiBridge } from '../../src/ui/ui-bridge';
import { writeLayoutPref, resetDetectionForTests } from '../../src/state/keyboard-layout';
import { installLocalStorageMock } from '../storage-mock';
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
    // 4/4 — what `registerDefaults` resolves the meter params to, so every
    // assertion here still describes a 16-tick bar (meter.md REQ-6).
    barTicks: 16,
    seekTo,
    canSeek: () => !seekOpts.refuse,
  } as unknown as StudioApi;
  installShortcuts(engine, bus, bridge);
  return { bus, bridge, clock, seekTo, engine };
}

function keydown(target: EventTarget, key: string, code?: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true }));
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
describe('installShortcuts ? toggles the info badges (input-control.md REQ-9)', () => {
  const { bus, bridge } = setup();

  afterEach(() => {
    document.body.innerHTML = '';
    bus.set('master.pitchBend', 0);
  });

  it('routes ? to the bridge without bending pitch', () => {
    const toggle = vi.fn();
    bridge.toggleInfoBadges = toggle;
    // A real Shift+/ carries code 'Slash', which is what the bend branch now
    // matches — so this also pins that `?` keeps winning the race (REQ-12).
    const unprevented = modKeydown(document.body, '?', { shiftKey: true, code: 'Slash' });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(unprevented).toBe(false);
    expect(bus.get('master.pitchBend')).toBe(0);
  });

  it('leaves ? alone inside an editable field', () => {
    const toggle = vi.fn();
    bridge.toggleInfoBadges = toggle;
    const input = document.createElement('input');
    document.body.appendChild(input);
    modKeydown(input, '?', { shiftKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });

  it('still bends pitch on a bare / (regression)', () => {
    const toggle = vi.fn();
    bridge.toggleInfoBadges = toggle;
    keydown(document.body, '/', 'Slash');
    expect(bus.get('master.pitchBend')).toBe(-1);
    expect(toggle).not.toHaveBeenCalled();
  });
});

// input-control.md REQ-13 / keyboard-layout.md. The note maps are composed from
// the piano shape (code -> semitone) and the active layout (code -> character),
// so a switch moves which characters reach the instrument.
describe('installShortcuts keyboard layout (input-control.md REQ-13)', () => {
  const { bus, bridge, engine: engineStub } = setup();
  const notes: Array<[boolean, number]> = [];
  bus.onNote((on, note) => { notes.push([on, note]); });

  const keyup = (key: string) => {
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  };

  beforeEach(() => {
    installLocalStorageMock();
    resetDetectionForTests();
    // Every setup() in this file leaks a window listener, so a keydown in an
    // earlier describe latched `held` in *this* install too — and a latched key
    // makes the next press a no-op. `blur` is the module's own bulk release.
    window.dispatchEvent(new Event('blur'));
    notes.length = 0;
    vi.mocked(bridge.pressKey).mockClear();
  });

  afterEach(() => {
    writeLayoutPref('qwerty'); // leave the module-level maps as the next suite expects
    document.body.innerHTML = '';
  });

  it('plays the bottom C from the key each layout prints there', () => {
    // QWERTY: that key prints "z".
    keydown(document.body, 'z');
    keyup('z');
    expect(notes).toEqual([[true, 60], [false, 60]]);

    // AZERTY prints "w" on the same physical key — and "z" moves to the upper
    // octave's D, so the old binding must no longer sound the bottom C.
    notes.length = 0;
    writeLayoutPref('azerty');
    keydown(document.body, 'w');
    keyup('w');
    expect(notes).toEqual([[true, 60], [false, 60]]);

    notes.length = 0;
    keydown(document.body, 'z');
    keyup('z');
    expect(notes).toEqual([[true, 74], [false, 74]]); // upper octave D, not C
  });

  it('QWERTZ swaps only Y and Z', () => {
    writeLayoutPref('qwertz');
    keydown(document.body, 'y');
    keyup('y');
    expect(notes).toEqual([[true, 60], [false, 60]]); // the bottom-left key
  });

  it('releases a held note before remapping, so it cannot hang (edge)', () => {
    keydown(document.body, 'z'); // held down on QWERTY
    expect(notes).toEqual([[true, 60]]);

    writeLayoutPref('azerty'); // "z" no longer names that note
    expect(notes).toEqual([[true, 60], [false, 60]]);

    // The stale keyup must not double-release or resurrect anything.
    notes.length = 0;
    keyup('z');
    expect(notes).toEqual([]);
  });

  it('leaves the non-note letters alone (keyboard-layout.md REQ-5)', () => {
    writeLayoutPref('azerty');
    // F is still F: drum fill is a command, not part of the instrument.
    keydown(document.body, 'f');
    expect(engineStub.perf.setFill).toHaveBeenCalledWith(true);
    keyup('f');
  });
});

// input-control.md REQ-12. `'` sits directly above `/` on the board, so the
// physical arrangement states which way is up — `.` and `/` were side by side.
// Both are matched on e.code, because position is the whole premise.
describe('installShortcuts pitch bend keys (input-control.md REQ-12)', () => {
  const { bus } = setup();

  const keyup = (key: string, code?: string) => {
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true }));
  };

  afterEach(() => {
    document.body.innerHTML = '';
    bus.set('master.pitchBend', 0);
  });

  it("' bends up and springs back on release", () => {
    keydown(document.body, "'", 'Quote');
    expect(bus.get('master.pitchBend')).toBe(1);
    keyup("'", 'Quote');
    expect(bus.get('master.pitchBend')).toBe(0);
  });

  it('/ bends down and springs back on release', () => {
    keydown(document.body, '/', 'Slash');
    expect(bus.get('master.pitchBend')).toBe(-1);
    keyup('/', 'Slash');
    expect(bus.get('master.pitchBend')).toBe(0);
  });

  it('. is unbound — not kept as a second way to bend up', () => {
    keydown(document.body, '.', 'Period');
    expect(bus.get('master.pitchBend')).toBe(0);
    // And its keyup can't clear a bend someone else is holding.
    keydown(document.body, "'", 'Quote');
    keyup('.', 'Period');
    expect(bus.get('master.pitchBend')).toBe(1);
  });

  it('is suppressed inside an editable field like every other key (REQ-5)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    keydown(input, "'", 'Quote');
    expect(bus.get('master.pitchBend')).toBe(0);
  });

  // The bug that made this positional: Shift flips e.key on the way out, so a
  // key-matched release missed and the bend stayed pinned. Same failure REQ-11
  // fixes for note-offs — nothing may hold state whose release depends on a
  // value free to change mid-hold.
  it('releases even when Shift is pressed mid-hold (regression)', () => {
    keydown(document.body, '/', 'Slash');
    expect(bus.get('master.pitchBend')).toBe(-1);
    // Shift down mid-hold: the release now reports '?' as its key.
    keyup('?', 'Slash');
    expect(bus.get('master.pitchBend')).toBe(0);
  });

  it("releases the up-bend too when Shift turns ' into \" (regression)", () => {
    keydown(document.body, "'", 'Quote');
    expect(bus.get('master.pitchBend')).toBe(1);
    keyup('"', 'Quote');
    expect(bus.get('master.pitchBend')).toBe(0);
  });

  // Where Quote is a dead key (US-International) the browser reports 'Dead' as
  // the key but still names the physical one.
  it('bends on a dead-key layout, where e.key reads "Dead"', () => {
    keydown(document.body, 'Dead', 'Quote');
    expect(bus.get('master.pitchBend')).toBe(1);
    keyup('Dead', 'Quote');
    expect(bus.get('master.pitchBend')).toBe(0);
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

/**
 * input-control.md REQ-11. `keyup` used to recompute the note with `keyToMidi(k)`
 * against the CURRENT baseOctave, so an arrow-key octave shift mid-hold produced a
 * different note, missed the held-key latch and skipped `release()` entirely — the
 * voice hung and the on-screen key stayed lit until the window lost focus.
 */
describe('installShortcuts octave shift mid-hold (input-control.md REQ-11)', () => {
  const keyup = (key: string) =>
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));

  it('releases the note that was pressed, not the one the new octave names', () => {
    const { bus, bridge } = setup();
    const notes: Array<[boolean, number]> = [];
    bus.onNote((on, note) => notes.push([on, note]));
    bridge.releaseKey = vi.fn();

    keydown(document.body, 'z');       // C4 = 60 at the default base octave
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    keyup('z');                        // 'z' now names 72 — must not matter

    expect(notes).toEqual([[true, 60], [false, 60]]);
    expect(bridge.releaseKey).toHaveBeenCalledWith(60); // the key un-lights too
  });

  it('releases a note even if Shift flipped the key case mid-hold', () => {
    const { bus } = setup();
    const notes: Array<[boolean, number]> = [];
    bus.onNote((on, note) => notes.push([on, note]));

    keydown(document.body, 'z');
    keyup('Z');   // Shift went down while the key was held

    expect(notes).toEqual([[true, 60], [false, 60]]);
  });

  it('still tracks the shifted octave for the next press', () => {
    const { bus } = setup();
    const notes: Array<[boolean, number]> = [];

    keydown(document.body, 'z');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    keyup('z');

    bus.onNote((on, note) => notes.push([on, note]));
    keydown(document.body, 'z');
    keyup('z');
    expect(notes).toEqual([[true, 72], [false, 72]]);
  });
});

// record-window.md REQ-9. Same one-install-per-describe shape as above.
describe('installShortcuts Shift+R toggles the Record window', () => {
  const { bus, bridge } = setup();

  afterEach(() => {
    document.body.innerHTML = '';
    bus.set('master.pitchBend', 0);
  });

  it('routes Shift+R to the bridge and prevents default', () => {
    const toggle = vi.fn();
    bridge.toggleRecordWindow = toggle;
    const unprevented = modKeydown(document.body, 'R', { shiftKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(unprevented).toBe(false);
  });

  // The branch has to sit ABOVE keyToMidi: `keyId` case-folds, so 'R' would
  // otherwise reach the note map as 'r' and play a note instead.
  it('does not play the r note', () => {
    bridge.toggleRecordWindow = vi.fn();
    const played: number[] = [];
    bus.onNote((on, note) => { if (on) played.push(note); });
    modKeydown(document.body, 'R', { shiftKey: true });
    expect(played).toEqual([]);
  });

  it('leaves a BARE r playing its note (regression)', () => {
    const toggle = vi.fn();
    bridge.toggleRecordWindow = toggle;
    const played: number[] = [];
    bus.onNote((on, note) => { if (on) played.push(note); });
    keydown(document.body, 'r');
    expect(toggle).not.toHaveBeenCalled();
    expect(played).toHaveLength(1);
  });

  it('leaves Shift+R alone inside an editable field', () => {
    const toggle = vi.fn();
    bridge.toggleRecordWindow = toggle;
    const input = document.createElement('input');
    document.body.appendChild(input);
    modKeydown(input, 'R', { shiftKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });
});
