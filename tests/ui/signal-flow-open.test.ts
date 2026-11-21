import { describe, it, expect, vi } from 'vitest';

/**
 * signal-flow-map.md REQ-the-map-costs-nothing-until-opened: the map's one door.
 * A second click while the first open is still loading (a slow link) is the
 * same open — never a second map stacked on the first.
 */
const h = vi.hoisted(() => {
  let release: () => void = () => {};
  return {
    gate: () => new Promise<void>((r) => { release = r; }),
    release: () => release(),
    show: vi.fn(),
  };
});

vi.mock('../../src/ui/signal-flow/signal-flow-modal', () => ({
  showSignalFlow: async (...args: unknown[]) => {
    h.show(...args);
    await h.gate();
  },
}));

const { openSignalFlow } = await import('../../src/ui/signal-flow/open');

describe('openSignalFlow', () => {
  it('opens once however often it is asked while loading, and again afterwards', async () => {
    const first = openSignalFlow(['filter']);
    const second = openSignalFlow();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
    expect(h.show.mock.calls[0]![1]).toEqual(['filter']);

    h.release();
    await first;
    const third = openSignalFlow();
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
    h.release();
    await third;
  });
});
