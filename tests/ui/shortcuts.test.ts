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
