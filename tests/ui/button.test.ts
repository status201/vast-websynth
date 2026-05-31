import { describe, it, expect, vi } from 'vitest';
import { createButton, setButtonLabel } from '../../src/ui/components/button';
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
