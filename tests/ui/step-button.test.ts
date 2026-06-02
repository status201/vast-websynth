import { describe, it, expect, vi } from 'vitest';
import { StepButton } from '../../src/ui/components/step-button';

describe('StepButton', () => {
  it('toggles the on class only when the value changes', () => {
    const sb = new StepButton('C3');
    const toggle = vi.spyOn(sb.el.classList, 'toggle');

    sb.setOn(false);                       // already off → no-op
    expect(toggle).not.toHaveBeenCalled();
    expect(sb.on).toBe(false);

    sb.setOn(true);                        // changes → one write
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(sb.el.classList.contains(StepButton.onClass)).toBe(true);

    sb.setOn(true);                        // unchanged → no further write
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('toggles the playing class only when the value changes', () => {
    const sb = new StepButton('');
    const toggle = vi.spyOn(sb.el.classList, 'toggle');

    sb.setPlaying(false);                  // already false → no-op
    expect(toggle).not.toHaveBeenCalled();

    sb.setPlaying(true);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(sb.playing).toBe(true);

    sb.setPlaying(true);                   // unchanged → no further write
    expect(toggle).toHaveBeenCalledTimes(1);

    sb.setPlaying(false);                  // changes back → one write
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(sb.playing).toBe(false);
  });
});
