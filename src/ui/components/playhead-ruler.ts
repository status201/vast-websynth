import type { StudioApi } from '../studio-api';
import type { VisibilityGate } from '../panels/step-panel-scaffold';
import { SEQ_LENGTH } from '../../state/patterns';
import styles from '../styles/playhead-ruler.module.css';

export type RulerLane = 'seq' | 'drum' | 'sampler' | 'motion';

/** Global state class marking the tick the transport is on. */
export const AT_CLASS = 'playing';

export interface PlayheadRuler {
  /**
   * The 16 tick buttons' container. It carries **no grid of its own** — the
   * panel puts its own steps-grid class on it (`drum.cells`, `seq.stepRow`, …),
   * so the ticks inherit that grid's column count and gap and cannot drift out
   * of alignment with the steps below. See transport-position.md.
   */
  readonly cellsEl: HTMLElement;
  /** The "BAR n" readout — place it in the panel's row-label slot. */
  readonly barEl: HTMLElement;
  destroy(): void;
}

/**
 * The transport-position ruler that sits above a machine's step grid
 * (transport-position.md REQ-9). Two jobs, both of which the grid playhead
 * cannot do:
 *
 *  - **Show where the transport is, unconditionally.** The cell highlight is
 *    hidden whenever the edit bank differs from the play bank or the lane is
 *    resting, and each machine's `onStep` is silent while that machine is
 *    switched off and while the transport is stopped — so it answers "is this
 *    bank's step sounding?", not "where are we?". This ruler rides the **clock**
 *    instead and is therefore always truthful.
 *  - **Move the playhead.** A click seeks to that 16th of the current bar. The
 *    grid's own gestures are saturated (step-grid-editing.md REQ-13), which is
 *    exactly why this is a separate target rather than a modifier down there.
 *
 * While stopped it shows the **cue** — the step Play will begin from — not the
 * step playback happened to halt on, so what you see is what Play will do.
 */
export function buildPlayheadRuler(
  api: StudioApi,
  lane: RulerLane,
  gate?: VisibilityGate,
): PlayheadRuler {
  const cellsEl = document.createElement('div');
  cellsEl.dataset.testid = `ruler-${lane}`;
  cellsEl.setAttribute('role', 'group');
  cellsEl.setAttribute('aria-label', 'Transport position');

  const barEl = document.createElement('div');
  barEl.className = styles.bar!;
  barEl.dataset.testid = `ruler-${lane}-bar`;

  const ticks: HTMLButtonElement[] = [];
  for (let i = 0; i < SEQ_LENGTH; i++) {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = i % 4 === 0 ? `${styles.tick!} ${styles.beat!}` : styles.tick!;
    t.dataset.testid = `ruler-${lane}-${i}`;
    t.textContent = i % 4 === 0 ? String(i / 4 + 1) : '';
    t.title = `Move the playhead to step ${i + 1} of this bar`;
    t.addEventListener('click', () => {
      // Seek within the bar currently displayed, so the click lands where the
      // user is looking even when the song is many bars in.
      api.seekTo(Math.floor(position() / SEQ_LENGTH) * SEQ_LENGTH + i);
    });
    ticks.push(t);
    cellsEl.appendChild(t);
  }

  /** Playing: the live step. Stopped: the cue, i.e. where Play will begin. */
  const position = (): number => (api.clock.playing ? api.clock.step : api.clock.cue);

  let paintedCol = -1;
  let paintedBar = -1;

  const paint = (): void => {
    const pos = position();
    const col = pos % SEQ_LENGTH;
    if (col !== paintedCol) {
      // The global `playing` state class, as StepButton's playhead uses — so
      // e2e can find it despite CSS Modules hashing every other class name.
      ticks[paintedCol]?.classList.remove(AT_CLASS);
      ticks[col]?.classList.add(AT_CLASS);
      paintedCol = col;
    }
    const bar = Math.floor(pos / SEQ_LENGTH);
    if (bar !== paintedBar) {
      paintedBar = bar;
      barEl.innerHTML = `Bar <b>${bar + 1}</b>`;
    }
  };

  // Cheap enough to run per tick (at most two class writes), but pointless while
  // the panel is off screen — the gate is the same one wirePlayhead obeys, and
  // revealing replays the live position rather than a stale column
  // (transport-position.md REQ-10).
  const sync = (): void => { if (!gate || gate.shown) paint(); };

  const unsubs: (() => void)[] = [
    api.clock.onTick(sync),
    api.clock.onSeek(sync),
    api.clock.onStart(sync),
    api.clock.onStop(sync),
  ];
  if (gate) unsubs.push(gate.whenShown(paint));

  // Whether a seek is even allowed moves under us (sync mode, a capture starting
  // or ending). All three are low-frequency, so refresh the affordance from them
  // rather than testing canSeek() on every tick.
  const refreshEnabled = (): void => {
    cellsEl.classList.toggle(styles.off!, !api.canSeek());
  };
  unsubs.push(
    api.sync.onStatus(refreshEnabled),
    api.recorder.onState(refreshEnabled),
    api.bankRender.onState(refreshEnabled),
  );
  refreshEnabled();
  paint();

  return {
    cellsEl,
    barEl,
    destroy(): void { for (const u of unsubs) u(); },
  };
}
