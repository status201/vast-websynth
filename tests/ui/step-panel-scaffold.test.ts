// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { bankBarFor, wirePlayhead, VisibilityGate } from '../../src/ui/panels/step-panel-scaffold';
import { PatternStore } from '../../src/state/patterns';
import type { StudioApi } from '../../src/ui/studio-api';

/**
 * Minimal StudioApi — `bankBarFor` only reads `patterns` plus the lane's
 * arrangement state (the machine's `onStep` is never touched here; that is
 * `wirePlayhead`'s job). Same stub shape as tests/ui/rest-overlay.test.ts.
 */
function harness() {
  const patterns = new PatternStore();
  const arrangement = {
    seqPlayBank: 0,
    drumPlayBank: 0,
    samplerPlayBank: 0,
    motionPlayBank: 0,
    seqResting: false,
    drumResting: false,
    samplerResting: false,
    motionResting: false,
    onChange: () => () => {},
  };
  const api = { patterns, arrangement } as unknown as StudioApi;
  return { patterns, api };
}

/** The bank buttons of a BankBar, in A..D order (Follow leads, Copy trails). */
function bankButtons(el: HTMLElement): HTMLButtonElement[] {
  return ([...el.querySelectorAll('button')] as HTMLButtonElement[]).slice(1, 5);
}

const filled = (b: HTMLButtonElement | undefined): boolean =>
  b?.classList.contains('filled') ?? false;

// banks.md REQ-6 — the content dot must count every lane a machine stores in a
// bank. Motion has three (XY anchors + tracks A/B); counting only the XY lane
// rendered a track-only bank as empty.
describe('bankBarFor content dot (banks.md REQ-6)', () => {
  it('lights a motion bank whose A track holds steps but whose XY lane is empty', () => {
    const { patterns, api } = harness();
    patterns.setMotionEditBank(1);
    patterns.setMotionTrackStep(0, 4, { on: true, v: 0.75 });
    patterns.setMotionEditBank(0);

    const banks = bankButtons(bankBarFor(api, 'motion').el);
    expect(filled(banks[1])).toBe(true);
    expect(filled(banks[0])).toBe(false);
  });

  it('repaints on track edits, not just anchor edits', () => {
    const { patterns, api } = harness();
    const banks = bankButtons(bankBarFor(api, 'motion').el);
    expect(filled(banks[0])).toBe(false);

    patterns.setMotionTrackStep(1, 0, { on: true, v: 0.5 });
    expect(filled(banks[0])).toBe(true);

    patterns.setMotionTrackStep(1, 0, { on: false });
    expect(filled(banks[0])).toBe(false);
  });

  it('still lights an XY-only motion bank (no regression)', () => {
    const { patterns, api } = harness();
    const banks = bankButtons(bankBarFor(api, 'motion').el);

    patterns.setMotionStep(2, { on: true, x: 0.3, y: 0.6 });
    expect(filled(banks[0])).toBe(true);
  });

  it('leaves untouched motion banks dark', () => {
    const { api } = harness();
    const banks = bankButtons(bankBarFor(api, 'motion').el);
    expect(banks.map(filled)).toEqual([false, false, false, false]);
  });

  it('counts every sequencer track and every drum row', () => {
    const { patterns, api } = harness();
    const seq = bankButtons(bankBarFor(api, 'seq').el);
    // Track 2 only — the seq bank is track-major, so a per-track sweep is needed.
    patterns.setSeqStep(2, 0, { on: true });
    expect(filled(seq[0])).toBe(true);

    // Bank A ships with the default groove; the rest start empty.
    const drum = bankButtons(bankBarFor(api, 'drum').el);
    expect(filled(drum[0])).toBe(true);
    expect(filled(drum[3])).toBe(false);
  });
});

/**
 * Off-screen repaint gating (runtime-performance.md REQ-4). TabContainer hides
 * inactive panels with a class, so all four stay subscribed and would otherwise
 * sweep a playhead every 16th against DOM nobody can see. The risk the gate
 * introduces is *staleness*, so that is what these pin.
 */
