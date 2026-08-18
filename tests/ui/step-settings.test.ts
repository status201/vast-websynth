import { describe, it, expect, vi, afterEach } from 'vitest';
import { StepSettingsEditor, stepTitle } from '../../src/ui/components/step-settings';
import { TRIGGER_CELL_DEFAULTS, type StepSettings } from '../../src/state/patterns';

/**
 * The shared per-step edit row. Covers the drag-listener lifecycle
 * (runtime-performance.md REQ-3) — three of these are mounted at once (seq /
 * drum / sampler), each with three sliders, so a constructor-scoped `window`
 * pointermove handler here runs nine times on every mouse move anywhere on the
 * page (the exact trap Knob documents).
 */

const isPointer = (t: unknown): boolean =>
  t === 'pointermove' || t === 'pointerup' || t === 'pointercancel';

/** An editor over one mutable step, plus the patches it wrote. */
function build() {
  const step: StepSettings = { ...TRIGGER_CELL_DEFAULTS };
  const patches: Array<Partial<StepSettings>> = [];
  const editor = new StepSettingsEditor({
    testidPrefix: 'drum',
    get: () => step,
    set: (p) => { patches.push(p); Object.assign(step, p); },
  });
  document.body.appendChild(editor.el);
  return { editor, step, patches };
}

const trackOf = (editor: StepSettingsEditor, testid: string): HTMLElement =>
  editor.el.querySelector<HTMLElement>(`[data-testid="${testid}"] div:nth-child(2)`)!;

// jsdom lays nothing out, so every getBoundingClientRect is 0×0 — stub the one
// the slider measures at pointerdown so the drag maths has a real box.
function stubBox(el: HTMLElement, left = 0, width = 100): void {
  el.getBoundingClientRect = () =>
    ({ left, width, right: left + width, top: 0, bottom: 10, height: 10, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('StepSettingsEditor slider drag lifecycle', () => {
  it('adds no window pointer listeners on construction (REQ-3)', () => {
    const add = vi.spyOn(window, 'addEventListener');
    build();
    expect(add.mock.calls.filter(([t]) => isPointer(t)).length).toBe(0);
  });

  it('attaches on pointerdown and removes every one on pointerup', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { editor } = build();
    const track = trackOf(editor, 'drum-vel');
    stubBox(track);

    track.dispatchEvent(new MouseEvent('pointerdown', { clientX: 50, bubbles: true }));
    const added = add.mock.calls.filter(([t]) => isPointer(t)).length;
    expect(added).toBeGreaterThan(0);

    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(remove.mock.calls.filter(([t]) => isPointer(t)).length).toBe(added);
  });

  it('a cancelled stroke releases the listeners too (edge)', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { editor } = build();
    const track = trackOf(editor, 'drum-gate');
    stubBox(track);

    track.dispatchEvent(new MouseEvent('pointerdown', { clientX: 10, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointercancel'));
    expect(remove.mock.calls.filter(([t]) => isPointer(t)).length)
      .toBe(add.mock.calls.filter(([t]) => isPointer(t)).length);
  });

  it('moves after the stroke ends write nothing', () => {
    const { editor, patches } = build();
    const track = trackOf(editor, 'drum-vel');
    stubBox(track);

    track.dispatchEvent(new MouseEvent('pointerdown', { clientX: 25, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 75 }));
    const during = patches.length;
    expect(during).toBeGreaterThan(1); // the press itself plus the move

    window.dispatchEvent(new MouseEvent('pointerup'));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10 }));
    expect(patches.length).toBe(during);
  });

  it('drags map the pointer across the track box and clamp at the ends', () => {
    const { editor, step } = build();
    const track = trackOf(editor, 'drum-vel');
    stubBox(track, 20, 200); // 20..220

    track.dispatchEvent(new MouseEvent('pointerdown', { clientX: 120, bubbles: true }));
    expect(step.velocity).toBeCloseTo(0.5, 5);

    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 9999 }));
    expect(step.velocity).toBe(1);
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: -9999 }));
    expect(step.velocity).toBe(0);
    window.dispatchEvent(new MouseEvent('pointerup'));
  });

  it('paints the fill with a transform, never a width (REQ-3 / layout)', () => {
    const { editor, step } = build();
    step.velocity = 0.25;
    editor.refresh();
    const fill = editor.el
      .querySelector<HTMLElement>('[data-testid="drum-vel"] div:nth-child(2)')!
      .firstElementChild as HTMLElement;
    expect(fill.style.transform).toBe('scaleX(0.25)');
    expect(fill.style.width).toBe('');
  });
});

describe('StepSettingsEditor controls', () => {
  it('ratchet buttons and tie write through and reflect the step', () => {
    const { editor, step, patches } = build();
    editor.el.querySelector<HTMLButtonElement>('[data-testid="drum-ratchet-3"]')!.click();
    expect(patches.at(-1)).toEqual({ ratchet: 3 });

    editor.el.querySelector<HTMLButtonElement>('[data-testid="drum-tie"]')!.click();
    expect(step.tie).toBe(true);
    editor.refresh();
    expect(editor.el.querySelector('[data-testid="drum-tie"]')!.classList.contains('on')).toBe(true);
    expect(editor.el.querySelector('[data-testid="drum-ratchet-3"]')!.classList.contains('on')).toBe(true);
  });
});

