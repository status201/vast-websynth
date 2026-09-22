import type { StudioApi } from '../studio-api';
import type { UiBridge } from '../ui-bridge';
import { FloatingWindow } from './floating-window';
import { createDjButton } from './button';
import songStyles from '../styles/song-panel.module.css';
import styles from '../styles/transport-controls.module.css';
import { UI_ICONS } from './ui-icons';
import { effectiveLoopRange } from '../../audio/transport/transport-loop';

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
}

/** Global state class marking the current bar — as the rulers use. */
const AT_CLASS = 'playing';
/** Global state classes for the loop (transport-loop.md REQ-what-the-loop-scrubber-shows) — global for the
 *  same reason as `playing`: E2E has nothing else to select past CSS Modules. */
const LOOP_CLASS = 'loop';
const ANCHOR_CLASS = 'loop-anchor';

/**
 * `[Play/Pause, |◀, bar.step, Loop, scrubber]` — the same set on both surfaces
 * (transport-window.md REQ-one-transport-control-builder).
 *
 * Takes the `UiBridge` because Play must click the *real* header button
 * (transport-window.md REQ-play-pause-is-not-a-second-truth): that is what carries the empty-play hint and the
 * LED blink state machine, and it is the only way the Play buttons can be
 * guaranteed to agree. Pause goes to the clock — the header's click means Stop.
 *
 * Takes no `ParamBus` for the same reason in the other direction: it owns no
 * params, so it cannot mint a second BPM/SWING knob behind the header's back
 * (transport-window.md REQ-transport-is-a-floating-window — the header's copy is the one that knows to
 * disable itself while slaved).
 */
