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

describe('stepTitle', () => {
  it('lists the percentages, and only mentions ratchet/tie when set', () => {
    expect(stepTitle({ velocity: 0.8, gate: 0.5, prob: 1, ratchet: 1, tie: false }))
      .toBe('vel 80% · gate 50% · prob 100%');
    expect(stepTitle({ velocity: 1, gate: 1, prob: 0.5, ratchet: 3, tie: true }))
      .toBe('vel 100% · gate 100% · prob 50% · ×3 · tie');
  });
});
