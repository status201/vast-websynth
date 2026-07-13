import { describe, it, expect, vi } from 'vitest';
import { createButton, setButtonLabel, setButtonIcon } from '../../src/ui/components/button';
import { HEADER_ICONS } from '../../src/ui/components/header-icons';
import styles from '../../src/ui/styles/switch.module.css';

describe('createButton', () => {
  it('defaults to a switch-styled button of type button', () => {
    const b = createButton({ label: 'Hi' });
    expect(b.tagName).toBe('BUTTON');
    expect(b.type).toBe('button');
    expect(b.className).toBe(styles.root!);
    expect(b.textContent).toBe('Hi');
  });

  it('honours custom className and type', () => {
    const b = createButton({
      label: 'Go',
      className: 'switch about-close',
      type: 'submit',
    });
    expect(b.className).toBe('switch about-close');
    expect(b.type).toBe('submit');
  });

  it('builds an LED + label structure when led:true', () => {
    const b = createButton({ label: 'Play', led: true });
    expect(b.querySelector(`.${styles.led!}`)).not.toBeNull();
    expect(b.querySelector(`.${styles.label!}`)?.textContent).toBe('Play');
  });

  it('wires the onClick handler', () => {
    const onClick = vi.fn();
    const b = createButton({ label: 'Tap', onClick });
    b.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders an icon instead of text, with the label as aria-label', () => {
    const b = createButton({ label: 'Save preset', icon: HEADER_ICONS.save, title: 'Save preset' });
    expect(b.querySelector('svg.hdr-icon')).not.toBeNull();
    expect(b.textContent).toBe(''); // no visible text label
    expect(b.getAttribute('aria-label')).toBe('Save preset');
    expect(b.title).toBe('Save preset');
  });

  it('lets ariaLabel override the label, and sets title without an icon', () => {
    const b = createButton({ label: 'X', icon: HEADER_ICONS.help, ariaLabel: 'Help' });
    expect(b.getAttribute('aria-label')).toBe('Help');
    const plain = createButton({ label: 'Plain', title: 'A tooltip' });
    expect(plain.title).toBe('A tooltip');
    expect(plain.getAttribute('aria-label')).toBeNull();
  });
});

describe('setButtonIcon', () => {
  it('swaps the SVG markup', () => {
    const b = createButton({ label: 'Toggle fullscreen', icon: HEADER_ICONS.expand });
    const before = b.innerHTML;
    setButtonIcon(b, HEADER_ICONS.compress);
    expect(b.innerHTML).not.toBe(before);
    expect(b.querySelector('svg.hdr-icon')).not.toBeNull();
  });
});

describe('setButtonLabel', () => {
  it('updates the .switch-label span for an LED button', () => {
    const b = createButton({ label: 'Play', led: true });
    setButtonLabel(b, 'Stop');
    expect(b.querySelector(`.${styles.label!}`)?.textContent).toBe('Stop');
  });

  it('updates textContent for a plain button', () => {
    const b = createButton({ label: 'Save' });
    setButtonLabel(b, 'Saved');
    expect(b.textContent).toBe('Saved');
  });
});
