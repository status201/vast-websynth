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
// here alone (see below). The two body-side imports are type-only, so this
// module carries no runtime edge into the ~93 kB cluster; the one value import
// is the load-failure toast, which is already in the entry chunk.
import { showLazyLoadFailure } from '../components/lazy-load-toast';
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
  //
  // A *rejection* must not be memoized though (onboarding.md REQ-24): the cache
  // would make one offline click permanent, leaving the tour dead for the rest
  // of the session even once the network came back. Clearing `pending` before
  // rethrowing keeps the state-sharing guarantee — a failed load constructed
  // nothing, so there is nothing for a later load to duplicate.
  const load = (): Promise<OnboardingImpl> => (pending ??= import('./onboarding-impl')
    .then((m) => m.createOnboardingImpl(ctx, emit, markDone))
    .catch((err: unknown) => {
      pending = null;
      throw err;
    }));

  /** Run `use` against the body, reporting rather than swallowing a failed load.
   *  `retry` is the command itself, so Retry repeats the whole gesture. */
  const withImpl = (surface: string, retry: () => void, use: (impl: OnboardingImpl) => void): void => {
    // Two-arg `then`, not `.catch`: only the *load* may raise the toast — a
    // throw from inside the tour or the badges is a bug, not a missing chunk.
    void load().then(use, () => showLazyLoadFailure(surface, retry));
  };

  // Standalone consts, not object methods: app.ts hands these to the ⓘ button
  // and UiBridge as bare references, so a `this`-based self-reference would be
  // undefined by the time Retry fired.
  const startTour = (): void => withImpl('the guided tour', startTour, (impl) => impl.startTour());
  const toggleInfoBadges = (): void =>
    withImpl('the info badges', toggleInfoBadges, (impl) => impl.toggleInfoBadges());

  return {
    startTour,
    toggleInfoBadges,
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
