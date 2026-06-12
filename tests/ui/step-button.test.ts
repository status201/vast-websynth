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

  it('renders the label in a span so viz layers survive setLabel', () => {
    const sb = new StepButton('C3');
    expect(sb.el.textContent).toBe('C3');
    sb.setLabel('D#4');
    expect(sb.el.textContent).toBe('D#4');
  });

  it('setViz lazily creates one fill layer and sets the custom props', () => {
    const sb = new StepButton('C3');
    expect(sb.el.querySelector(`.${StepButton.fillClass}`)).toBeNull();

    sb.setViz({ velocity: 0.8, gate: 0.5, prob: 1, ratchet: 1, tie: false });
    const fill = sb.el.querySelector(`.${StepButton.fillClass}`);
    expect(fill).not.toBeNull();
    expect(sb.el.style.getPropertyValue('--sb-gate')).toBe('0.5');
    expect(sb.el.style.getPropertyValue('--sb-vel')).toBe('0.8');
    expect(sb.el.style.getPropertyValue('--sb-ratchet')).toBe('1');

    sb.setViz({ velocity: 0.3, gate: 0.9, prob: 1, ratchet: 1, tie: false });
    expect(sb.el.querySelectorAll(`.${StepButton.fillClass}`).length).toBe(1); // still one layer
    expect(sb.el.style.getPropertyValue('--sb-gate')).toBe('0.9');
    expect(sb.el.style.getPropertyValue('--sb-vel')).toBe('0.3');
  });

  it('setViz toggles the tie / prob / ratchet classes on their thresholds', () => {
    const sb = new StepButton('C3');
    sb.setViz({ velocity: 0.8, gate: 0.5, prob: 1, ratchet: 1, tie: false });
    expect(sb.el.classList.contains(StepButton.tieClass)).toBe(false);
    expect(sb.el.classList.contains(StepButton.probClass)).toBe(false);
    expect(sb.el.classList.contains(StepButton.ratchetClass)).toBe(false);

    sb.setViz({ velocity: 0.8, gate: 0.5, prob: 0.5, ratchet: 3, tie: true });
    expect(sb.el.classList.contains(StepButton.tieClass)).toBe(true);
    expect(sb.el.classList.contains(StepButton.probClass)).toBe(true);
    expect(sb.el.classList.contains(StepButton.ratchetClass)).toBe(true);
    expect(sb.el.style.getPropertyValue('--sb-ratchet')).toBe('3');

    sb.setViz({ velocity: 0.8, gate: 0.5, prob: 1, ratchet: 1, tie: false });
    expect(sb.el.classList.contains(StepButton.tieClass)).toBe(false);
    expect(sb.el.classList.contains(StepButton.probClass)).toBe(false);
    expect(sb.el.classList.contains(StepButton.ratchetClass)).toBe(false);
  });

  it('repeated setViz with identical values writes no styles', () => {
    const sb = new StepButton('C3');
    const viz = { velocity: 0.8, gate: 0.5, prob: 0.7, ratchet: 2, tie: true };
    sb.setViz(viz);

    const setProp = vi.spyOn(sb.el.style, 'setProperty');
    const toggle = vi.spyOn(sb.el.classList, 'toggle');
    sb.setViz({ ...viz });
    expect(setProp).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('never grows a fill layer when setViz is not used (drum/sampler usage)', () => {
    const sb = new StepButton('', 'red');
    sb.setOn(true);
    sb.setPlaying(true);
    sb.setLabel('x');
    expect(sb.el.querySelector(`.${StepButton.fillClass}`)).toBeNull();
    expect(sb.el.children.length).toBe(1); // just the label span
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
