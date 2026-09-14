// The About card's **Play offline** section (specs/features/play-offline.md):
// one button, a status line and a progress bar, rendering the page's single
// `OfflineCopy`. It sits directly above Restore to Factory Settings (REQ-1).
//
// This module only renders. The state lives in `utils/offline-copy.ts`, so
// closing the card is not a cancel; the toasts for a run that ends while the
// card is hidden live in `offline-notices.ts` (REQ-8), which this section tells
// when its own status line is on screen.
import { Modal } from './modal';
import { createButton } from './button';
import { createProgressBar } from './progress-bar';
import { watchOfflineRuns } from './offline-notices';
import { UI_ICONS, iconLabel, type IconName } from './ui-icons';
import { formatBytes, megabytes, plural } from '../../utils/format';
import {
  getOfflineCopy,
  type OfflineCopy,
  type OfflineErrorReason,
  type OfflineState,
} from '../../utils/offline-copy';
import switchStyles from '../styles/switch.module.css';
import styles from '../styles/about-offline.module.css';

/** What the section shows for a state — REQ-3's table, as data. */
export interface OfflineView {
  label: string;
  icon: IconName;
  disabled: boolean;
  status: string;
  tone: 'ok' | 'bad' | null;
  /** 0…1, `'indeterminate'` while the list is not known, `null` hides the bar. */
  progress: number | 'indeterminate' | null;
}

const PITCH = 'Saves everything on this device — demos, dialogs and help — so it plays with no connection';

const ERROR_LINE: Record<OfflineErrorReason, (failed: number) => string> = {
  files: (n) => `Couldn't download ${plural(n, 'file')} — check your connection. The rest is saved.`,
  offline: () => "Couldn't reach the server — check your connection and try again.",
  storage: () => 'Not enough free storage on this device.',
  worker: () => "The offline helper didn't start — reload the page and try again.",
};

/** The button's resting look, which most states only amend. */
const IDLE: Omit<OfflineView, 'status'> = {
  label: 'Play offline',
  icon: 'download',
  disabled: false,
  tone: null,
  progress: null,
};

export function offlineView(s: OfflineState): OfflineView {
  switch (s.kind) {
    case 'unsupported':
      return {
        ...IDLE,
        disabled: true,
        status: s.reason === 'dev'
          ? 'Offline play comes with the published app, not the dev server.'
          : "This browser can't keep an offline copy (a private window can't).",
      };
    case 'checking':
      return { ...IDLE, disabled: true, status: 'Checking this device…' };
    case 'none':
      return { ...IDLE, status: s.remainingBytes ? `${PITCH} · ${formatBytes(s.remainingBytes)}` : `${PITCH}.` };
    case 'downloading': {
      const cancel = { ...IDLE, label: 'Cancel', icon: 'close' } as const;
      if (s.totalFiles === 0) return { ...cancel, progress: 'indeterminate', status: 'Preparing…' };
      return {
        ...cancel,
        progress: s.totalBytes > 0 ? s.doneBytes / s.totalBytes : 0,
        status: `Downloading ${s.doneFiles} of ${s.totalFiles} files · ${megabytes(s.doneBytes)} / ${megabytes(s.totalBytes)} MB`,
      };
    }
    case 'complete':
      return {
        ...IDLE,
        label: 'Ready to play offline',
        icon: 'check',
        tone: 'ok',
        status: `All ${plural(s.files, 'file')} (${formatBytes(s.totalBytes)}) are on this device. New versions update it automatically.`
          + (s.persisted ? '' : ' The browser may clear it if storage runs low.'),
      };
    case 'error':
      return { ...IDLE, label: 'Try again', icon: 'reset', tone: 'bad', status: ERROR_LINE[s.reason](s.failed) };
    case 'needs-reload':
      return { ...IDLE, label: 'Reload', icon: 'reset', status: 'A new version was installed — reload first.' };
  }
}

export function buildOfflineSection(
  copy: OfflineCopy = getOfflineCopy(),
  reload: () => void = () => location.reload(),
): { root: HTMLElement; refresh: () => void } {
  const root = document.createElement('div');
  root.className = styles.root!;
  root.dataset.testid = 'play-offline';

  const btn = createButton({
    label: 'Play offline',
    iconBefore: UI_ICONS.download,
    className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
    testId: 'play-offline-button',
    onClick: () => {
      switch (copy.state.kind) {
        case 'downloading': copy.cancel(); return;
        case 'needs-reload': reload(); return;
        case 'unsupported':
        case 'checking': return;
        // none, error, and complete — where a run skips what is cached and
        // repairs whatever the browser evicted (REQ-5).
        default: void copy.start();
      }
    },
  });

  const status = document.createElement('p');
  status.className = styles.status!;
  status.dataset.testid = 'play-offline-status';
  status.setAttribute('aria-live', 'polite');

  const bar = createProgressBar({ testId: 'play-offline-progress', label: 'Offline download' });
  bar.el.hidden = true;

  root.append(btn, status, bar.el);

  const render = (s: OfflineState): void => {
    const v = offlineView(s);
    // Literal labels only, so markup is safe here (iconography.md iconLabel).
    btn.innerHTML = iconLabel(v.icon, v.label);
    btn.disabled = v.disabled;
    status.textContent = v.status;
    status.classList.toggle(styles.ok!, v.tone === 'ok');
    status.classList.toggle(styles.bad!, v.tone === 'bad');
    bar.el.hidden = v.progress === null;
    bar.setIndeterminate(v.progress === 'indeterminate');
    if (typeof v.progress === 'number') bar.set(v.progress);
  };

  // The card is built once and reused (about-button.ts), so this subscription
  // lives as long as the page. While the card is on screen its status line is
  // the report, so the toasts stand down (REQ-8).
  copy.subscribe(render);
  watchOfflineRuns(copy, reload).setInlineView(
    () => root.isConnected && root.closest('.hidden') === null,
  );

  render(copy.state);
  return { root, refresh: () => void copy.refresh() };
}
