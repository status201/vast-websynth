import type { StudioApi } from '../studio-api';
import { restIcon } from './rest-glyph';
import styles from '../styles/rest-overlay.module.css';

export type RestLane = 'seq' | 'drum' | 'sampler' | 'motion';

export interface RestOverlay {
  /** Absolutely-positioned element — place it inside a `position: relative` grid wrapper. */
  readonly el: HTMLElement;
  /** Re-read the lane's resting state and show/hide the overlay. */
  refresh(): void;
}

/**
 * A machine-tab overlay that dims the step grid and shows a large centered rest
 * glyph while its arrangement lane is playing a rest bar (arrangement-rest.md
 * REQ-6). Purely visual and `pointer-events: none`, so the grid underneath stays
 * clickable. Subscribes to `arrangement.onChange`; the caller may also drive
 * `refresh()` from the machine's `onStep` for prompt updates on bar boundaries.
 */
export function buildRestOverlay(api: StudioApi, lane: RestLane): RestOverlay {
  const el = document.createElement('div');
  el.className = styles.overlay!;
  el.dataset.testid = `rest-overlay-${lane}`;
  el.setAttribute('aria-hidden', 'true');

  const glyph = document.createElement('div');
  glyph.className = styles.glyph!;
  glyph.innerHTML = restIcon();
  el.appendChild(glyph);

  const caption = document.createElement('div');
  caption.className = styles.caption!;
  caption.textContent = 'rest';
  el.appendChild(caption);

  const isResting = (): boolean =>
    lane === 'seq' ? api.arrangement.seqResting
      : lane === 'drum' ? api.arrangement.drumResting
        : lane === 'sampler' ? api.arrangement.samplerResting
          : api.arrangement.motionResting;

  const refresh = (): void => {
    el.classList.toggle(styles.on!, isResting() && api.arrangement[lane].enabled);
  };

  api.arrangement.onChange(refresh);
  refresh();
  return { el, refresh };
}
