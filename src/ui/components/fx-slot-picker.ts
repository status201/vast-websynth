import type { ParamBus } from '../../state/params';
import dropdownStyles from '../styles/dropdown.module.css';
import styles from '../styles/fx-slot-picker.module.css';
import { UI_ICONS } from './ui-icons';
import { anchorMenu, dismissMenu, menuClosed, menuOpened } from './menu-anchor';

/**
 * Two or more effects sharing one panel, chosen from a caret beside the title
 * (fx-slot-picker.md). The caller builds each effect's complete face; this
 * component owns which one shows, the caret and its menu.
 */
export interface FxSlotView {
  /** The effect's param prefix — `${prefix}.on` is its switch. */
  prefix: string;
  /** Its name in the menu. */
  title: string;
  /** The whole view; toggled `hidden` (REQ-the-slot-shows-one-effect-at-a-time). */
  el: HTMLElement;
  /** Where the caret goes while this view shows — right after its title. */
  caretHost: HTMLElement;
  /** The view's title — a click on it toggles the menu like the caret
   *  (REQ-the-title-opens-the-menu). */
  titleEl: HTMLElement;
}

const isOn = (bus: ParamBus, prefix: string): boolean => bus.get(`${prefix}.on`) >= 0.5;

/**
 * The view a load lands on (fx-slot-picker.md REQ-a-load-shows-the-running-effect):
 * the first non-primary effect that is on while the primary is off, otherwise
 * the primary.
 */
export function initialFxView(bus: ParamBus, views: ReadonlyArray<Pick<FxSlotView, 'prefix'>>): string {
  const primary = views[0]!.prefix;
  if (isOn(bus, primary)) return primary;
  return views.slice(1).find((v) => isOn(bus, v.prefix))?.prefix ?? primary;
}

export interface FxSlot {
  readonly current: string;
  show(prefix: string): void;
}

export function createFxSlot(bus: ParamBus, views: readonly FxSlotView[]): FxSlot {
  const primary = views[0]!.prefix;

  const root = document.createElement('div');
  root.className = `${dropdownStyles.root!} ${styles.root!} dropdown`;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = styles.caret!;
  toggle.dataset.testid = `fxpick-${primary}`;
  // Icon only (REQ-the-title-is-unchanged-plus-a-caret): the title beside it is the visible name.
  toggle.innerHTML = UI_ICONS.caretDown;
  toggle.title = `Choose the effect shown here: ${views.map((v) => v.title).join(' or ')}`;
  toggle.setAttribute('aria-label', 'Choose effect');
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  root.appendChild(toggle);

  const menu = document.createElement('div');
  menu.className = dropdownStyles.menu!;
  menu.setAttribute('role', 'menu');
  root.appendChild(menu);

  const items = new Map<string, HTMLButtonElement>();
  for (const v of views) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `${dropdownStyles.option!} ${styles.option!}`;
    b.dataset.testid = `fxpick-${primary}-${v.prefix}`;
    b.setAttribute('role', 'menuitem');
    const lamp = document.createElement('span');
    lamp.className = styles.lamp!;
    const text = document.createElement('span');
    text.textContent = v.title;
    b.append(lamp, text);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(false);
      show(v.prefix);
    });
    menu.appendChild(b);
    items.set(v.prefix, b);
  }

  let current = '';
  let open = false;

  function show(prefix: string): void {
    const target = views.find((v) => v.prefix === prefix) ?? views[0]!;
    current = target.prefix;
    for (const v of views) v.el.hidden = v !== target;
    // One caret, carried to whichever title is showing.
    target.caretHost.appendChild(root);
  }

  function setOpen(o: boolean): void {
    if (open === o) return;
    open = o;
    root.classList.toggle('open', o);
    toggle.setAttribute('aria-expanded', String(o));
    // One menu at a time (dropdown.md REQ-one-menu-is-open-at-a-time).
    if (!o) { menuClosed(root); return; }
    menuOpened(root, () => setOpen(false));
    // Read on open (REQ-the-menu-lists-every-effect-in-the-slot): a lane or a
    // load may have switched an effect since the last look.
    for (const [prefix, b] of items) {
      b.classList.toggle('active', prefix === current);
      b.classList.toggle('lit', isOn(bus, prefix));
    }
    // Wider than its icon-only caret, so sized by its entries
    // (dropdown.md REQ-every-fixed-menu-shares-one-anchor-and-dismiss).
    anchorMenu(toggle, menu, 'content');
  }

  // No stopPropagation on either trigger: `dismissMenu` counts the titles as
  // inside, so the click still reaches every OTHER open menu and closes it.
  const onToggle = (): void => setOpen(!open);
  toggle.addEventListener('click', onToggle);
  // The title is the bigger target, so it toggles too (REQ-the-title-opens-the-menu).
  // Only the shown view is visible, so only its title can be clicked. Not a
  // focus stop: the caret already is one.
  const titles = views.map((v) => v.titleEl);
  for (const t of titles) {
    t.classList.add(styles.title!);
    t.addEventListener('click', onToggle);
  }
  dismissMenu(root, () => open, () => setOpen(false), titles);

  show(initialFxView(bus, views));
  // Only a bulk apply that touched this slot's switches moves the view — a
  // synth preset never moves the sampler's slot, and a plain toggle never moves
  // either (REQ-a-load-shows-the-running-effect).
  const onIds = new Set(views.map((v) => `${v.prefix}.on`));
  bus.onBulkApply((ids) => {
    if (ids.some((id) => onIds.has(id))) show(initialFxView(bus, views));
  });

  return {
    get current() { return current; },
    show,
  };
}
