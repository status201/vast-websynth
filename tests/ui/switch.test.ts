import { describe, it, expect } from 'vitest';
import { Switch } from '../../src/ui/components/switch';
import { ParamBus, registerDefaults } from '../../src/state/params';
import styles from '../../src/ui/styles/switch.module.css';

function bus() {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

describe('Switch', () => {
  it('renders a root button with an LED + label and a stable testid', () => {
    const sw = new Switch(bus(), 'fx.delay.on', 'Delay');
    expect(sw.el.tagName).toBe('BUTTON');
    expect(sw.el.className).toBe(styles.root!);
    expect(sw.el.dataset.testid).toBe('switch-fx.delay.on');
    expect(sw.el.querySelector(`.${styles.led!}`)).not.toBeNull();
    expect(sw.el.querySelector(`.${styles.label!}`)?.textContent).toBe('Delay');
  });

  it('clicking toggles the bound param 0↔1', () => {
    const b = bus();
    const sw = new Switch(b, 'fx.delay.on', 'Delay');
    expect(b.get('fx.delay.on')).toBe(0);
    sw.el.click();
    expect(b.get('fx.delay.on')).toBe(1);
    sw.el.click();
    expect(b.get('fx.delay.on')).toBe(0);
  });

  it('reflects the param value with the global .on class', () => {
    const b = bus();
    const sw = new Switch(b, 'fx.delay.on', 'Delay');
    expect(sw.el.classList.contains('on')).toBe(false);
    b.set('fx.delay.on', 1);
    expect(sw.el.classList.contains('on')).toBe(true);
    b.set('fx.delay.on', 0);
    expect(sw.el.classList.contains('on')).toBe(false);
  });

  it('destroy unsubscribes from the bus', () => {
    const b = bus();
    const sw = new Switch(b, 'fx.delay.on', 'Delay');
    sw.destroy();
    b.set('fx.delay.on', 1);
    expect(sw.el.classList.contains('on')).toBe(false); // no longer tracking
  });
});
