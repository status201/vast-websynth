import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ParamDropdown } from '../../src/ui/components/param-dropdown';
import { ParamBus, registerDefaults, LFO_DEST_LABELS } from '../../src/state/params';
import styles from '../../src/ui/styles/dropdown.module.css';

/** Open the Dropdown at (or inside) `el` if it is not open: option buttons are
 *  built on open (dropdown.md REQ-options-are-built-when-the-menu-opens). */
function openDd<T extends HTMLElement>(el: T): T {
  const dd = el.classList.contains('dropdown') ? el : el.querySelector<HTMLElement>('.dropdown');
  if (dd && !dd.classList.contains('open')) dd.querySelector<HTMLButtonElement>('button')!.click();
  return el;
}

function bus() {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

describe('ParamDropdown', () => {
  let pd: ParamDropdown | undefined;
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { pd?.destroy(); pd = undefined; });

  const options = (p: ParamDropdown) =>
    [...openDd(p.el).querySelectorAll<HTMLButtonElement>(`.${styles.option!}`)];
  const label = (p: ParamDropdown) =>
    p.el.querySelector(`.${styles.label!}`)?.textContent;

  it('shows the label for the current param value', () => {
    const b = bus(); // lfo.dest default 0 → 'off'
    pd = new ParamDropdown(b, 'lfo.dest', LFO_DEST_LABELS);
    document.body.appendChild(pd.el);
    expect(label(pd)).toBe(LFO_DEST_LABELS[0]);
    expect(options(pd).length).toBe(LFO_DEST_LABELS.length);
  });

  it('selecting an option sets the param to its index', () => {
    const b = bus();
    pd = new ParamDropdown(b, 'lfo.dest', LFO_DEST_LABELS);
    document.body.appendChild(pd.el);
    const pitch = options(pd).find((o) => o.textContent === 'pitch')!; // index 2
    pitch.click();
    expect(b.get('lfo.dest')).toBe(2);
  });

  it('reflects external param changes in the label', () => {
    const b = bus();
    pd = new ParamDropdown(b, 'lfo.dest', LFO_DEST_LABELS);
    document.body.appendChild(pd.el);
    b.set('lfo.dest', 3); // 'amp'
    expect(label(pd)).toBe(LFO_DEST_LABELS[3]);
  });
});
