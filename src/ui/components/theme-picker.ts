// The Theme row of the Settings dialog (specs/features/ui-themes.md
// REQ-choosing-a-theme-previews-it). One radio group of tiles — Auto, then each
// shipped theme — where a pick applies and stores at once; there is no Apply.
// Loaded with the dialog, so none of it costs the boot.
import { THEMES, resolveTheme, themeInfo, type ThemePref } from '../../state/theme';
import { currentThemePref, setThemePref } from '../theme';
import { onPaletteChange } from '../theme-colors';
import styles from '../styles/theme-picker.module.css';

interface Option {
  value: ThemePref;
  name: string;
}

export interface ThemePicker {
  el: HTMLElement;
  /** Stop following theme changes; for the dialog's close. */
  destroy(): void;
}

export function createThemePicker(): ThemePicker {
  const options: Option[] = [
    { value: 'auto', name: 'Auto' },
    ...THEMES.map((t) => ({ value: t.id, name: t.name })),
  ];
  let pref = currentThemePref();

  const el = document.createElement('div');

  const row = document.createElement('div');
  row.className = styles.row!;
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', 'Theme');
  row.dataset.testid = 'theme-picker';

  const tiles = options.map((opt) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = styles.tile!;
    tile.setAttribute('role', 'radio');
    tile.dataset.testid = `theme-${opt.value}`;
    const chips = document.createElement('span');
    chips.className = styles.chips!;
    chips.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 4; i++) {
      const chip = document.createElement('span');
      chip.className = styles.chip!;
      chips.appendChild(chip);
    }
    const name = document.createElement('span');
    name.className = styles.name!;
    name.textContent = opt.name;
    tile.append(chips, name);
    tile.addEventListener('click', () => choose(opt.value));
    row.appendChild(tile);
    return tile;
  });

  // Arrows, Home and End move the selection, as in any radio group; the keys
  // handled stop here so no arrow reaches the global shortcuts (input-control.md).
  row.addEventListener('keydown', (e) => {
    const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const n = tiles.length;
    let j: number;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowUp': j = (i - 1 + n) % n; break;
      case 'ArrowRight': case 'ArrowDown': j = (i + 1) % n; break;
      case 'Home': j = 0; break;
      case 'End': j = n - 1; break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    choose(options[j]!.value);
    tiles[j]!.focus();
  });

  const help = document.createElement('div');
  help.className = styles.help!;
  help.textContent = "Auto follows this device's light / dark and high-contrast settings.";

  const status = document.createElement('div');
  status.className = styles.status!;
  status.dataset.testid = 'theme-status';

  function choose(value: ThemePref): void {
    pref = value;
    setThemePref(value);
    render();
  }

  function render(): void {
    const resolved = resolveTheme(pref);
    tiles.forEach((tile, i) => {
      const value = options[i]!.value;
      const on = value === pref;
      tile.setAttribute('aria-checked', String(on));
      tile.classList.toggle('active', on);
      tile.tabIndex = on ? 0 : -1;
      // Auto shows the theme it currently lands on.
      const swatch = themeInfo(value === 'auto' ? resolved : value).swatch;
      tile.querySelectorAll<HTMLElement>(`.${styles.chip!}`).forEach((chip, k) => {
        chip.style.background = swatch[k]!;
      });
    });
    status.hidden = pref !== 'auto';
    status.textContent = '';
    if (pref === 'auto') {
      const strong = document.createElement('strong');
      strong.textContent = themeInfo(resolved).name;
      status.append('Auto picked ', strong, ' on this device.');
    }
  }

  el.append(row, help, status);
  render();
  // Under Auto the system can change while the dialog is open.
  const off = onPaletteChange(render);
  return { el, destroy: off };
}
