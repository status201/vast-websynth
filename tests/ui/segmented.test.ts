import { describe, it, expect } from 'vitest';
import { Segmented } from '../../src/ui/components/segmented';
import { ParamBus, registerDefaults, WAVE_LABELS } from '../../src/state/params';

function bus() {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

describe('Segmented', () => {
  it('renders one button per label with stable testids', () => {
    const seg = new Segmented(bus(), 'osc1.wave', WAVE_LABELS);
    expect(seg.el.dataset.testid).toBe('seg-osc1.wave');
    const buttons = seg.el.querySelectorAll('button');
    expect(buttons.length).toBe(WAVE_LABELS.length);
    expect((buttons[0] as HTMLButtonElement).dataset.testid).toBe('seg-osc1.wave-0');
    expect(buttons[2]?.textContent).toBe(WAVE_LABELS[2]);
  });

  it('marks the active option from the current param value', () => {
    const b = bus(); // osc1.wave default is 2
    const seg = new Segmented(b, 'osc1.wave', WAVE_LABELS);
    const buttons = seg.el.querySelectorAll('button');
    expect(buttons[2]?.classList.contains('active')).toBe(true);
    expect(buttons[0]?.classList.contains('active')).toBe(false);
  });

  it('clicking an option sets the param and moves the active marker', () => {
    const b = bus();
    const seg = new Segmented(b, 'osc1.wave', WAVE_LABELS);
    const buttons = seg.el.querySelectorAll('button');
    (buttons[0] as HTMLButtonElement).click();
    expect(b.get('osc1.wave')).toBe(0);
    expect(buttons[0]?.classList.contains('active')).toBe(true);
    expect(buttons[2]?.classList.contains('active')).toBe(false);
  });

  it('renders glyph icons when provided', () => {
    const icons = WAVE_LABELS.map((_, i) => `<svg data-i="${i}"></svg>`);
    const seg = new Segmented(bus(), 'osc1.wave', WAVE_LABELS, icons);
    const first = seg.el.querySelector('button')!;
    expect(first.querySelector('svg')).not.toBeNull();
    expect(first.getAttribute('aria-label')).toBe(WAVE_LABELS[0]);
  });
});
