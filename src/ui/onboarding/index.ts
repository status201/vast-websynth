// Onboarding facade: owns the tour + the info badges and the first-visit flag.
// Created once in app.ts and handed the runtime hooks the steps need.
import { Tour, type TourCtx } from './tour';
import { TOUR_STEPS } from './help-content';
import { InfoBadges } from './info-badges';

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
  const badges = new InfoBadges(ctx.bus);
  let tour: Tour | null = null;
  const badgeListeners: Array<(active: boolean) => void> = [];

  const markDone = (): void => {
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      /* private mode / quota — non-fatal */
    }
  };

  return {
    startTour(): void {
      if (tour) return; // already running
      tour = new Tour(TOUR_STEPS, ctx, () => {
        markDone();
        tour = null;
      });
      tour.start();
    },
    toggleInfoBadges(): void {
      badges.toggle();
      for (const l of badgeListeners) l(badges.isActive);
    },
    isInfoBadgesActive(): boolean {
      return badges.isActive;
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
