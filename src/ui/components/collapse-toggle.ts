import tabStyles from '../styles/tabs.module.css';
import { UI_ICONS } from './ui-icons';

/**
 * Reusable fold/unfold chevron. Toggles a `.collapsed` class on `target`
 * (CSS does the actual hiding + caret rotation) and persists the state to
 * `localStorage` under `storeKey` (same `websynth.*` convention as
 * `state/preset.ts` / `state/song.ts`). `expand()` lets callers force the
 * panel open (e.g. clicking a tab while the tab strip is collapsed).
 */
export interface CollapseToggle {
  readonly el: HTMLButtonElement;
  expand(): void;
  toggle(): void;
}

export interface CollapseToggleOptions {
  /**
   * Initial collapsed state used only when the user has no stored preference
   * yet (e.g. auto-collapse on small screens). An explicit prior choice — set
   * by clicking the chevron or expanding via a tab — always wins and is never
   * overwritten by this default.
   */
  defaultCollapsed?: () => boolean;
  /**
   * Extra element whose clicks also toggle collapse, so the whole bar is a
   * hit target (not just the small chevron). Clicks whose target matches
   * `ignoreSelector` are left alone — used for the tab strip so clicking a
   * tab keeps its own expand-and-activate behaviour and never collapses.
   */
  trigger?: HTMLElement;
  ignoreSelector?: string;
  /**
   * Fires whenever the collapsed state is written — the chevron, the `trigger`
   * click and `expand()` all funnel through it, so a listener sees every fold.
   * Also fires once during creation with the initial (stored or default) state.
   */
  onChange?(collapsed: boolean): void;
}

/**
 * Raw stored choice, or null when the user has never toggled this panel.
 *
 * Exported because `lane-fold.ts` stores its folds under the same
 * `websynth.ui.collapsed.*` convention, and a second copy of the try/catch is a
 * second place for private-mode behaviour to drift.
 */
export function readStoredCollapse(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

export function writeStoredCollapse(key: string, collapsed: boolean): void {
  try {
    localStorage.setItem(key, collapsed ? '1' : '0');
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export function createCollapseToggle(
  target: HTMLElement,
  storeKey: string,
  opts?: CollapseToggleOptions,
): CollapseToggle {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = tabStyles.collapse!;
  el.innerHTML = UI_ICONS.caretDown; // the same caret the dropdown draws
  el.setAttribute('aria-label', 'Collapse panel');

  const apply = (collapsed: boolean): void => {
    target.classList.toggle('collapsed', collapsed);
    el.setAttribute('aria-expanded', String(!collapsed));
    opts?.onChange?.(collapsed);
  };

  const set = (collapsed: boolean): void => {
    apply(collapsed);
    writeStoredCollapse(storeKey, collapsed);
  };

  const stored = readStoredCollapse(storeKey);
  apply(stored ?? opts?.defaultCollapsed?.() ?? false);

  const toggle = (): void => set(!target.classList.contains('collapsed'));

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });

  if (opts?.trigger) {
    const ignore = opts.ignoreSelector;
    opts.trigger.addEventListener('click', (e) => {
      if (ignore && (e.target as Element | null)?.closest(ignore)) return;
      toggle();
    });
  }

  return {
    el,
    expand(): void {
      if (target.classList.contains('collapsed')) set(false);
    },
    toggle,
  };
}
