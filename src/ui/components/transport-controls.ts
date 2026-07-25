import type { ParamBus } from '../../state/params';
import type { StudioApi } from '../studio-api';
import type { UiBridge } from '../ui-bridge';
import { Knob } from './knob';
import { FloatingWindow } from './floating-window';
import { SEQ_LENGTH } from '../../state/patterns';
import switchStyles from '../styles/switch.module.css';
import songStyles from '../styles/song-panel.module.css';
import styles from '../styles/transport-controls.module.css';

/**
 * The song-scale transport shared by the Song panel's row and the TRANSPORT
 * floating window (transport-window.md), plus that window and its launcher.
 *
 * The machine-tab rulers (transport-position.md) cover the 16th *within a bar*;
 * this covers the song — which bar of an `A A B A` chain you are on, and getting
 * to bar 3 without playing from the top. Built once and rendered twice, following
 * the LIVE FX precedent (live-fx-window.md), so the two surfaces can never drift.
 */

export interface TransportControlsOpts {
  /** Namespaces every testid so two instances coexist. Default `'transport'`. */
  testIdPrefix?: string;
  /** Song-panel row: drop Play/Stop, BPM and SWING (they live in the window). */
  compact?: boolean;
}

/** Global state class marking the current bar — as the rulers use. */
const AT_CLASS = 'playing';

