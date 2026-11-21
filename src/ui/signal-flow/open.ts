/**
 * The one way into the signal-flow map (signal-flow-map.md), shared by its two
 * doors: the About card, and a help topic's "Show in the signal flow".
 *
 * Deliberately tiny — it is all a door costs until it is clicked
 * (REQ-the-map-costs-nothing-until-opened). A chunk that will not load is
 * reported (lazy-load-failure.md REQ-every-lazy-trigger-reports), and Retry
 * re-runs the whole gesture, link included.
 */
import { loadSurface } from '../components/lazy-load-toast';

/** The open in progress: on a slow link, a second click must not stack a second map. */
let pending: Promise<void> | null = null;

/** Open the map — on the overview, or at a deep link's place (zone / spot ids). */
export function openSignalFlow(link?: readonly string[]): Promise<void> {
  if (pending) return pending;
  const retry = (): void => void openSignalFlow(link);
  pending = (async () => {
    const m = await loadSurface('the signal-flow map', () => import('./signal-flow-modal'), retry);
    await m?.showSignalFlow(retry, link);
  })().finally(() => {
    pending = null;
  });
  return pending;
}
