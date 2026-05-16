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
}

function readStored(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeStored(key: string, collapsed: boolean): void {
  try {
    localStorage.setItem(key, collapsed ? '1' : '0');
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export function createCollapseToggle(target: HTMLElement, storeKey: string): CollapseToggle {
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

  apply(readStored(storeKey));

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    set(!target.classList.contains('collapsed'));
  });

  return {
    el,
    expand(): void {
      if (target.classList.contains('collapsed')) set(false);
    },
  };
}
