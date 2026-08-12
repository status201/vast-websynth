// The onboarding body: the tour, the info badges, and (transitively) the ~54 kB
// of help copy both read. Everything here is reachable only through `index.ts`'s
// `import()`, so this module is the boundary of the lazy chunk — a static import
// of it from anywhere else would put all of it back on the boot path
// (runtime-performance.md REQ-1).
//
// The facade owns the parts that must answer synchronously (the first-visit flag,
// the badge listeners); this owns the parts that need the code. `onBadgeChange`
// and `markDone` are injected rather than imported so the split costs the facade
// no knowledge of what the body does with them.
import { Tour, type TourCtx } from './tour';
import { TOUR_STEPS } from './help-content';
import { InfoBadges } from './info-badges';

export interface OnboardingImpl {
  startTour(): void;
  toggleInfoBadges(): void;
}

export function createOnboardingImpl(
  ctx: TourCtx,
  onBadgeChange: (active: boolean) => void,
  markDone: () => void,
): OnboardingImpl {
  const badges = new InfoBadges(ctx.bus);
  let tour: Tour | null = null;

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
      onBadgeChange(badges.isActive);
    },
  };
}