export function buildTransportControls(
  engine: StudioApi,
  bridge: UiBridge,
  opts: TransportControlsOpts = {},
): HTMLElement[] {
  const p = opts.testIdPrefix ?? 'transport';
  const out: HTMLElement[] = [];

  /** Playing: the live step. Stopped: the cue, i.e. where Play will begin —
   *  which after a Pause is the resume point (transport.md REQ-pause-resumes-where-it-stopped). */
  const position = (): number => (engine.clock.playing ? engine.clock.step : engine.clock.cue);

  // `-toggle`, not `-play`: the header's own Play button is `transport-play`,
  // and a default-prefixed instance minting a second one would break every
  // spec that drives the transport by that id.
  const play = createDjButton('Play', `${p}-toggle`);
  play.classList.add(styles.playPause!);
  play.addEventListener('click', () => {
    // Two outcomes, each named by the label the user just read
    // (transport-window.md REQ-pause-and-stop-are-separate-verbs): Pause stays here, Play goes via the header.
    if (engine.clock.playing) engine.clock.pause();
    else bridge.toggleTransport();
  });
  const syncPlay = (): void => {
    const playing = engine.clock.playing;
    play.classList.toggle('on', playing);
    play.textContent = playing ? 'Pause' : 'Play';
    play.title = playing
      ? 'Pause — Play continues from here'
      : engine.clock.paused ? 'Continue from where you paused' : 'Play';
  };
  engine.clock.onStart(syncPlay);
  engine.clock.onStop(syncPlay);
  engine.clock.onSeek(syncPlay); // a seek cancels a pause, which retitles Play
  syncPlay();
  out.push(play);

  // Built empty, then drawn: `djButton` sets `textContent`, which would print
  // the SVG source rather than render it.
  const toStart = createDjButton('', `${p}-tostart`);
  toStart.innerHTML = UI_ICONS.toStart;
  toStart.title = 'Back to bar 1 (Home)';
  toStart.setAttribute('aria-label', 'Back to the start');
  toStart.addEventListener('click', () => engine.seekTo(0));
  out.push(toStart);

  const readout = document.createElement('div');
  readout.className = styles.readout!;
  readout.dataset.testid = `${p}-readout`;
  out.push(readout);

  // Loop sits against the scrubber because that is where its picks land
  // (transport-window.md REQ-loop-lives-on-the-transport-row). Inert while seeking is refused: a wrap is a
  // seek, so an armable loop that cannot wrap would be a lie (transport-loop.md REQ-a-loop-that-cannot-jump-does-not).
  const loopBtn = createDjButton('Loop', `${p}-loop`);
  loopBtn.addEventListener('click', () => {
    if (engine.canSeek()) engine.loop.toggle();
  });
  out.push(loopBtn);

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
      c.addEventListener('click', () => {
        // Loop on turns a click into a pick (transport-loop.md REQ-with-loop-on-a-click-picks-a-bar) — a mode,
        // so its state is drawn on these very cells by paintLoop, not only on
        // the button.
        if (!engine.loop.enabled) engine.seekTo(bar * engine.barTicks);
        else if (engine.canSeek()) engine.loop.pick(bar);
      });
      scrub.appendChild(c);
      cells.push(c);
    }
    builtBars = bars;
    litBar = -1;
    loopKey = '';
    paintLoop();
  };

  /** What the loop paint last drew — so the per-bar arrangement notify, which
   *  also reaches `paintLoop`, costs a string compare when nothing changed. */
  let loopKey = '';

  /**
   * Loop button state, the range on the cells, the anchor and every cell's title
   * (transport-loop.md REQ-a-loop-button-on-both-surfaces/REQ-with-loop-on-a-click-picks-a-bar/REQ-what-the-loop-scrubber-shows). Runs on a loop change, a rebuild and
   * an arrangement change (a shorter chain clamps the range, REQ-the-loop-range-is-limited-to-the-song) — never per
   * tick, and a no-op unless what it would draw differs.
   */
  const paintLoop = (): void => {
    const loop = engine.loop;
    const range = effectiveLoopRange(loop.range, engine.arrangement.songBars());
    const on = loop.enabled;
    const key = `${on}|${range?.start}|${range?.end}|${loop.anchor}|${cells.length}`;
    if (key === loopKey) return;
    loopKey = key;
    loopBtn.classList.toggle('on', on);
    loopBtn.setAttribute('aria-pressed', String(on));
    const span = range
      ? range.start === range.end ? `bar ${range.start + 1}` : `bars ${range.start + 1}–${range.end + 1}`
      : '';
    loopBtn.title = !on
      ? range ? `Loop ${span} again` : 'Loop — then click the first and last bar'
      : range ? `Looping ${span} — click two bars to change, or Loop to stop` : 'Click the first and last bar to loop';
    scrub.classList.toggle(styles.picking!, on);
    scrub.classList.toggle(styles.loopIdle!, !on && range !== null);

    const anchor = loop.anchor;
    cells.forEach((c, i) => {
      c.classList.toggle(LOOP_CLASS, range !== null && i >= range.start && i <= range.end);
      c.classList.toggle(ANCHOR_CLASS, on && anchor === i);
      c.title = !on
        ? `Jump to bar ${i + 1}`
        : anchor === null
          ? `Loop from bar ${i + 1}`
          : `Loop bars ${Math.min(anchor, i) + 1}–${Math.max(anchor, i) + 1}`;
    });
  };

  /**
   * The timeline is one scrolling line (REQ-loop-bars-are-the-songs-bars), so a long song can put the
   * current bar off-screen. Scrolled by hand rather than with `scrollIntoView`,
   * which is free to scroll *ancestors* too and would yank the page. Guarded on
   * a laid-out scroller, so a hidden tab (and jsdom) simply skip it — and it
   * only ever runs on a bar change, never per tick.
   */
  const keepInView = (cell: HTMLElement): void => {
    if (scrub.clientWidth <= 0) return;
    const left = cell.offsetLeft;
    const right = left + cell.offsetWidth;
    if (left < scrub.scrollLeft) scrub.scrollLeft = Math.max(0, left - 2);
    else if (right > scrub.scrollLeft + scrub.clientWidth) {
      scrub.scrollLeft = right - scrub.clientWidth + 2;
    }
  };

  const paint = (): void => {
    // 0 bars = no chain lane enabled: the song is one repeating bar.
    const bars = engine.arrangement.songBars() || 1;
    if (bars !== builtBars) renderStructure(bars);

    const pos = position();
    // The song's own bar, not a fixed 16 (meter.md REQ-bar-ticks-is-the-arrangement-bar-line): in 7/8 bar 2 begins
    // at tick 14, and a readout counting 16s would disagree with the transport.
    const ticks = engine.barTicks;
    const bar = Math.floor(pos / ticks);
    const step = pos % ticks;
    // The SAME wrapped bar the scrubber lights (REQ-a-loop-that-cannot-jump-does-not): computed once, so the
    // number and the lit cell cannot disagree. Printing the absolute bar made a
    // one-bar song count 1.01, 2.01, 3.01 … beside a single lit cell — a bar the
    // song does not have (transport-position.md REQ-the-readout-never-invents-bars, same rule for the rulers).
    const cell = bar % bars;
    readout.textContent = `${cell + 1}.${String(step + 1).padStart(2, '0')}`;

    if (cell !== litBar) {
      cells[litBar]?.classList.remove(AT_CLASS);
      const at = cells[cell];
      at?.classList.add(AT_CLASS);
      litBar = cell;
      if (at) keepInView(at);
    }
  };

  engine.clock.onTick(paint);
  engine.clock.onSeek(paint);
  engine.clock.onStart(paint);
  engine.clock.onStop(paint);
  engine.arrangement.onChange(paint);
  // A chain edit can shorten the song under a range (transport-loop.md REQ-the-loop-range-is-limited-to-the-song).
  engine.arrangement.onChange(paintLoop);
  engine.loop.onChange(paintLoop);

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
  engine.recorder.onPhase(refresh);
  engine.bankRender.onState(refresh);
  refresh();
}

/** Class for a hosting row: the Song panel's dashed-divider variant. */
export const transportRowClass = styles.row!;

/**
 * The "TRANSPORT" launcher (Song panel). Doubles as the section title and opens
 * a non-modal FloatingWindow carrying the same control set as the row, so it
 * keeps working on every other tab. Built lazily and kept alive across closes,
 * exactly like the LIVE FX launcher.
 */
export function createTransportWindowLauncher(
  engine: StudioApi,
  bridge: UiBridge,
): HTMLButtonElement {
  const b = createDjButton('TRANSPORT', 'transport-open');
  // The "opens a new window" glyph, drawn rather than typed (iconography.md).
  // aria-hidden — the button's own aria-label carries the meaning.
  const glyph = document.createElement('span');
  glyph.className = songStyles.winGlyph!;
  glyph.innerHTML = UI_ICONS.popOut;
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
      for (const c of buildTransportControls(engine, bridge, { testIdPrefix: 'transportw' })) {
        win.body.appendChild(c);
      }
      bindSeekAvailability(engine, win.body);
    }
    win.open();
    b.classList.add('on');
  });
  return b;
}
