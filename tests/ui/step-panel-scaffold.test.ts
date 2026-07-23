// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { bankBarFor } from '../../src/ui/panels/step-panel-scaffold';
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
