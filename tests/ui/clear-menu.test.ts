// @vitest-environment jsdom
// step-grid-editing.md REQ-shift-rotates-the-played-window — the Clear ▾ menu's shift items.
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMenuFor } from '../../src/ui/panels/step-panel-scaffold';
import { PatternStore } from '../../src/state/patterns';
import { PatternUndo } from '../../src/state/pattern-undo';
import type { StudioApi } from '../../src/ui/studio-api';

function harness(lane: 'drum' | 'motion', shiftCells?: () => number) {
  const patterns = new PatternStore();
  patterns.clearDrumBank();
  const arrangement = {
    seqPlayBank: 0, drumPlayBank: 0, samplerPlayBank: 0, motionPlayBank: 0,
    seqResting: false, drumResting: false, samplerResting: false, motionResting: false,
    onChange: () => () => {},
  };
  const api = { patterns, arrangement } as unknown as StudioApi;
  const undo = new PatternUndo(patterns);
  document.body.appendChild(clearMenuFor(api, lane, undo, undefined, shiftCells));
  const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { patterns, undo, byId, open: () => byId(`clear-${lane}`)!.click() };
}

const onCells = (row: readonly { on: boolean }[]): number[] =>
  row.flatMap((c, i) => (c.on ? [i] : []));

beforeEach(() => { document.body.innerHTML = ''; });

describe('Clear ▾ shift items', () => {
  it('shifts the bank within the window the panel reports, with an Undo toast', () => {
    const h = harness('drum', () => 12);
    h.patterns.setDrumCell(0, 11, { on: true });
    h.open();
    expect(h.byId('clear-drum-shift-left')!.textContent).toBe('Shift bank A left');
    h.byId('clear-drum-shift-right')!.click();
    expect(onCells(h.patterns.drum[0]!)).toEqual([0]);   // wrapped at the 12-cell window
    const toast = h.byId('clear-toast-drum')!;
    expect(toast.textContent).toContain('Shifted bank A right');
    toast.querySelector('button')!.click();               // Undo
    expect(onCells(h.patterns.drum[0]!)).toEqual([11]);
  });

  it('an empty bank shifts silently — no toast', () => {
    const h = harness('drum', () => 16);
    h.open();
    h.byId('clear-drum-shift-left')!.click();
    expect(h.byId('clear-toast-drum')).toBeNull();
  });

  it('is not offered without a window, nor on the motion lane', () => {
    const plain = harness('drum');
    plain.open();
    expect(plain.byId('clear-drum-shift-left')).toBeNull();
    document.body.innerHTML = '';
    const motion = harness('motion', () => 16);
    motion.open();
    expect(motion.byId('clear-motion-shift-left')).toBeNull();
  });
});
