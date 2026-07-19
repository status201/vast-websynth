import { describe, it, expect, vi, afterEach } from 'vitest';
import { installShortcuts } from '../../src/ui/shortcuts';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { UiBridge } from '../../src/ui/ui-bridge';
import type { StudioApi } from '../../src/ui/studio-api';

function setup() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const bridge = new UiBridge();
  vi.spyOn(bridge, 'pressKey');
  // Only the note/transport path is exercised here; engine is a cast stub.
  const engine = {
    panic: vi.fn(),
    perf: { setFill: vi.fn() },
  } as unknown as StudioApi;
  installShortcuts(engine, bus, bridge);
  return { bus, bridge };
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
