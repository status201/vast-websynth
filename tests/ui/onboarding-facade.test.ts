import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TourCtx } from '../../src/ui/onboarding/tour';

/**
 * The onboarding facade's half of runtime-performance.md REQ-1: the body loads
 * on the first command, and *nothing* about that is visible to a caller.
 *
 * The body is mocked rather than exercised — tour.ts and info-badges.ts have
 * their own tests, and what matters here is the seam: when the import fires,
 * how many times it fires, and what the facade can answer before it has.
 * `evaluated` counts factory runs, so "the chunk was never fetched" is an
 * assertion rather than an assumption.
 */
const h = vi.hoisted(() => ({
  state: { evaluated: 0 },
  createOnboardingImpl: vi.fn(),
}));

vi.mock('../../src/ui/onboarding/onboarding-impl', () => {
  h.state.evaluated += 1;
  return { createOnboardingImpl: h.createOnboardingImpl };
});

const { createOnboarding } = await import('../../src/ui/onboarding');

const ctx = { bus: {}, engine: {} } as unknown as TourCtx;

describe('Onboarding facade (runtime-performance.md REQ-1)', () => {
  let startTour: ReturnType<typeof vi.fn>;
  let toggle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    h.state.evaluated = 0;
    h.createOnboardingImpl.mockReset();
    // Fresh spies per test with stable identity: a `vi.fn()` minted inside the
    // factory would leave the previous test's spy visible to `waitFor` until
    // this test's load resolved, and every wait would pass instantly.
    let active = false;
    startTour = vi.fn();
    toggle = vi.fn();
    h.createOnboardingImpl.mockImplementation(
      (_ctx: TourCtx, onBadgeChange: (a: boolean) => void, markDone: () => void) => {
        startTour.mockImplementation(() => markDone());
        toggle.mockImplementation(() => {
          active = !active;
          onBadgeChange(active);
        });
        return { startTour, toggleInfoBadges: toggle };
      },
    );
  });

  it('answers both readers synchronously without loading the body', () => {
    const onboarding = createOnboarding(ctx);

    // The ⓘ button reads this while app.ts builds the header — long before any
    // gesture could have triggered a load.
    expect(onboarding.isInfoBadgesActive()).toBe(false);
    expect(onboarding.shouldAutoLaunch()).toBe(true);

    expect(h.state.evaluated).toBe(0);
    expect(h.createOnboardingImpl).not.toHaveBeenCalled();
  });

  it('builds one body when two triggers race the same load', async () => {
    const onboarding = createOnboarding(ctx);
    const seen: boolean[] = [];
    onboarding.onInfoBadgesChange((a) => seen.push(a));

    // The ⓘ button and the `?` key, both before the import resolves.
    onboarding.toggleInfoBadges();
    onboarding.toggleInfoBadges();
    await vi.waitFor(() => expect(seen).toHaveLength(2));

    expect(h.createOnboardingImpl).toHaveBeenCalledTimes(1);
    expect(h.state.evaluated).toBe(1);
    // Two toggles net out, and the facade's mirror tracked both.
    expect(seen).toEqual([true, false]);
    expect(onboarding.isInfoBadgesActive()).toBe(false);
  });

  it('shares one body between the tour and the badges', async () => {
    const onboarding = createOnboarding(ctx);

    onboarding.startTour();
    onboarding.toggleInfoBadges();
    await vi.waitFor(() => expect(toggle).toHaveBeenCalled());

    expect(h.createOnboardingImpl).toHaveBeenCalledTimes(1);
    expect(startTour).toHaveBeenCalledTimes(1);
  });

  it('mirrors the body-side badge state once loaded', async () => {
    const onboarding = createOnboarding(ctx);

    onboarding.toggleInfoBadges();
    await vi.waitFor(() => expect(onboarding.isInfoBadgesActive()).toBe(true));
  });

  it('stops auto-launching once the tour has run', async () => {
    const onboarding = createOnboarding(ctx);
    expect(onboarding.shouldAutoLaunch()).toBe(true);

    // markDone is injected into the body, so the flag is the facade's to own.
    onboarding.startTour();
    await vi.waitFor(() => expect(startTour).toHaveBeenCalled());

    expect(onboarding.shouldAutoLaunch()).toBe(false);
    expect(createOnboarding(ctx).shouldAutoLaunch()).toBe(false);
  });
});
