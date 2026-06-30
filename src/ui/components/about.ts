// "About" button + modal: version, copyright, keyboard shortcuts, and a
// collapsible Debug section (live AudioContext state — see ios-audio.md).
import { Modal } from './modal';
import { createButton } from './button';
import { createCollapseToggle } from './collapse-toggle';
import { isIOS } from '../../platform/ios';
import type { StudioApi } from '../studio-api';
import switchStyles from '../styles/switch.module.css';
import styles from '../styles/modal.module.css';

declare const __APP_VERSION__: string;

const SHORTCUTS: Array<[string, string]> = [
  ['Z S X D C V G B H N J M ,', 'Play notes — lower octave'],
  ['Q 2 W 3 E R 5 T 6 Y 7 U I', 'Play notes — upper octave'],
  ['←  →', 'Shift keyboard octave down / up'],
  ['.  /', 'Pitch bend up / down'],
  ['Space', 'Play / stop transport'],
  ['F (hold)', 'Drum fill'],
  ['Esc', 'Panic — all notes off'],
  ['Shift + drag', 'Fine knob control'],
];

export function createAboutButton(engine: StudioApi): HTMLButtonElement {
  // `open` is a hoisted function declaration, so wiring it here is safe.
  const btn = createButton({ label: 'About', onClick: open });

  let backdrop: HTMLElement | null = null;
  let refreshDebug: (() => void) | null = null;
  let closeTimer: number | undefined;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Beat the global Escape→panic handler in shortcuts.ts.
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  };

  // Keep the live Debug readout current only while the modal is open.
  const onState = () => refreshDebug?.();

  function close(): void {
    if (!backdrop) return;
    window.removeEventListener('keydown', onKey, true);
    engine.ctx.removeEventListener('statechange', onState);
    backdrop.classList.add('hidden');
    const el = backdrop;
    closeTimer = window.setTimeout(() => el.remove(), 200);
  }

  function open(): void {
    window.clearTimeout(closeTimer);
    if (!backdrop) {
      const built = buildModal(close, engine);
      backdrop = built.backdrop;
      refreshDebug = built.refreshDebug;
    }
    document.body.appendChild(backdrop);
    // Force reflow so the opacity transition runs from the .hidden state.
    void backdrop.offsetWidth;
    backdrop.classList.remove('hidden');
    refreshDebug?.();
    window.addEventListener('keydown', onKey, true);
    engine.ctx.addEventListener('statechange', onState);
  }

  return btn;
}

function buildModal(close: () => void, engine: StudioApi): { backdrop: HTMLElement; refreshDebug: () => void } {
  const backdrop = document.createElement('div');
  backdrop.className = `${Modal.backdropClass} hidden`;
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });

  const card = document.createElement('div');
  card.className = Modal.cardClass;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'About VAST G1-J5');

  const title = document.createElement('div');
  title.className = Modal.titleClass;
  title.textContent = 'VAST G1-J5';

  const tag = document.createElement('div');
  tag.className = Modal.tagClass;
  tag.textContent = 'Vast Audio Synthesis Technology';

  const meta = document.createElement('div');
  meta.className = Modal.metaClass;
  const version = document.createElement('div');
  version.innerHTML = `Version <strong>${__APP_VERSION__}</strong>`;
  const copyright = document.createElement('div');
  copyright.innerHTML = `&copy; ${new Date().getFullYear()} <strong>Gijs Oliemans</strong>`;
  const source = document.createElement('div');
  const link = document.createElement('a');
  link.href = 'https://github.com/status201/vast-websynth';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'github.com/status201/vast-websynth';
  source.appendChild(link);
  meta.appendChild(version);
  meta.appendChild(copyright);
  meta.appendChild(source);

  const sec = document.createElement('div');
  sec.className = Modal.secClass;
  sec.textContent = 'Keyboard Shortcuts';

  const keys = document.createElement('div');
  keys.className = Modal.keysClass;
  for (const [combo, action] of SHORTCUTS) {
    const k = document.createElement('div');
    k.className = Modal.keyClass;
    k.textContent = combo;
    const a = document.createElement('div');
    a.className = Modal.actClass;
    a.textContent = action;
    keys.appendChild(k);
    keys.appendChild(a);
  }

  const debug = buildDebugSection(engine);

  const closeBtn = createButton({
    label: 'Close',
    className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
    onClick: close,
  });

  card.appendChild(title);
  card.appendChild(tag);
  card.appendChild(meta);
  card.appendChild(sec);
  card.appendChild(keys);
  card.appendChild(debug.header);
  card.appendChild(debug.body);
  card.appendChild(closeBtn);
  backdrop.appendChild(card);
  return { backdrop, refreshDebug: debug.refresh };
}

/**
 * Default-collapsed Debug section. Cross-platform and intentionally minimal +
 * extensible — more diagnostic rows can be appended without a contract change.
 * Seeded with live AudioContext state, the iOS flag, and the sample rate.
 */
function buildDebugSection(engine: StudioApi): { header: HTMLElement; body: HTMLElement; refresh: () => void } {
  const header = document.createElement('div');
  header.className = `${Modal.secClass} ${styles.debugHeader!}`;
  const label = document.createElement('span');
  label.textContent = 'Debug';
  header.appendChild(label);

  const body = document.createElement('div');
  body.className = `${Modal.keysClass} ${styles.debugBody!}`;
  body.dataset.testid = 'debug-section';

  const addRow = (name: string): HTMLElement => {
    const k = document.createElement('div');
    k.className = Modal.keyClass;
    k.textContent = name;
    const v = document.createElement('div');
    v.className = Modal.actClass;
    body.appendChild(k);
    body.appendChild(v);
    return v;
  };

  const stateVal = addRow('AudioContext');
  stateVal.dataset.testid = 'debug-ctx-state';
  const iosVal = addRow('iOS');
  const rateVal = addRow('Sample rate');

  const refresh = (): void => {
    stateVal.textContent = engine.ctx.state;
    iosVal.textContent = isIOS() ? 'yes' : 'no';
    rateVal.textContent = `${engine.ctx.sampleRate} Hz`;
  };
  refresh();

  // Whole-header click toggles (chevron included), persisted; default collapsed.
  const toggle = createCollapseToggle(body, 'websynth.debug.about', {
    defaultCollapsed: () => true,
    trigger: header,
  });
  header.appendChild(toggle.el);

  return { header, body, refresh };
}
