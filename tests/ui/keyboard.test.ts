import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keyboard } from '../../src/ui/components/keyboard';
import { ParamBus, registerDefaults } from '../../src/state/params';

function mount(): { bus: ParamBus; kb: Keyboard; keyEl: (note: number) => HTMLElement } {
  const bus = new ParamBus();
  registerDefaults(bus);
  const kb = new Keyboard({ bus, startOctave: 3, octaves: 3 });
  return {
    bus,
    kb,
    keyEl: (note) => kb.el.querySelector(`[data-note="${note}"]`) as HTMLElement,
  };
}

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

/**
 * input-control.md REQ-10. The OCT strip (`keyboard.transpose`) moves the
 * note→element mapping: an element sounds `note + transpose * 12`. Lit state used
 * to be keyed by note and re-resolved at light-off, so any OCT change between the
 * sequencer's two deferred timers — including a demo load, which restores the
 * song's own transpose — sent the off to a different element (or to none, since
 * `keys.get` misses silently) and stranded the lit key until the next Stop.
 */
describe('Keyboard lit state survives an OCT change', () => {
  it('clears the key it actually lit, not the one the new transpose names', () => {
    const { bus, kb, keyEl } = mount();

    kb.seqHighlight(60, true);
    expect(keyEl(60).classList.contains('seq')).toBe(true);

    bus.set('keyboard.transpose', -1); // the OCT strip, mid-playback
    kb.seqHighlight(60, false);

    expect(keyEl(60).classList.contains('seq')).toBe(false);
    expect(kb.el.querySelectorAll('.seq')).toHaveLength(0);
  });

  it('clears a key lit for a note the new transpose puts off the board', () => {
    const { bus, kb, keyEl } = mount();

    kb.seqHighlight(48, true); // bottom C3 — the lowest drawn key
    expect(keyEl(48).classList.contains('seq')).toBe(true);

    // +2 octaves would resolve note 48 to element 24, which is not drawn at all.
    bus.set('keyboard.transpose', 2);
    kb.seqHighlight(48, false);

    expect(kb.el.querySelectorAll('.seq')).toHaveLength(0);
  });

  it('keeps a key lit while a second track still holds the same note', () => {
    const { kb, keyEl } = mount();

    kb.seqHighlight(60, true); // track 1
    kb.seqHighlight(60, true); // track 2, same note, longer gate

    kb.seqHighlight(60, false);
    expect(keyEl(60).classList.contains('seq')).toBe(true);

    kb.seqHighlight(60, false);
    expect(keyEl(60).classList.contains('seq')).toBe(false);
  });

  it('clearSeqHighlights leaves nothing lit', () => {
    const { kb } = mount();
    kb.seqHighlight(60, true);
    kb.seqHighlight(64, true);

    kb.clearSeqHighlights();
    expect(kb.el.querySelectorAll('.seq')).toHaveLength(0);

    // The bookkeeping is cleared too, so a late off-timer is a no-op rather than
    // decrementing a stale count.
    kb.seqHighlight(60, false);
    expect(kb.el.querySelectorAll('.seq')).toHaveLength(0);
  });

  it('lights the key that sounds the note, so highlight and seqHighlight agree', () => {
    const { bus, kb, keyEl } = mount();
    bus.set('keyboard.transpose', -1);

    kb.highlight(60, true);
    kb.seqHighlight(60, true);

    // At OCT -1 the element that sounds 60 is 72 — both APIs resolve it the same.
    expect(keyEl(72).classList.contains('active')).toBe(true);
    expect(keyEl(72).classList.contains('seq')).toBe(true);
    expect(keyEl(60).classList.contains('active')).toBe(false);
  });
});

/**
 * input-control.md REQ-11: `onPointerUp` used to send `noteOff(tr(note))` with the
 * transpose in effect at *release* time, so moving OCT mid-hold released a
 * different MIDI number and hung the voice.
 */
describe('Keyboard pointer hold survives an OCT change', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'elementFromPoint');
  });

  const pointer = (type: string): PointerEvent => {
    const e = new MouseEvent(type, { clientX: 1, clientY: 1, bubbles: true, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: 7 });
    return e as PointerEvent;
  };

  it('releases the note that pointerdown played', () => {
    const { bus, kb, keyEl } = mount();
    const notes: Array<[boolean, number]> = [];
    bus.onNote((on, note) => notes.push([on, note]));

    // jsdom has no layout, so noteAt's elementFromPoint needs standing in for.
    const target = keyEl(60);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => target,
    });

    kb.el.dispatchEvent(pointer('pointerdown'));
    expect(notes).toEqual([[true, 60]]);
    expect(target.classList.contains('active')).toBe(true);

    bus.set('keyboard.transpose', -1); // OCT moves while the key is held
    kb.el.dispatchEvent(pointer('pointerup'));

    expect(notes).toEqual([[true, 60], [false, 60]]); // not 48 — no hung voice
    expect(target.classList.contains('active')).toBe(false);
  });
});
