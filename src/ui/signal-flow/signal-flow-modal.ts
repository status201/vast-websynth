/**
 * The signal-flow map's dialog (specs/features/signal-flow-map.md): picks the
 * poster for the theme, loads it, and hosts the map in a fullscreen Modal whose
 * Escape steps out of a zoom before it closes.
 *
 * Reached only through `open.ts`; this module, the manifest and the poster it
 * imports are never in the entry chunk (REQ-the-map-costs-nothing-until-opened).
 */
import manifest from '../../../docs/signal-flow-zones.json';
import styles from '../styles/signal-flow.module.css';
import { Modal } from '../components/modal';
import { loadSurface } from '../components/lazy-load-toast';
import { themeInfo } from '../../state/theme';
import { SignalFlowMap } from './signal-flow-map';
import type { ZoneManifest } from './zones';

const SURFACE = 'the signal-flow map';

/** The poster that suits the theme in force (REQ-the-poster-follows-the-theme-scheme). */
function loadPoster(): Promise<string> {
  const light = themeInfo(document.documentElement.dataset.theme ?? '').colorScheme === 'light';
  // Two literal imports, so the bundler splits each poster into its own chunk
  // and only the one asked for is downloaded.
  return light
    ? import('../../../docs/signal-flow-light.svg?raw').then((m) => m.default)
    : import('../../../docs/signal-flow-dark.svg?raw').then((m) => m.default);
}

/**
 * Load the poster and open the map, at `link`'s place when there is one
 * (REQ-a-help-topic-shows-its-place); on a failed download, report it
 * (lazy-load-failure.md REQ-every-lazy-trigger-reports) — `retry` re-runs the
 * whole gesture.
 */
export async function showSignalFlow(retry: () => void, link?: readonly string[]): Promise<void> {
  const svgText = await loadSurface(SURFACE, loadPoster, retry);
  if (svgText === null) return;
  const map = new SignalFlowMap({ svgText, manifest: manifest as ZoneManifest });
  // The ✕ means close, always (ADR-014 law 1); only Escape steps out first.
  let closeAsked = false;
  const modal = new Modal({
    title: 'Signal flow',
    cardClass: styles.card!,
    closeButton: true,
    closeTestId: 'signal-flow-close',
    // A near-fullscreen card: a stray press beside it must not close the map.
    dismissOnBackdrop: false,
    // Escape goes up a level first (REQ-escape-steps-out-before-it-closes).
    beforeClose: () => closeAsked || !map.stepOut(),
    onClose: () => map.dispose(),
  });
  modal.body.classList.add(styles.body!);
  modal.body.appendChild(map.root);
  if (link) map.show(link);
  modal.open();
  // Capture, so the flag is set before the Modal's own listener on the ✕ asks.
  modal.body.parentElement?.querySelector('[data-testid="signal-flow-close"]')
    ?.addEventListener('click', () => { closeAsked = true; }, { capture: true });
  map.root.querySelector<HTMLElement>('[data-testid="signal-flow-map"]')?.focus({ preventScroll: true });
}