function djButton(label: string, testid: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${switchStyles.root!} ${songStyles.djBtn!}`;
  b.textContent = label;
  b.dataset.testid = testid;
  return b;
}

/**
 * `[Play/Stop, ⏮, bar.step, scrubber, BPM, SWING]` — or just `[⏮, bar.step,
 * scrubber]` when `compact`.
 *
 * Takes the `UiBridge` rather than touching the clock, because Play/Stop must
 * click the *real* header button (transport-window.md REQ-5): that is what
 * carries the empty-play hint and the LED blink state machine, and it is the
 * only way two Play buttons can be guaranteed to agree.
 */
export function buildTransportControls(
  engine: StudioApi,
  bus: ParamBus,
  bridge: UiBridge,
  opts: TransportControlsOpts = {},
): HTMLElement[] {
  const p = opts.testIdPrefix ?? 'transport';
  const out: HTMLElement[] = [];

  /** Playing: the live step. Stopped: the cue, i.e. where Play will begin. */
  const position = (): number => (engine.clock.playing ? engine.clock.step : engine.clock.cue);

  if (!opts.compact) {
    // `-toggle`, not `-play`: the header's own Play button is `transport-play`,
    // and a default-prefixed instance minting a second one would break every
    // spec that drives the transport by that id.
    const play = djButton('Play', `${p}-toggle`);
    play.addEventListener('click', () => bridge.toggleTransport());
    const syncPlay = (): void => {
      const playing = engine.clock.playing;
      play.classList.toggle('on', playing);
      play.textContent = playing ? 'Stop' : 'Play';
    };
    engine.clock.onStart(syncPlay);
    engine.clock.onStop(syncPlay);
    syncPlay();
    out.push(play);
  }

  const toStart = djButton('⏮', `${p}-tostart`);
  toStart.title = 'Back to bar 1 (Home)';
  toStart.setAttribute('aria-label', 'Back to the start');
  toStart.addEventListener('click', () => engine.seekTo(0));
  out.push(toStart);

  const readout = document.createElement('div');
  readout.className = styles.readout!;
  readout.dataset.testid = `${p}-readout`;
  out.push(readout);

  const scrub = document.createElement('div');
  scrub.className = styles.scrub!;
  scrub.dataset.testid = `${p}-scrub`;
  out.push(scrub);

  // Split rendering, as the chain chips do: the cell DOM is rebuilt only when
  // the song's length actually changes, while the lit class moves in place on
  // every tick — no listener churn during playback.
  let cells: HTMLButtonElement[] = [];
  let builtBars = -1;
  let litBar = -1;

  const renderStructure = (bars: number): void => {
    scrub.innerHTML = '';
    cells = [];
    for (let i = 0; i < bars; i++) {
      const bar = i;
      const c = document.createElement('button');
      c.type = 'button';
      c.className = styles.bar!;
      c.dataset.testid = `${p}-scrub-${i}`;
      c.textContent = String(i + 1);
      c.title = `Jump to bar ${i + 1}`;
      c.addEventListener('click', () => engine.seekTo(bar * SEQ_LENGTH));
      scrub.appendChild(c);
      cells.push(c);
    }
    builtBars = bars;
    litBar = -1;
  };

  const paint = (): void => {
    // 0 bars = no chain lane enabled: the song is one repeating bar.
    const bars = engine.arrangement.songBars() || 1;
    if (bars !== builtBars) renderStructure(bars);

    const pos = position();
    const bar = Math.floor(pos / SEQ_LENGTH);
    const step = pos % SEQ_LENGTH;
    readout.textContent = `${bar + 1}.${String(step + 1).padStart(2, '0')}`;

    const cell = bars ? bar % bars : 0;
    if (cell !== litBar) {
      cells[litBar]?.classList.remove(AT_CLASS);
      cells[cell]?.classList.add(AT_CLASS);
      litBar = cell;
    }
  };

  engine.clock.onTick(paint);
  engine.clock.onSeek(paint);
  engine.clock.onStart(paint);
  engine.clock.onStop(paint);
  engine.arrangement.onChange(paint);

  if (!opts.compact) {
    out.push(new Knob({ bus, paramId: 'transport.bpm', label: 'BPM' }).el);
    out.push(new Knob({ bus, paramId: 'transport.swing', label: 'SWING' }).el);
  }

  paint();
  return out;
}

/**
 * Mark a hosting row inert while seeking is refused (slaved / mid-capture).
 * Driven off the three low-frequency hooks that can flip the answer, rather
 * than testing `canSeek()` per tick.
 */
export function bindSeekAvailability(engine: StudioApi, host: HTMLElement): void {
  const refresh = (): void => { host.classList.toggle(styles.off!, !engine.canSeek()); };
  engine.sync.onStatus(refresh);
  engine.recorder.onState(refresh);
  engine.bankRender.onState(refresh);
  refresh();
}

/** Class for a hosting row: the Song panel's dashed-divider variant. */
export const transportRowClass = styles.row!;

/**
 * The "TRANSPORT" launcher (Song panel). Doubles as the section title and opens
 * a non-modal FloatingWindow carrying the full control set — including the
 * Play/Stop, BPM and SWING the compact row deliberately drops. Built lazily and
 * kept alive across closes, exactly like the LIVE FX launcher.
 */
export function createTransportWindowLauncher(
  engine: StudioApi,
  bus: ParamBus,
  bridge: UiBridge,
): HTMLButtonElement {
  const b = djButton('TRANSPORT', 'transport-open');
  // "Opens a new window" glyph (❐, the title-bar window control). aria-hidden —
  // the button's own aria-label carries the meaning for assistive tech.
  const glyph = document.createElement('span');
  glyph.className = songStyles.winGlyph!;
  glyph.textContent = '❐';
  glyph.setAttribute('aria-hidden', 'true');
  b.appendChild(glyph);
  b.setAttribute('aria-label', 'Open TRANSPORT window');

  let win: FloatingWindow | null = null;
  b.addEventListener('click', () => {
    if (win?.isOpen) { win.close(); return; }
    if (!win) {
      win = new FloatingWindow({
        title: 'TRANSPORT',
        testId: 'transport-window',
        onClose: () => b.classList.remove('on'),
      });
      win.body.className += ` ${styles.window!}`;
      for (const c of buildTransportControls(engine, bus, bridge, { testIdPrefix: 'transportw' })) {
        win.body.appendChild(c);
      }
      bindSeekAvailability(engine, win.body);
    }
    win.open();
    b.classList.add('on');
  });
  return b;
}