describe('VisibilityGate', () => {
  it('starts shown, so a panel built before its TabContainer is never dark', () => {
    expect(new VisibilityGate().shown).toBe(true);
  });

  it('fires whenShown only on a hidden→shown edge', () => {
    const gate = new VisibilityGate();
    let shows = 0;
    gate.whenShown(() => { shows++; });

    gate.set(true); // already shown — not an edge
    expect(shows).toBe(0);
    gate.set(false);
    expect(gate.shown).toBe(false);
    expect(shows).toBe(0);
    gate.set(false); // repeat — not an edge
    expect(shows).toBe(0);
    gate.set(true);
    expect(shows).toBe(1);
  });

  it('stops calling a disposed listener', () => {
    const gate = new VisibilityGate();
    let shows = 0;
    const off = gate.whenShown(() => { shows++; });
    gate.set(false);
    gate.set(true);
    expect(shows).toBe(1);
    off();
    gate.set(false);
    gate.set(true);
    expect(shows).toBe(1);
  });
});

describe('wirePlayhead visibility gating (runtime-performance.md REQ-4)', () => {
  /** A one-row grid of fake cells plus a step emitter and a refresh counter. */
  function playheadHarness() {
    const { patterns, api } = harness();
    let emit: ((idx: number) => void) | undefined;
    (api as unknown as { seq: unknown }).seq = {
      onStep: (fn: (i: number) => void) => { emit = fn; return () => {}; },
    };
    const playing: boolean[] = Array(16).fill(false);
    const row = playing.map((_, i) => ({ setPlaying: (p: boolean) => { playing[i] = p; } }));
    let refreshes = 0;
    const restOverlay = { el: document.createElement('div'), refresh: () => { refreshes++; } };
    const gate = new VisibilityGate();
    wirePlayhead(api, 'seq', [row], restOverlay, gate);
    return {
      patterns,
      gate,
      step: (i: number) => emit!(i),
      lit: () => playing.indexOf(true),
      refreshes: () => refreshes,
    };
  }

  it('paints while visible', () => {
    const h = playheadHarness();
    h.step(5);
    expect(h.lit()).toBe(5);
    expect(h.refreshes()).toBeGreaterThan(0);
  });

  it('does no work at all while hidden', () => {
    const h = playheadHarness();
    h.step(3);
    const before = h.refreshes();

    h.gate.set(false);
    for (let i = 4; i < 12; i++) h.step(i);
    expect(h.lit()).toBe(3);          // frozen where it was
    expect(h.refreshes()).toBe(before); // and the overlay was never touched
  });

  it('lands on the CURRENT step when revealed, not the one it left on', () => {
    const h = playheadHarness();
    h.step(2);
    h.gate.set(false);
    for (let i = 3; i <= 9; i++) h.step(i);
    h.gate.set(true);
    expect(h.lit()).toBe(9);
    expect(h.refreshes()).toBeGreaterThan(1);
  });

  it('revealing before any step has played paints nothing (edge)', () => {
    const h = playheadHarness();
    h.gate.set(false);
    h.gate.set(true);
    expect(h.lit()).toBe(-1);
  });

  it('without a gate it behaves exactly as before', () => {
    const { patterns, api } = harness();
    let emit: ((idx: number) => void) | undefined;
    (api as unknown as { drums: unknown }).drums = {
      onStep: (fn: (i: number) => void) => { emit = fn; return () => {}; },
    };
    void patterns;
    const playing: boolean[] = Array(16).fill(false);
    const row = playing.map((_, i) => ({ setPlaying: (p: boolean) => { playing[i] = p; } }));
    wirePlayhead(api, 'drum', [row], { el: document.createElement('div'), refresh: () => {} });
    emit!(7);
    expect(playing.indexOf(true)).toBe(7);
  });
});
