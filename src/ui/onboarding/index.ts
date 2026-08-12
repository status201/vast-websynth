// Onboarding facade: owns the first-visit flag and the badge listeners, and
// fronts a body that loads on demand. Created once in app.ts and handed the
// runtime hooks the steps need.
//
// The interface below is deliberately unchanged by the lazy split
// (runtime-performance.md REQ-1): app.ts wires `toggleInfoBadges`, `isActive`
// and `onChange` into the ⓘ button and `UiBridge.toggleInfoBadges` while it
// builds the header — before any gesture — so every method has to answer
// synchronously whether or not the body exists yet. The two commands return
// `void` and start the load themselves; the two readers are answerable from
// here alone (see below). Both imports are type-only, so this module carries no
// runtime edge into the ~93 kB cluster.
import type { TourCtx } from './tour';
import type { OnboardingImpl } from './onboarding-impl';

const DONE_KEY = 'websynth.onboarding.done';

export interface Onboarding {
  /** Launch (or relaunch) the guided tour. */
  startTour(): void;
  /** Toggle the ⓘ info badges. */
  toggleInfoBadges(): void;
  /** Whether the info badges are currently showing. */
  isInfoBadgesActive(): boolean;
  /** Subscribe to on/off changes — the header ⓘ button lights up from this. */
  onInfoBadgesChange(cb: (active: boolean) => void): void;
  /** True the first time only — used by main.ts to auto-launch. */
  shouldAutoLaunch(): boolean;
}

export function createOnboarding(ctx: TourCtx): Onboarding {
  let pending: Promise<OnboardingImpl> | null = null;
  // Mirrors the body's badge state so `isInfoBadgesActive` stays synchronous.
  // `false` before the body loads is exact, not a guess: the badges cannot be
  // showing while the code that shows them has not been fetched.
  let badgesActive = false;
  const badgeListeners: Array<(active: boolean) => void> = [];

  const emit = (active: boolean): void => {
    badgesActive = active;
    for (const l of badgeListeners) l(active);
  };

  const markDone = (): void => {
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      /* private mode / quota — non-fatal */
    }
  };

  // Memoized, unlike the on-demand modals, which re-`import()` freely because
  // opening one twice is idempotent. Resolving this one *constructs state*, so
  // the ⓘ button and the `?` key racing each other must not end up with two
  // InfoBadges instances fighting over the same anchors.
  const load = (): Promise<OnboardingImpl> => (pending ??= import('./onboarding-impl')
    .then((m) => m.createOnboardingImpl(ctx, emit, markDone)));

  return {
    startTour(): void {
      void load().then((impl) => impl.startTour());
    },
    toggleInfoBadges(): void {
      void load().then((impl) => impl.toggleInfoBadges());
    },
    isInfoBadgesActive(): boolean {
      return badgesActive;
    },
    onInfoBadgesChange(cb: (active: boolean) => void): void {
      badgeListeners.push(cb);
    },
    shouldAutoLaunch(): boolean {
      try {
        return localStorage.getItem(DONE_KEY) !== '1';
      } catch {
        return false;
      }
    },
  };
}
