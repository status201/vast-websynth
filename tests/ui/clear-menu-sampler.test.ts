// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMenuFor, samplerSlotClearRow } from '../../src/ui/panels/step-panel-scaffold';
import { PatternStore } from '../../src/state/patterns';
import { PatternUndo } from '../../src/state/pattern-undo';
import type { StudioApi } from '../../src/ui/studio-api';

/**
 * sampler.md REQ-9 — the sampler's Clear ▾ row item is labelled with the slot's
 * FILENAME, so it has to remove the file: steps, name and buffer. Before v5 it
 * cleared steps only, which meant a slot holding just a name (the shape every
 * song import lands in) had nothing to clear — the item was silently inert, and
 * the name kept riding along in every song saved afterwards.
 *
 * These drive the real menu DOM rather than the row object, because the wiring
 * under test is precisely which Undo the toast gets (step-grid-editing.md REQ-7).
 */

/** Two distinguishable AudioBuffer stand-ins — only identity matters here. */
const bufA = { id: 'A' } as unknown as AudioBuffer;
const bufB = { id: 'B' } as unknown as AudioBuffer;

function harness() {
  const patterns = new PatternStore();
  const undo = new PatternUndo(patterns);
  const buffers: (AudioBuffer | null)[] = Array(8).fill(null);
  const sampler = {
    buffers,
    setBuffer: (slot: number, buf: AudioBuffer | null) => { buffers[slot] = buf; },
  };
  const arrangement = {
    seqPlayBank: 0, drumPlayBank: 0, samplerPlayBank: 0, motionPlayBank: 0,
    seqResting: false, drumResting: false, samplerResting: false, motionResting: false,
    onChange: () => () => {},
  };
  const api = { patterns, arrangement, sampler } as unknown as StudioApi;

  const menu = clearMenuFor(api, 'sampler', undo, () => [samplerSlotClearRow(api, undo, 0)]);
  document.body.appendChild(menu);

  const click = (testId: string): void => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!el) throw new Error(`no [data-testid="${testId}"]`);
    el.click();
  };
  return {
    patterns, undo, buffers,
    /** Open the menu — the rows resolve here, not at build time. */
    open: () => click('clear-sampler'),
    /** Open and pick an item. */
    pick: (item: string) => { click('clear-sampler'); click(item); },
    toast: () => document.querySelector<HTMLElement>('[data-testid="clear-toast-sampler"]'),
    pressUndo: () => click('toast-action'),
  };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('sampler Clear ▾ → row (sampler.md REQ-9)', () => {
  it('empties a slot that holds only a name — the item is no longer inert', () => {
    const h = harness();
    h.patterns.setSampleName(0, 'kick.wav');
    h.buffers[0] = bufA;

    h.pick('clear-sampler-row-0');

    expect(h.patterns.sampleNames[0]).toBeNull();
    expect(h.buffers[0]).toBeNull();
    // The name is what a song carries (buffers never are), so this is the half
    // of the bug the user sees days later, in the saved file.
    expect(h.patterns.snapshot().sampleNames[0]).toBeNull();
    expect(h.toast()?.textContent).toContain('Cleared kick.wav');
  });

  it('names the item after the file, so the label and the outcome agree', () => {
    const h = harness();
    h.patterns.setSampleName(0, 'kick.wav');

    h.open();
    const row = document.querySelector('[data-testid="clear-sampler-row-0"]');
    expect(row?.textContent).toBe('Clear kick.wav');
  });

  it('restores name, audio and steps in one Undo press', () => {
    const h = harness();
    h.patterns.setSampleName(0, 'kick.wav');
    h.buffers[0] = bufA;
    h.patterns.setSamplerCell(0, 4, { on: true });
    h.patterns.setSamplerCell(0, 12, { on: true });

    h.pick('clear-sampler-row-0');
    expect(h.patterns.sampler[0]!.filter((c) => c.on)).toHaveLength(0);

    h.pressUndo();
    expect(h.patterns.sampleNames[0]).toBe('kick.wav');
    expect(h.buffers[0]).toBe(bufA);            // the same buffer, not a re-decode
    expect(h.patterns.sampler[0]![4]!.on).toBe(true);
    expect(h.patterns.sampler[0]![12]!.on).toBe(true);
  });

  it('does not pop an unrelated edit when the slot held no steps (edge)', () => {
    const h = harness();
    // An earlier edit the user still wants: slot 1's step, on the sampler stack.
    h.patterns.setSamplerCell(1, 7, { on: true });
    h.patterns.setSampleName(0, 'kick.wav');
    h.buffers[0] = bufA;

    h.pick('clear-sampler-row-0');
    h.pressUndo();

    expect(h.patterns.sampleNames[0]).toBe('kick.wav');
    expect(h.buffers[0]).toBe(bufA);
    // Untouched: the row cleared no steps, so it must not have called the
    // lane's pattern undo at all.
    expect(h.patterns.sampler[1]![7]!.on).toBe(true);
    expect(h.undo.canUndo('sampler')).toBe(true);
  });

  it('is not offered at all on an empty slot (step-grid-editing.md REQ-6)', () => {
    const h = harness();
    h.open();

    expect(document.querySelector('[data-testid="clear-sampler-row-0"]')).toBeNull();
    expect(document.querySelector('[data-testid="clear-sampler-bank"]')).not.toBeNull();
  });

  it('IS offered on a slot holding only a name — that is what it removes', () => {
    const h = harness();
    h.patterns.setSampleName(0, 'kick.wav');
    h.open();

    expect(document.querySelector('[data-testid="clear-sampler-row-0"]')).not.toBeNull();
  });

  it('clears steps only in the edit bank, leaving the other banks alone', () => {
    const h = harness();
    h.patterns.setSamplerEditBank(1);
    h.patterns.setSamplerCell(0, 3, { on: true });
    h.patterns.setSamplerEditBank(0);
    h.patterns.setSampleName(0, 'kick.wav');
    h.patterns.setSamplerCell(0, 3, { on: true });

    h.pick('clear-sampler-row-0');

    expect(h.patterns.sampler[0]![3]!.on).toBe(false);
    expect(h.patterns.samplerBank(1)[0]![3]!.on).toBe(true);
  });
});

describe('sampler Clear ▾ → bank (sampler.md REQ-9, the deliberate exception)', () => {
  it('never ejects a sample: names are shared by all four banks', () => {
    const h = harness();
    h.patterns.setSampleName(0, 'kick.wav');
    h.patterns.setSampleName(1, 'snare.wav');
    h.buffers[0] = bufA;
    h.buffers[1] = bufB;
    h.patterns.setSamplerCell(0, 2, { on: true });

    h.pick('clear-sampler-bank');

    expect(h.patterns.sampler[0]![2]!.on).toBe(false);
    expect(h.patterns.sampleNames[0]).toBe('kick.wav');
    expect(h.patterns.sampleNames[1]).toBe('snare.wav');
    expect(h.buffers[0]).toBe(bufA);
    expect(h.buffers[1]).toBe(bufB);
  });
});
