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
}

/** Raw stored choice, or null when the user has never toggled this panel. */
function readStored(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

function writeStored(key: string, collapsed: boolean): void {
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
  el.className = 'collapse-toggle';
  el.textContent = '▾'; // ▾ — matches dropdown caret glyph
  el.setAttribute('aria-label', 'Collapse panel');

  const apply = (collapsed: boolean): void => {
    target.classList.toggle('collapsed', collapsed);
    el.setAttribute('aria-expanded', String(!collapsed));
  };

  const set = (collapsed: boolean): void => {
    apply(collapsed);
    writeStored(storeKey, collapsed);
  };

  const stored = readStored(storeKey);
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
