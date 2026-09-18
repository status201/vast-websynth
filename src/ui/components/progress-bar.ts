import styles from '../styles/progress-bar.module.css';

/**
 * Shared progress bar (specs/features/progress-bar.md): a `role="progressbar"`
 * track whose fill width is the ratio, plus a striped variant for work whose
 * length nobody knows. Used by the export dialog and the About card's offline
 * download.
 */
export interface ProgressBar {
  /** The track. Show or hide it with `el.hidden`. */
  readonly el: HTMLElement;
  /** 0…1, clamped; a non-finite ratio counts as 0 (REQ-determinate-announces-value). */
  set(ratio: number): void;
  /** Stripes over a full bar, and no `aria-valuenow` — no claimed length (REQ-indeterminate-drops-valuenow). */
  setIndeterminate(on: boolean): void;
}

export function createProgressBar(opts: { testId?: string; label?: string } = {}): ProgressBar {
  const track = document.createElement('div');
  track.className = styles.track!;
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  if (opts.testId) track.dataset.testid = opts.testId;
  if (opts.label) track.setAttribute('aria-label', opts.label);

  const fill = document.createElement('div');
  fill.className = styles.fill!;
  track.appendChild(fill);

  return {
    el: track,
    set(ratio: number): void {
      const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
      fill.style.width = `${(r * 100).toFixed(1)}%`;
      track.setAttribute('aria-valuenow', String(Math.round(r * 100)));
    },
    setIndeterminate(on: boolean): void {
      track.classList.toggle(styles.indeterminate!, on);
      if (!on) return;
      fill.style.width = '100%';
      track.removeAttribute('aria-valuenow');
    },
  };
}
