// Onboarding facade: owns the tour + help-mode and the first-visit flag.
// Created once in app.ts and handed the runtime hooks the steps need.
import { Tour, type TourCtx } from './tour';
import { TOUR_STEPS } from './help-content';
import { HelpMode } from './help-mode';

const DONE_KEY = 'websynth.onboarding.done';

export interface Onboarding {
  /** Launch (or relaunch) the guided tour. */
  startTour(): void;
  /** Toggle the help-mode (i) badges. */
  toggleHelpMode(): void;
  /** True the first time only — used by main.ts to auto-launch. */
  shouldAutoLaunch(): boolean;
}

export function createOnboarding(ctx: TourCtx): Onboarding {
  const helpMode = new HelpMode();
  let tour: Tour | null = null;

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
    toggleHelpMode(): void {
      helpMode.toggle();
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
