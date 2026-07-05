import { describe, it, expect, vi } from 'vitest';
import { Keyboard } from '../../src/ui/components/keyboard';
import { ParamBus, registerDefaults } from '../../src/state/params';

// Regression guard for input-control.md REQ-2: the on-screen keyboard's
// `highlight` is the UiBridge target for computer-keyboard / MIDI input, so it
// must repaint the key WITHOUT firing the note funnel. The note-on itself is the
// input source's job (installShortcuts) — if highlight also called the bus, a
// single computer key would double-fire (two voices / two Step-Input steps).
describe('Keyboard.highlight is visual-only', () => {
  it('toggles the key visual but never touches bus.noteOn/noteOff', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const onNote = vi.fn();
    bus.onNote(onNote);

    const kb = new Keyboard({ bus, startOctave: 3, octaves: 3 });
    const key = kb.el.querySelector('[data-note="60"]') as HTMLElement; // C4

    kb.highlight(60, true);
    expect(key.classList.contains('active')).toBe(true);

    kb.highlight(60, false);
    expect(key.classList.contains('active')).toBe(false);

    expect(onNote).not.toHaveBeenCalled();
  });
});
