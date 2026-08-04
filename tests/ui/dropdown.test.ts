import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Dropdown } from '../../src/ui/components/dropdown';
import styles from '../../src/ui/styles/dropdown.module.css';

describe('Dropdown', () => {
  let dd: Dropdown | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    // Drop the document-level listeners so instances don't leak across tests.
    dd?.destroy();
    dd = undefined;
  });

  const toggleOf = (d: Dropdown) =>
    d.el.querySelector<HTMLButtonElement>(`.${styles.toggle!}`)!;

  it('renders a toggle and one option per entry, marking the active one', () => {
    dd = new Dropdown(['A', 'B', 'C'], 'B');
    document.body.appendChild(dd.el);
    expect(dd.el.classList.contains(styles.root!)).toBe(true);
    expect(dd.el.querySelectorAll(`.${styles.option!}`).length).toBe(3);
    expect(dd.value).toBe('B');
    expect(dd.el.querySelector(`.${styles.label!}`)?.textContent).toBe('B');
    expect(dd.el.querySelector(`.${styles.option!}.active`)?.textContent).toBe('B');
  });

  it('toggles the open class when the toggle is clicked', () => {
    dd = new Dropdown(['A', 'B']);
    document.body.appendChild(dd.el);
    toggleOf(dd).click();
    expect(dd.el.classList.contains('open')).toBe(true);
    toggleOf(dd).click();
    expect(dd.el.classList.contains('open')).toBe(false);
  });

  it('selecting an option sets the value, closes, and invokes onChange', () => {
    dd = new Dropdown(['A', 'B', 'C'], 'A');
    document.body.appendChild(dd.el);
    const cb = vi.fn();
    dd.onChange(cb);
    toggleOf(dd).click();
    const optB = [
      ...dd.el.querySelectorAll<HTMLButtonElement>(`.${styles.option!}`),
    ].find((b) => b.textContent === 'B')!;
    optB.click();
    expect(dd.value).toBe('B');
    expect(dd.el.classList.contains('open')).toBe(false);
    expect(cb).toHaveBeenCalledWith('B');
  });

  it('setValue updates the toggle label and active classes', () => {
    dd = new Dropdown(['A', 'B'], 'A');
    dd.setValue('B');
    expect(dd.el.querySelector(`.${styles.label!}`)?.textContent).toBe('B');
    expect(dd.el.querySelector(`.${styles.option!}.active`)?.textContent).toBe('B');
  });

  // REQ-9. The class MUST land on the toggle: on the root, `opacity` composites
  // the fixed-position menu with it (transparent options) and opens a stacking
  // context that buries the menu under later siblings. jsdom can't see the real
  // CSS, but it can prove the class never reaches the root — which is the bug.
  describe('dimmed state (REQ-9)', () => {
    it('marks the toggle and leaves the root untouched', () => {
      dd = new Dropdown(['A', 'B'], 'A');
      document.body.appendChild(dd.el);
      const rootClasses = dd.el.className;

      dd.setDimmed(true);
      expect(toggleOf(dd).classList.contains(styles.dimmed!)).toBe(true);
      expect(dd.el.className).toBe(rootClasses);
      expect(dd.el.classList.contains(styles.dimmed!)).toBe(false);

      dd.setDimmed(false);
      expect(toggleOf(dd).classList.contains(styles.dimmed!)).toBe(false);
      expect(dd.el.className).toBe(rootClasses);
    });

    it('stays fully operable while dimmed — it is presentation only', () => {
      dd = new Dropdown(['A', 'B', 'C'], 'A');
      document.body.appendChild(dd.el);
      const cb = vi.fn();
      dd.onChange(cb);
      dd.setDimmed(true);

      toggleOf(dd).click();
      expect(dd.el.classList.contains('open')).toBe(true);
      const optC = [
        ...dd.el.querySelectorAll<HTMLButtonElement>(`.${styles.option!}`),
      ].find((b) => b.textContent === 'C')!;
      optC.click();

      expect(dd.value).toBe('C');
      expect(cb).toHaveBeenCalledWith('C');
      // …and the dim survives the interaction — it tracks the value's origin,
      // which selecting an option is the consumer's job to re-evaluate.
      expect(toggleOf(dd).classList.contains(styles.dimmed!)).toBe(true);
    });
  });

  it('focuses the active option on open, and the first option without one', () => {
    dd = new Dropdown(['A', 'B', 'C'], 'B');
    document.body.appendChild(dd.el);
    toggleOf(dd).click();
    expect(document.activeElement?.textContent).toBe('B');
    expect(document.activeElement?.classList.contains('active')).toBe(true);
  });

  it('returns focus to the toggle when the menu closes', () => {
    dd = new Dropdown(['A', 'B'], 'A');
    document.body.appendChild(dd.el);
    toggleOf(dd).click(); // open → focus moves to the active option
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.activeElement).toBe(toggleOf(dd));
  });

  it('closes on outside click and on Escape', () => {
    dd = new Dropdown(['A', 'B']);
    document.body.appendChild(dd.el);

    toggleOf(dd).click();
    expect(dd.el.classList.contains('open')).toBe(true);
    document.body.click(); // outside the dropdown
    expect(dd.el.classList.contains('open')).toBe(false);

    toggleOf(dd).click();
    expect(dd.el.classList.contains('open')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dd.el.classList.contains('open')).toBe(false);
  });

  it('destroy removes the document listeners', () => {
    dd = new Dropdown(['A', 'B']);
    document.body.appendChild(dd.el);
    toggleOf(dd).click(); // open
    dd.destroy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    // listener gone → still open (state unchanged since destroy)
    expect(dd.el.classList.contains('open')).toBe(true);
  });

  // --- Live filter (dropdown.md REQ-7) ---
  describe('live filter', () => {
    /** `n` distinct labels; index 3.. are `opt-<i>` so `cut` matches nothing
     *  unless a test asks for it. */
    const many = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `opt-${i}`);

    const filterOf = (d: Dropdown) =>
      d.el.querySelector<HTMLInputElement>('[data-testid="dropdown-filter"]');
    const options = (d: Dropdown) =>
      [...d.el.querySelectorAll<HTMLButtonElement>(`.${styles.option!}`)];
    const visible = (d: Dropdown) => options(d).filter((o) => !o.hidden);
    const type = (d: Dropdown, q: string): void => {
      const input = filterOf(d)!;
      input.value = q;
      input.dispatchEvent(new Event('input'));
    };

    it('appears at the threshold and not below it', () => {
      dd = new Dropdown(many(29));
      expect(filterOf(dd)).toBeNull();
      dd.destroy();

      dd = new Dropdown(many(30));
      expect(filterOf(dd)).not.toBeNull();
    });

    it('honours an explicit filter flag in both directions', () => {
      dd = new Dropdown(['A', 'B'], 'A', { filter: true });
      expect(filterOf(dd)).not.toBeNull();
      dd.destroy();

      dd = new Dropdown(many(50), undefined, { filter: false });
      expect(filterOf(dd)).toBeNull();
    });

    it('holds no button, so the toggle stays the first button', () => {
      dd = new Dropdown(many(30));
      document.body.appendChild(dd.el);
      expect(dd.el.querySelector('button')).toBe(toggleOf(dd));
    });

    it('narrows the visible options as you type, case-insensitively', () => {
      dd = new Dropdown(['filter.cutoff', 'FX.WAH.CUTOFF', 'lfo.rate'], 'lfo.rate', {
        filter: true,
      });
      document.body.appendChild(dd.el);
      toggleOf(dd).click();
      type(dd, 'CUT');
      expect(visible(dd).map((o) => o.textContent)).toEqual([
        'filter.cutoff',
        'FX.WAH.CUTOFF',
      ]);
      // Every option is still in the DOM — filtering hides, it doesn't rebuild.
      expect(options(dd).length).toBe(3);
    });

    it('Enter selects the first visible match and closes', () => {
      dd = new Dropdown(['filter.cutoff', 'fx.delay.mix', 'lfo.rate'], 'lfo.rate', {
        filter: true,
      });
      document.body.appendChild(dd.el);
      const cb = vi.fn();
      dd.onChange(cb);
      toggleOf(dd).click();
      type(dd, 'delay');
      filterOf(dd)!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      expect(dd.value).toBe('fx.delay.mix');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(dd.el.classList.contains('open')).toBe(false);
    });

    it('ArrowDown moves focus from the field to the first match', () => {
      dd = new Dropdown(['a.one', 'b.two'], 'a.one', { filter: true });
      document.body.appendChild(dd.el);
      toggleOf(dd).click();
      type(dd, 'two');
      filterOf(dd)!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
      expect(document.activeElement?.textContent).toBe('b.two');
    });

    it('shows a single "No match" line when nothing matches', () => {
      dd = new Dropdown(['a.one', 'b.two'], 'a.one', { filter: true });
      document.body.appendChild(dd.el);
      toggleOf(dd).click();
      const empty = dd.el.querySelector<HTMLElement>(`.${styles.empty!}`)!;
      expect(empty.hidden).toBe(true);
      type(dd, 'zzz');
      expect(visible(dd)).toHaveLength(0);
      expect(empty.hidden).toBe(false);
      type(dd, 'one');
      expect(empty.hidden).toBe(true);
    });

    it('focuses the filter on open and still scrolls to the selection', () => {
      dd = new Dropdown(['a.one', 'b.two'], 'b.two', { filter: true });
      document.body.appendChild(dd.el);
      const active = options(dd).find((o) => o.textContent === 'b.two')!;
      const spy = vi.fn();
      // jsdom has no scrollIntoView; the component optional-calls it.
      (active as unknown as { scrollIntoView: unknown }).scrollIntoView = spy;
      toggleOf(dd).click();
      expect(document.activeElement).toBe(filterOf(dd));
      expect(spy).toHaveBeenCalled();
    });

    it('reopening clears the query and shows everything again', () => {
      dd = new Dropdown(['a.one', 'b.two'], 'a.one', { filter: true });
      document.body.appendChild(dd.el);
      toggleOf(dd).click();
      type(dd, 'two');
      expect(visible(dd)).toHaveLength(1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      toggleOf(dd).click();
      expect(filterOf(dd)!.value).toBe('');
      expect(visible(dd)).toHaveLength(2);
    });

    it('setOptions across the threshold adds/removes the row and keeps working', () => {
      dd = new Dropdown(many(30));
      document.body.appendChild(dd.el);
      expect(filterOf(dd)).not.toBeNull();

      dd.setOptions(['A', 'B', 'C']);
      expect(filterOf(dd)).toBeNull();
      expect(options(dd).length).toBe(3);
      expect(dd.value).toBe('A'); // fell back, the old value is gone

      dd.setOptions(many(35));
      const input = filterOf(dd);
      expect(input).not.toBeNull();
      expect(options(dd).length).toBe(35);
      // The rebuilt input must be the live node, not a detached leftover.
      expect(dd.el.contains(input!)).toBe(true);
      toggleOf(dd).click();
      type(dd, 'opt-1');
      // opt-1 and opt-10..opt-19
      expect(visible(dd)).toHaveLength(11);
    });

    it('setValue still marks the active option with a filter present', () => {
      dd = new Dropdown(many(30), 'opt-0');
      dd.setValue('opt-7');
      expect(dd.el.querySelector(`.${styles.option!}.active`)?.textContent).toBe('opt-7');
      expect(dd.el.querySelector(`.${styles.label!}`)?.textContent).toBe('opt-7');
    });
  });

  // --- Arrow-key navigation (dropdown.md REQ-8) ---
  describe('arrow-key navigation', () => {
    const focused = (): string | null | undefined => document.activeElement?.textContent;
    /** Bubbles from wherever focus is, like a real keypress, so the component's
     *  document-level handler sees it. Returns false when preventDefault ran. */
    const arrow = (key: string): boolean =>
      (document.activeElement ?? document).dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );

    it('moves one option per press, in both directions', () => {
      dd = new Dropdown(['A', 'B', 'C', 'D'], 'B');
      document.body.appendChild(dd.el);
      toggleOf(dd).click(); // opens focused on the active option, B
      expect(focused()).toBe('B');

      // The bug this pins: the second press used to only scroll the menu.
      arrow('ArrowDown');
      expect(focused()).toBe('C');
      arrow('ArrowDown');
      expect(focused()).toBe('D');
      arrow('ArrowUp');
      expect(focused()).toBe('C');
    });

    it('Home and End jump to the ends', () => {
      dd = new Dropdown(['A', 'B', 'C', 'D'], 'B');
      document.body.appendChild(dd.el);
      toggleOf(dd).click();
      arrow('End');
      expect(focused()).toBe('D');
      arrow('Home');
      expect(focused()).toBe('A');
    });

    it('wraps at both ends when there is no filter field', () => {
      dd = new Dropdown(['A', 'B', 'C'], 'C');
      document.body.appendChild(dd.el);
      toggleOf(dd).click(); // on C, the last
      arrow('ArrowDown');
      expect(focused()).toBe('A');
      arrow('ArrowUp');
      expect(focused()).toBe('C');
    });

    it('preventDefaults so the menu cannot scroll out from under the focus move', () => {
      dd = new Dropdown(['A', 'B', 'C'], 'A');
      document.body.appendChild(dd.el);
      toggleOf(dd).click();
      expect(arrow('ArrowDown')).toBe(false);
      expect(arrow('Home')).toBe(false);
    });

    it('stops Home from reaching the global shortcuts (regression)', () => {
      // installShortcuts listens on window and seeks the transport on Home
      // (transport-position.md REQ-11) — an open dropdown must not move the
      // playhead just because the user is walking a list.
      const onWindow = vi.fn();
      window.addEventListener('keydown', onWindow);
      try {
        dd = new Dropdown(['A', 'B', 'C'], 'B');
        document.body.appendChild(dd.el);
        toggleOf(dd).click();
        arrow('Home');
        expect(onWindow).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('keydown', onWindow);
      }
    });

    it('does nothing while the menu is closed', () => {
      const onWindow = vi.fn();
      window.addEventListener('keydown', onWindow);
      try {
        dd = new Dropdown(['A', 'B', 'C'], 'B');
        document.body.appendChild(dd.el);
        document.body.focus();
        arrow('ArrowDown');
        // Not swallowed: a closed dropdown's listener is inert, so the octave
        // shift and friends still work.
        expect(onWindow).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener('keydown', onWindow);
      }
    });

    describe('with a filter field', () => {
      const filterOf = (d: Dropdown) =>
        d.el.querySelector<HTMLInputElement>('[data-testid="dropdown-filter"]')!;
      const type = (d: Dropdown, q: string): void => {
        const input = filterOf(d);
        input.value = q;
        input.dispatchEvent(new Event('input'));
      };

      it('enters the list from the end the arrow points at', () => {
        dd = new Dropdown(['A', 'B', 'C'], 'A', { filter: true });
        document.body.appendChild(dd.el);
        toggleOf(dd).click(); // focus starts in the field
        expect(document.activeElement).toBe(filterOf(dd));
        arrow('ArrowDown');
        expect(focused()).toBe('A');

        filterOf(dd).focus();
        arrow('ArrowUp');
        expect(focused()).toBe('C');
      });

      it('skips options the filter hid', () => {
        dd = new Dropdown(['a.one', 'b.two', 'a.three'], 'a.one', { filter: true });
        document.body.appendChild(dd.el);
        toggleOf(dd).click();
        type(dd, 'a.'); // leaves a.one and a.three; b.two is hidden
        arrow('ArrowDown');
        expect(focused()).toBe('a.one');
        arrow('ArrowDown');
        expect(focused()).toBe('a.three'); // never lands on the hidden b.two
      });

      it('returns to the field past either end instead of wrapping', () => {
        dd = new Dropdown(['A', 'B'], 'A', { filter: true });
        document.body.appendChild(dd.el);
        toggleOf(dd).click();
        arrow('ArrowDown'); // A
        arrow('ArrowDown'); // B, the last
        expect(focused()).toBe('B');
        arrow('ArrowDown');
        expect(document.activeElement).toBe(filterOf(dd));

        // And symmetrically off the top.
        arrow('ArrowDown'); // back to A
        expect(focused()).toBe('A');
        arrow('ArrowUp');
        expect(document.activeElement).toBe(filterOf(dd));
      });

      it('Enter still takes the first match from the field', () => {
        dd = new Dropdown(['a.one', 'b.two'], 'a.one', { filter: true });
        document.body.appendChild(dd.el);
        const cb = vi.fn();
        dd.onChange(cb);
        toggleOf(dd).click();
        type(dd, 'two');
        filterOf(dd).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
        expect(dd.value).toBe('b.two');
        expect(cb).toHaveBeenCalledTimes(1);
      });
    });
  });
});
