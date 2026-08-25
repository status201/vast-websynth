import type { ParamBus } from '../../state/params';
import type { StudioApi } from '../studio-api';
import type { XyPadWindowController } from './xy-pad-window';
import type { ModMatrixWindowController } from './mod-matrix-window';
import { Knob } from './knob';
import { FloatingWindow } from './floating-window';
import switchStyles from '../styles/switch.module.css';
import segmentedStyles from '../styles/segmented.module.css';
import styles from '../styles/song-panel.module.css';
import { UI_ICONS } from './ui-icons';

/**
 * The live "DJ" FX controls (Fill, Stutter + bar size, Drop, Tape Stop) shared by
 * the Song panel and the LIVE FX floating window, plus that window and its launcher.
 * Extracted so both surfaces render the *same* controls from one source (DRY). All
 * momentary controls drive the engine-owned `Performance` (`engine.perf.*`); the DJ
 * Filter knob (added by each caller) drives the `fx.djfilter` param. See
 * `specs/features/live-fx-window.md` and `specs/features/performance.md`.
 */

/** Press-and-hold button: pointerdown -> on(), pointerup/leave/cancel -> off(). */
function momentary(label: string, on: () => void, off: () => void, testid: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${switchStyles.root!} ${styles.djBtn!}`;
  b.textContent = label;
  b.dataset.testid = testid;
  const start = (e: Event): void => { e.preventDefault(); if (!b.classList.contains('on')) { b.classList.add('on'); on(); } };
  const end = (): void => { if (b.classList.contains('on')) { b.classList.remove('on'); off(); } };
  b.addEventListener('pointerdown', start);
  b.addEventListener('pointerup', end);
  b.addEventListener('pointerleave', end);
  b.addEventListener('pointercancel', end);
  return b;
}

/** A plain DJ-styled toggle button (used by the XY Pad / LIVE FX launchers). */
function djButton(label: string, testid: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${switchStyles.root!} ${styles.djBtn!}`;
  b.textContent = label;
  b.dataset.testid = testid;
  return b;
}

/**
 * Build the momentary DJ controls: `[Fill, Stutter(+size), Drop, Tape Stop]`.
 * `testIdPrefix` (default `'perf'`) namespaces every testid so a second instance
 * (the LIVE FX window, `'livefx'`) can coexist with the Song panel's without id
 * collisions. The DJ Filter knob is added by each caller (it needs `bus`).
 */
export function buildLiveFxControls(engine: StudioApi, opts: { testIdPrefix?: string } = {}): HTMLElement[] {
  const p = opts.testIdPrefix ?? 'perf';
  const controls: HTMLElement[] = [];

  controls.push(momentary('Fill', () => engine.perf.setFill(true), () => engine.perf.setFill(false), `${p}-fill`));

  const stutterWrap = document.createElement('div');
  stutterWrap.className = styles.stutter!;
  stutterWrap.appendChild(momentary('Stutter',
    () => engine.perf.setStutter(true), () => engine.perf.setStutter(false), `${p}-stutter`));
  const sizes = document.createElement('div');
  sizes.className = `${styles.stutterSize!} ${segmentedStyles.root!}`;
  ([['1', 1], ['1/8', 2], ['1/4', 4]] as Array<[string, number]>).forEach(([lbl, n], i) => {
    const sb = document.createElement('button');
    sb.type = 'button';
    sb.textContent = lbl;
    sb.dataset.testid = `${p}-stutter-size-${n}`;
    if (i === 1) sb.classList.add('active');
    sb.addEventListener('click', () => {
      engine.perf.setStutterSize(n);
      for (const c of Array.from(sizes.children)) c.classList.remove('active');
      sb.classList.add('active');
    });
    sizes.appendChild(sb);
  });
  stutterWrap.appendChild(sizes);
  controls.push(stutterWrap);

  controls.push(momentary('Drop', () => engine.perf.setDrop(true), () => engine.perf.setDrop(false), `${p}-drop`));
  controls.push(momentary('Tape Stop',
    () => engine.perf.setTapeStop(true), () => engine.perf.setTapeStop(false), `${p}-tapestop`));
  return controls;
}

/**
 * A "XY Pad" launcher button wired to the shared window controller. Multiple
 * buttons (Song panel + LIVE FX window) share one controller, so they toggle a
 * single window and all reflect its open state (`.on`).
 */
export function xyPadLaunchButton(win: XyPadWindowController, testId: string): HTMLButtonElement {
  const b = djButton('XY Pad', testId);
  b.addEventListener('click', () => win.toggle());
  win.onChange((open) => b.classList.toggle('on', open));
  return b;
}

/**
 * The "LIVE FX" launcher button (Song panel). Toggles a non-modal FloatingWindow
 * that surfaces the DJ controls (so they're usable off the Song tab): a DJ Filter
 * knob, the shared momentary controls, and an XY Pad launcher (sharing `xyWin`).
 * The window is built lazily and kept alive across closes.
 */
export function createLiveFxWindowLauncher(
  engine: StudioApi,
  bus: ParamBus,
  xyWin: XyPadWindowController,
): HTMLButtonElement {
  const b = djButton('LIVE FX', 'livefx-open');
  // The "opens a new window" glyph, drawn rather than typed (iconography.md).
  // aria-hidden — the button's own aria-label carries the meaning.
  const glyph = document.createElement('span');
  glyph.className = styles.winGlyph!;
  glyph.innerHTML = UI_ICONS.popOut;
  glyph.setAttribute('aria-hidden', 'true');
  b.appendChild(glyph);
  b.setAttribute('aria-label', 'Open LIVE FX window');
  let win: FloatingWindow | null = null;
  b.addEventListener('click', () => {
    if (win?.isOpen) { win.close(); return; }
    if (!win) {
      win = new FloatingWindow({
        title: 'LIVE FX',
        testId: 'livefx-window',
        onClose: () => b.classList.remove('on'),
      });
      win.body.className += ` ${styles.djFxWindow!}`;
      win.body.appendChild(new Knob({ bus, paramId: 'fx.djfilter', label: 'DJ FLT' }).el);
      for (const c of buildLiveFxControls(engine, { testIdPrefix: 'livefx' })) win.body.appendChild(c);
      win.body.appendChild(xyPadLaunchButton(xyWin, 'livefx-xypad'));
    }
    win.open();
    b.classList.add('on');
  });
  return b;
}

/**
 * The MOD launcher — the mod matrix's door, and the sibling of `xyPadLaunchButton`
 * above. Both live here so they wear the same faceplate button, and both take a
 * shared controller so every door toggles the SAME window rather than spawning a
 * second (specs/features/mod-matrix.md, floating-window.md REQ-2).
 *
 * It sits in this row because the row is where *assignable controller* launchers
 * already live: the XY Pad beside it is itself a modulation controller whose
 * assignment saves with the song.
 */
export function modMatrixLaunchButton(
  win: ModMatrixWindowController, testId: string,
): HTMLButtonElement {
  const b = djButton('MOD', testId);
  b.title = 'Modulation matrix';
  b.addEventListener('click', () => win.toggle());
  win.onChange((open) => b.classList.toggle('on', open));
  return b;
}
