/**
 * Shared button factory. Every button in the app is a `.switch`-styled
 * `<button>`; some (the transport Play button) carry an LED dot + a label
 * span so the `.on` state can glow. One helper keeps that markup in one
 * place instead of being hand-rolled at each call site.
 */
export interface ButtonOptions {
  label: string;
  /** CSS class(es). Defaults to the shared `switch` style. */
  className?: string;
  type?: 'button' | 'submit';
  onClick?: (ev: MouseEvent) => void;
  /** Render `<span.switch-led>` + `<span.switch-label>` (e.g. Play/Stop). */
  led?: boolean;
}

export function createButton(opts: ButtonOptions): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = opts.type ?? 'button';
  btn.className = opts.className ?? 'switch';

  if (opts.led) {
    const led = document.createElement('span');
    led.className = 'switch-led';
    const label = document.createElement('span');
    label.className = 'switch-label';
    label.textContent = opts.label;
    btn.appendChild(led);
    btn.appendChild(label);
  } else {
    btn.textContent = opts.label;
  }

  if (opts.onClick) btn.addEventListener('click', opts.onClick);
  return btn;
}

/** Update a button's text, honouring the `.switch-label` span if present. */
export function setButtonLabel(btn: HTMLButtonElement, text: string): void {
  const label = btn.querySelector<HTMLElement>('.switch-label');
  if (label) label.textContent = text;
  else btn.textContent = text;
}
