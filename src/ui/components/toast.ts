import { createButton } from './button';
import switchStyles from '../styles/switch.module.css';
import styles from '../styles/toast.module.css';

/**
 * Transient bottom-center notification with an optional single action button
 * (e.g. "Loaded Mordor — Undo"). Non-modal: never steals focus, never
 * blocks input, announces politely via `role="status"`. One toast at a time —
 * showing a new one replaces (and dismisses) the previous, so a caller holding
 * state in the toast's closure (the session-undo stash) knows exactly when its
 * references are released: `onDismiss` fires on every exit path.
 *
 * See `specs/features/toast.md`.
 */

export interface ToastOptions {
  message: string;
  /** Renders a single action button after the message (e.g. 'Undo'). */
  actionLabel?: string;
  /** Fires at most once, then the toast dismisses itself. */
  onAction?: () => void;
  /** Auto-dismiss delay; 0 keeps the toast until dismissed. Default 8000. */
  durationMs?: number;
  /** `data-testid` for the toast root. Default 'toast'. */
  testId?: string;
}

export interface ToastHandle {
  readonly el: HTMLElement;
  dismiss(): void;
  /** Fires when the toast leaves (timeout, ✕, action, or replacement). */
  onDismiss(fn: () => void): void;
}

const DEFAULT_DURATION_MS = 8000;

// Single-slot host, lazily appended to <body> on first use and shared by every
// toast so replacement is structural: the host has at most one child.
let host: HTMLElement | null = null;
let current: ToastHandle | null = null;

function ensureHost(): HTMLElement {
  if (host && host.isConnected) return host;
  host = document.createElement('div');
  host.className = styles.host!;
  host.dataset.testid = 'toast-host';
  document.body.appendChild(host);
  return host;
}

export function showToast(opts: ToastOptions): ToastHandle {
  // Replace-not-stack: the previous toast's onDismiss fires before the new
  // toast mounts, releasing whatever its closure held.
  current?.dismiss();

  const el = document.createElement('div');
  el.className = styles.toast!;
  el.dataset.testid = opts.testId ?? 'toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const message = document.createElement('span');
  message.className = styles.message!;
  message.textContent = opts.message;
  el.appendChild(message);

  const dismissListeners: (() => void)[] = [];
  let dismissed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    if (timer !== undefined) clearTimeout(timer);
    el.remove();
    if (current === handle) current = null;
    for (const fn of dismissListeners) fn();
  };

  if (opts.actionLabel) {
    let acted = false;
    el.appendChild(createButton({
      label: opts.actionLabel,
      className: `${switchStyles.root!} ${styles.action!}`,
      testId: 'toast-action',
      onClick: () => {
        if (acted) return;
        acted = true;
        opts.onAction?.();
        dismiss();
      },
    }));
  }

  el.appendChild(createButton({
    label: '✕',
    ariaLabel: 'Dismiss',
    className: `${switchStyles.root!} ${styles.dismiss!}`,
    testId: 'toast-dismiss',
    onClick: dismiss,
  }));

  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;
  if (durationMs > 0) timer = setTimeout(dismiss, durationMs);

  const handle: ToastHandle = {
    el,
    dismiss,
    onDismiss: (fn) => { dismissListeners.push(fn); },
  };

  ensureHost().appendChild(el);
  current = handle;
  return handle;
}
