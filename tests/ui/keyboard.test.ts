import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keyboard } from '../../src/ui/components/keyboard';
import { readKeyState } from '../../src/ui/key-roles';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { SCALE_LABELS, CHORD_LABELS } from '../../src/utils/music';

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

/**
 * scale-quantization.md REQ-10 / input-control.md REQ-14 — the third highlight layer.
 *
 * Unlike `active` and `seq` this one is *static*: a standing property of a pitch class,
 * written as an attribute and rewritten wholesale, never routed through the refcounted
 * lit maps. The last two tests here are the ones that matter — they pin that the two
 * channels cannot interfere.
 */
describe('Keyboard.setKeyRoles', () => {
  const MAJOR = SCALE_LABELS.indexOf('major');
  const TRIAD = CHORD_LABELS.indexOf('triad');

  /** Every drawn key wearing `role`, as MIDI numbers. */
  const withRole = (kb: Keyboard, role: string) =>
    [...kb.el.querySelectorAll<HTMLElement>(`[data-role="${role}"]`)]
      .map((el) => Number(el.dataset.note))
      .sort((a, b) => a - b);

  const roled = (kb: Keyboard) => kb.el.querySelectorAll('[data-role]').length;

  it('marks every octave of a pitch class, and leaves out-of-scale keys bare', () => {
    const { bus, kb } = mount();
    bus.set('scale.type', MAJOR);
    kb.setKeyRoles(readKeyState(bus));

    // C3-B5 is drawn, so three C's and three D's.
    expect(withRole(kb, 'root')).toEqual([48, 60, 72]);
    expect(withRole(kb, 'scale')).toContain(50); // D3
    expect(withRole(kb, 'scale')).toContain(74); // D5
    // Out of scale carries no role at all: those keys still sound (quantized), so
    // dimming them would claim otherwise (REQ-10).
    expect(withRole(kb, 'out')).toEqual([]);
    expect(kb.el.querySelector('[data-note="49"]')!.getAttribute('data-role')).toBeNull();
  });

  it('lets the root outrank its other roles', () => {
    const { bus, kb } = mount();
    bus.set('scale.type', MAJOR);
    bus.set('chord.voicing', TRIAD);
    kb.setKeyRoles(readKeyState(bus));

    expect(withRole(kb, 'root')).toEqual([48, 60, 72]);        // C, not a chord tone
    expect(withRole(kb, 'chord')).toEqual([52, 55, 64, 67, 76, 79]); // E and G
    expect(withRole(kb, 'scale')).toContain(50);               // D
  });

  it('clears every role when handed null — what chromatic gets', () => {
    const { bus, kb } = mount();
    bus.set('scale.type', MAJOR);
    kb.setKeyRoles(readKeyState(bus));
    expect(roled(kb)).toBeGreaterThan(0);

    kb.setKeyRoles(null);
    expect(roled(kb)).toBe(0);
  });

  it('needs no repaint when OCT moves (REQ-10, cost)', () => {
    // Roles are keyed by pitch class and `keyboard.transpose` moves in whole octaves,
    // so an element's own pitch class IS its sounding pitch class. Nothing to redo.
    const { bus, kb } = mount();
    bus.set('scale.type', MAJOR);
    kb.setKeyRoles(readKeyState(bus));
    const before = withRole(kb, 'root');

    bus.set('keyboard.transpose', 1);
    expect(withRole(kb, 'root')).toEqual(before);
  });

  it('does not disturb a lit key (input-control.md REQ-14)', () => {
    const { bus, kb, keyEl } = mount();
    bus.set('scale.type', MAJOR);
    kb.setKeyRoles(readKeyState(bus));

    kb.seqHighlight(60, true);
    expect(keyEl(60).classList.contains('seq')).toBe(true);
    expect(keyEl(60).dataset.role).toBe('root');

    // Re-role the whole board mid-flight, the way a scale change would.
    bus.set('scale.root', 5);
    kb.setKeyRoles(readKeyState(bus));

    expect(keyEl(60).classList.contains('seq')).toBe(true);   // still lit
    expect(keyEl(60).dataset.role).toBe('scale');             // C is in F major

    kb.seqHighlight(60, false);
    expect(kb.el.querySelectorAll('.seq')).toHaveLength(0);   // the off still lands
    expect(keyEl(60).dataset.role).toBe('scale');             // and leaves the role
  });

  it('skips a write for a role already in place (runtime-performance.md REQ-7)', () => {
    const { bus, kb } = mount();
    const obs = new MutationObserver(() => {});
    obs.observe(kb.el, { attributes: true, subtree: true, attributeFilter: ['data-role'] });

    bus.set('scale.type', MAJOR);
    const state = readKeyState(bus);
    kb.setKeyRoles(state);
    expect(obs.takeRecords().length).toBeGreaterThan(0);      // the observer works

    kb.setKeyRoles(state);                                    // nothing has changed
    expect(obs.takeRecords()).toHaveLength(0);
    obs.disconnect();
  });
});