// step-settings.md REQ-6 + its gesture inventory. Micro is the one bipolar,
// stepped control in the row, and the one that takes keys.
describe('the Micro slider (v3)', () => {
  const microTrack = (editor: StepSettingsEditor): HTMLElement => {
    const t = editor.el.querySelector<HTMLElement>('[data-testid="drum-micro-track"]')!;
    stubBox(t, 0, 240); // 240px over the 25-notch range
    return t;
  };
  const readout = (editor: StepSettingsEditor): string =>
    editor.el.querySelector('[data-testid="drum-micro-value"]')!.textContent!;
  const stepper = (editor: StepSettingsEditor, dir: 'dec' | 'inc'): HTMLButtonElement =>
    editor.el.querySelector<HTMLButtonElement>(`[data-testid="drum-micro-${dir}"]`)!;

  it('starts centred at 0 and reads as 0, not a percentage', () => {
    const { editor } = build();
    expect(readout(editor)).toBe('0');
  });

  it('snaps a drag to whole notches and reads them as a fraction of a step', () => {
    const { editor, step } = build();
    const track = microTrack(editor);
    // The far right of the track is +MICRO_MAX.
    track.dispatchEvent(new MouseEvent('pointerdown', { clientX: 240, bubbles: true }));
    expect(step.micro).toBe(12);
    expect(readout(editor)).toBe('+12/24');
    window.dispatchEvent(new MouseEvent('pointerup'));

    // The far left is -MICRO_MAX.
    track.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, bubbles: true }));
    expect(step.micro).toBe(-12);
    expect(readout(editor)).toBe('-12/24');
    window.dispatchEvent(new MouseEvent('pointerup'));

    // Anywhere between lands on an integer, never a fraction.
    track.dispatchEvent(new MouseEvent('pointerdown', { clientX: 137, bubbles: true }));
    expect(Number.isInteger(step.micro)).toBe(true);
    window.dispatchEvent(new MouseEvent('pointerup'));
  });

  it('writes nothing when a drag stays inside one notch (no undo spam)', () => {
    const { editor, patches } = build();
    const track = microTrack(editor);
    track.dispatchEvent(new MouseEvent('pointerdown', { clientX: 240, bubbles: true }));
    const after = patches.length;
    // Several moves that all resolve to the same notch.
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 239 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 238 }));
    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(patches.length).toBe(after);
  });

  it('moves one notch per arrow key and clamps at the ends', () => {
    const { editor, step } = build();
    const track = microTrack(editor);
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(step.micro).toBe(1);
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(step.micro).toBe(-1);
    for (let i = 0; i < 40; i++) {
      track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    }
    expect(step.micro).toBe(-12);
  });

  it('stops the arrow key reaching the global shortcut handler (ADR-014 law 2)', () => {
    const { editor } = build();
    const track = microTrack(editor);
    // shortcuts.ts binds keydown on `window` in the BUBBLE phase; an unstopped
    // bare arrow would also shift the playable keyboard's octave.
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onWindow).not.toHaveBeenCalled();
    window.removeEventListener('keydown', onWindow);
  });

  it('lets an unclaimed key through untouched', () => {
    const { editor } = build();
    const track = microTrack(editor);
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    // 'z' is a playable note key — the slider must not swallow it.
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    expect(onWindow).toHaveBeenCalled();
    window.removeEventListener('keydown', onWindow);
  });

  it('returns to 0 on a double-click', () => {
    const { editor, step } = build();
    const track = microTrack(editor);
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(step.micro).toBe(1);
    track.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(step.micro).toBe(0);
    expect(readout(editor)).toBe('0');
  });

  it('is focusable, so the arrow keys have somewhere to land', () => {
    const { editor } = build();
    expect(microTrack(editor).tabIndex).toBe(0);
    // The continuous sliders are not — they have no key gesture.
    expect(trackOf(editor, 'drum-vel').tabIndex).toBe(-1);
  });

  it('moves one notch per −/+ press and clamps at the ends', () => {
    const { editor, step } = build();
    stepper(editor, 'inc').click();
    expect(step.micro).toBe(1);
    stepper(editor, 'inc').click();
    expect(step.micro).toBe(2);
    stepper(editor, 'dec').click();
    expect(step.micro).toBe(1);
    for (let i = 0; i < 40; i++) stepper(editor, 'dec').click();
    expect(step.micro).toBe(-12);
    for (let i = 0; i < 40; i++) stepper(editor, 'inc').click();
    expect(step.micro).toBe(12);
  });

  it('brackets the track with the steppers, readout last', () => {
    const { editor } = build();
    const kids = [...editor.el.querySelector('[data-testid="drum-micro"]')!.children];
    const ids = kids.map((k) => (k as HTMLElement).dataset.testid ?? 'label');
    expect(ids).toEqual(['label', 'drum-micro-dec', 'drum-micro-track',
      'drum-micro-inc', 'drum-micro-value']);
  });

  it('keeps the buttons in step with the readout', () => {
    const { editor } = build();
    stepper(editor, 'dec').click();
    expect(readout(editor)).toBe('-1/24');
    stepper(editor, 'inc').click();
    expect(readout(editor)).toBe('0');
  });
});

describe('stepTitle', () => {
  it('lists the percentages, and only mentions ratchet/tie/micro when set', () => {
    expect(stepTitle({ velocity: 0.8, gate: 0.5, prob: 1, ratchet: 1, tie: false, micro: 0 }))
      .toBe('vel 80% · gate 50% · prob 100%');
    expect(stepTitle({ velocity: 1, gate: 1, prob: 0.5, ratchet: 3, tie: true, micro: 0 }))
      .toBe('vel 100% · gate 100% · prob 50% · ×3 · tie');
    expect(stepTitle({ velocity: 1, gate: 1, prob: 1, ratchet: 1, tie: false, micro: -4 }))
      .toBe('vel 100% · gate 100% · prob 100% · micro -4/24');
  });
});
