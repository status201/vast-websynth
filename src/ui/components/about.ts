// "About" button + modal: version, copyright, and keyboard shortcuts.
// Static info only — no engine/bus dependency.

declare const __APP_VERSION__: string;

const SHORTCUTS: Array<[string, string]> = [
  ['Z S X D C V G B H N J M ,', 'Play notes — lower octave'],
  ['Q 2 W 3 E R 5 T 6 Y 7 U I', 'Play notes — upper octave'],
  ['←  →', 'Shift keyboard octave down / up'],
  ['.  /', 'Pitch bend up / down'],
  ['Esc', 'Panic — all notes off'],
];

export function createAboutButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'switch';
  btn.textContent = 'About';

  let backdrop: HTMLElement | null = null;
  let closeTimer: number | undefined;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Beat the global Escape→panic handler in shortcuts.ts.
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  };

  function close(): void {
    if (!backdrop) return;
    window.removeEventListener('keydown', onKey, true);
    backdrop.classList.add('hidden');
    const el = backdrop;
    closeTimer = window.setTimeout(() => el.remove(), 200);
  }

  function open(): void {
    window.clearTimeout(closeTimer);
    backdrop ??= buildModal(close);
    document.body.appendChild(backdrop);
    // Force reflow so the opacity transition runs from the .hidden state.
    void backdrop.offsetWidth;
    backdrop.classList.remove('hidden');
    window.addEventListener('keydown', onKey, true);
  }

  btn.addEventListener('click', open);
  return btn;
}

function buildModal(close: () => void): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'about-backdrop hidden';
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });

  const card = document.createElement('div');
  card.className = 'about';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'About VAST G1-J5');

  const title = document.createElement('div');
  title.className = 'about-title';
  title.textContent = 'VAST G1-J5';

  const tag = document.createElement('div');
  tag.className = 'about-tag';
  tag.textContent = 'Vast Audio Synthesis Technology';

  const meta = document.createElement('div');
  meta.className = 'about-meta';
  const version = document.createElement('div');
  version.innerHTML = `Version <strong>${__APP_VERSION__}</strong>`;
  const copyright = document.createElement('div');
  copyright.innerHTML = `&copy; ${new Date().getFullYear()} <strong>Gijs Oliemans</strong>`;
  meta.appendChild(version);
  meta.appendChild(copyright);

  const sec = document.createElement('div');
  sec.className = 'about-sec';
  sec.textContent = 'Keyboard Shortcuts';

  const keys = document.createElement('div');
  keys.className = 'about-keys';
  for (const [combo, action] of SHORTCUTS) {
    const k = document.createElement('div');
    k.className = 'about-key';
    k.textContent = combo;
    const a = document.createElement('div');
    a.className = 'about-act';
    a.textContent = action;
    keys.appendChild(k);
    keys.appendChild(a);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'switch about-close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', close);

  card.appendChild(title);
  card.appendChild(tag);
  card.appendChild(meta);
  card.appendChild(sec);
  card.appendChild(keys);
  card.appendChild(closeBtn);
  backdrop.appendChild(card);
  return backdrop;
}
