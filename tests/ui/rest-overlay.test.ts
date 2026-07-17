import { describe, it, expect } from 'vitest';
import { buildRestOverlay } from '../../src/ui/components/rest-overlay';
import type { StudioApi } from '../../src/ui/studio-api';
import styles from '../../src/ui/styles/rest-overlay.module.css';

/** Minimal StudioApi — buildRestOverlay only reads `arrangement` lane state. */
function harness(lane: 'seq' | 'motion' = 'motion') {
  const listeners = new Set<() => void>();
  const arrangement = {
    seqResting: false,
    drumResting: false,
    samplerResting: false,
    motionResting: false,
    seq: { enabled: true, steps: [0] },
    drum: { enabled: true, steps: [0] },
    sampler: { enabled: true, steps: [0] },
    motion: { enabled: true, steps: [0] },
    onChange: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const api = { arrangement } as unknown as StudioApi;
  const notify = () => listeners.forEach((l) => l());
  return { arrangement, api, notify, lane };
}

const visible = (el: HTMLElement): boolean => el.classList.contains(styles.on!);

describe('buildRestOverlay', () => {
  it('shows while the lane rests and its chain is enabled', () => {
    const { arrangement, api, notify } = harness();
    const overlay = buildRestOverlay(api, 'motion');
    expect(visible(overlay.el)).toBe(false);
    arrangement.motionResting = true;
    notify();
    expect(visible(overlay.el)).toBe(true);
    arrangement.motion.enabled = false;
    notify();
    expect(visible(overlay.el)).toBe(false);
  });

  it('stays hidden while Follow is off; re-enabling mid-rest shows it (REQ-6)', () => {
    const { arrangement, api, notify } = harness();
    let following = true;
    const overlay = buildRestOverlay(api, 'motion', { following: () => following });
    arrangement.motionResting = true;
    notify();
    expect(visible(overlay.el)).toBe(true);
    following = false;          // editing intent — the panel refreshes on the flip
    overlay.refresh();
    expect(visible(overlay.el)).toBe(false);
    following = true;           // Follow back on while the lane still rests
    overlay.refresh();
    expect(visible(overlay.el)).toBe(true);
  });

  it('omitting the following opt keeps the previous always-on behaviour', () => {
    const { arrangement, api, notify } = harness('seq');
    const overlay = buildRestOverlay(api, 'seq');
    arrangement.seqResting = true;
    notify();
    expect(visible(overlay.el)).toBe(true);
  });
});
