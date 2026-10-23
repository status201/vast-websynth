// The demo library (demo-library.md REQ-the-library-reads-without-loading): every
// demo's facts and notes, readable without loading one. The row's `title` carried
// the same text, but only a hover shows a title — and on a touch screen the only
// gesture a demo button has is the one that replaces the session.
//
// Loaded on demand: the Song panel imports this on the ⓘ click, the info badges
// from inside their own lazy chunk (runtime-performance.md REQ-boot-cost-matches-the-request).
import { Modal } from './modal';
import { createButton, setButtonLabel } from './button';
import { demoNames, demoMetaFor } from '../../state/song';
import { demoFacts } from '../../state/demo-meta';
import switchStyles from '../styles/switch.module.css';
import styles from '../styles/demo-library.module.css';

export interface DemoLibraryOptions {
  /** The Song panel's `loadDemo` — the one door every demo load goes through. */
  loadDemo: (name: string) => Promise<void>;
  /** Called before `loadDemo` when Load is pressed. */
  close: () => void;
  /** The loaded demo: its entry is marked, unfolded and scrolled into view, and its
   *  button reads "Loaded" (disabled). */
  focus?: string | null;
}

/** A blurb and the More/Less toggle that folds it (REQ-a-blurb-folds-to-its-first-line). */
interface Fold {
  blurb: HTMLElement;
  toggle: HTMLButtonElement;
}

const setFolded = ({ blurb, toggle }: Fold, folded: boolean): void => {
  blurb.classList.toggle(styles.folded!, folded);
  toggle.setAttribute('aria-expanded', String(!folded));
  setButtonLabel(toggle, folded ? 'More' : 'Less');
};

export function renderDemoLibrary(opts: DemoLibraryOptions): HTMLElement {
  const list = document.createElement('ul');
  list.className = styles.list!;
  list.dataset.testid = 'demo-library';
  let focused: HTMLElement | null = null;
  const folds: Fold[] = [];

  demoNames().forEach((name, i) => {
    const meta = demoMetaFor(name);
    const loaded = name === opts.focus;
    const entry = document.createElement('li');
    entry.className = styles.entry!;
    entry.dataset.testid = 'demo-library-entry';
    if (loaded) {
      entry.setAttribute('aria-current', 'true');
      focused = entry;
    }

    const head = document.createElement('div');
    head.className = styles.head!;
    const title = document.createElement('h3');
    title.className = styles.name!;
    title.textContent = name;
    head.appendChild(title);
    const load = createButton({
      label: loaded ? 'Loaded' : 'Load',
      ariaLabel: loaded ? `${name} is loaded` : `Load ${name}`,
      className: `${switchStyles.root!} ${styles.load!}`,
      testId: 'demo-library-load',
      onClick: () => {
        // Close first: the load may raise its own dialog (the same-name
        // question), which must not open underneath this one.
        opts.close();
        void opts.loadDemo(name);
      },
    });
    // Re-loading from here would silently drop any edit made since; the row's
    // own button still does it, behind the Undo toast (REQ-the-loaded-demo-carries-an-info-button).
    load.disabled = loaded;
    head.appendChild(load);
    entry.appendChild(head);

    const facts = meta ? demoFacts(meta) : '';
    if (facts) {
      const p = document.createElement('p');
      p.className = styles.facts!;
      p.textContent = facts;
      entry.appendChild(p);
    }
    if (meta?.blurb) {
      // Text, never HTML: the blurb is data from a drop-in file.
      const blurb = document.createElement('p');
      blurb.className = styles.blurb!;
      blurb.id = `demo-library-blurb-${i}`;
      blurb.textContent = meta.blurb;
      const toggle = createButton({ label: 'More', className: styles.more!, testId: 'demo-library-more' });
      toggle.setAttribute('aria-controls', blurb.id);
      const fold: Fold = { blurb, toggle };
      toggle.addEventListener('click', () => setFolded(fold, toggle.getAttribute('aria-expanded') === 'true'));
      // The loaded demo's notes are what its ⓘ was pressed for.
      setFolded(fold, !loaded);
      folds.push(fold);
      entry.appendChild(blurb);
      entry.appendChild(toggle);
    }
    list.appendChild(entry);
  });

  // After the caller has mounted and laid the list out.
  requestAnimationFrame(() => {
    dropIdleToggles(folds);
    if (focused) scrollToEntry(focused);
  });
  return list;
}

/**
 * A blurb that fits its first line gets no toggle: one that changes nothing
 * teaches the player to ignore the rest (REQ-a-blurb-folds-to-its-first-line).
 * Every blurb is measured folded, so an unfolded one is judged the same way — all
 * reads before any write. Unlaid-out (height 0, as in jsdom) keeps every toggle:
 * a spare toggle is the safe way to be wrong.
 *
 * A blurb that loses its toggle loses its clamp too. It fits one line *now*; a
 * narrower window later (a phone turned upright) would wrap it, and a clamped
 * blurb with no toggle would then hide its own end with no way to read it.
 */
function dropIdleToggles(folds: Fold[]): void {
  const wasFolded = folds.map(({ blurb }) => blurb.classList.contains(styles.folded!));
  for (const { blurb } of folds) blurb.classList.add(styles.folded!);
  const idle = folds.map(({ blurb }) => blurb.clientHeight > 0 && blurb.scrollHeight <= blurb.clientHeight);
  folds.forEach((fold, i) => {
    if (idle[i]) fold.toggle.remove();
    if (idle[i] || !wasFolded[i]) fold.blurb.classList.remove(styles.folded!);
  });
}

/**
 * Bring the loaded entry's top into view inside the modal card — not with
 * `scrollIntoView`, which would also scroll the page behind the backdrop, and
 * whose 'nearest' shows the END of a tall unfolded entry rather than its name.
 */
function scrollToEntry(entry: HTMLElement): void {
  const card = entry.closest<HTMLElement>(`.${Modal.cardClass}`);
  if (!card) return;
  card.scrollTop += entry.getBoundingClientRect().top - card.getBoundingClientRect().top - 12;
}

/** {@link renderDemoLibrary} in its own Modal, framed the way an info badge's topic is. */
export function openDemoLibrary(opts: Omit<DemoLibraryOptions, 'close'>): void {
  const modal = new Modal({ title: 'Demo library' });
  const content = document.createElement('div');
  content.className = Modal.metaClass;
  content.appendChild(renderDemoLibrary({ ...opts, close: () => modal.close() }));
  modal.body.appendChild(content);
  modal.body.appendChild(
    createButton({
      label: 'Close',
      className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
      onClick: () => modal.close(),
    }),
  );
  modal.open();
}
