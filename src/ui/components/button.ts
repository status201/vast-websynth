import styles from '../styles/switch.module.css';

/**
 * Shared button factory. Every button in the app is a switch-styled
 * `<button>`; some (the transport Play button) carry an LED dot + a label
 * span so the `.on` state can glow. One helper keeps that markup in one
 * place instead of being hand-rolled at each call site.
 */
export interface ButtonOptions {
  label: string;
  /**
   * Inline SVG markup rendered *instead of* the text label (icon-only button,
   * e.g. the header utility buttons). The `label` then becomes the accessible
   * name (`aria-label`) unless `ariaLabel` overrides it.
   */
  icon?: string;
  /** Tooltip (`title` attribute). */
  title?: string;
  /** Accessible name; defaults to `label` when `icon` replaces the text. */
  ariaLabel?: string;
  /** CSS class(es). Defaults to the shared switch style. */
  className?: string;
  type?: 'button' | 'submit';
  onClick?: (ev: MouseEvent) => void;
  /** Render `<span.switch-led>` + `<span.switch-label>` (e.g. Play/Stop). */
  led?: boolean;
  /** Stable `data-testid` for E2E selectors. */
  testId?: string;
}

export function createButton(opts: ButtonOptions): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = opts.type ?? 'button';
  btn.className = opts.className ?? styles.root!;

  if (opts.led) {
    const led = document.createElement('span');
    led.className = `${styles.led!} switch-led`;
    const label = document.createElement('span');
    label.className = `${styles.label!} switch-label`;
    label.textContent = opts.label;
    btn.appendChild(led);
    btn.appendChild(label);
  } else if (opts.icon) {
    btn.innerHTML = opts.icon;
  } else {
    btn.textContent = opts.label;
  }

  if (opts.title) btn.title = opts.title;
  const ariaLabel = opts.ariaLabel ?? (opts.icon ? opts.label : undefined);
  if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  if (opts.testId) btn.dataset.testid = opts.testId;
  if (opts.onClick) btn.addEventListener('click', opts.onClick);
  return btn;
}

/** Update a button's text, honouring the label span if present. */
export function setButtonLabel(btn: HTMLButtonElement, text: string): void {
  const label = btn.querySelector<HTMLElement>(`.${styles.label!}`);
  if (label) label.textContent = text;
  else btn.textContent = text;
}

/** Swap an icon-only button's SVG (e.g. fullscreen expand ↔ compress). */
export function setButtonIcon(btn: HTMLButtonElement, icon: string): void {
  btn.innerHTML = icon;
}
