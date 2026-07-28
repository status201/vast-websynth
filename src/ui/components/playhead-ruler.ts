import type { StudioApi } from '../studio-api';
import type { VisibilityGate } from '../panels/step-panel-scaffold';
import { SEQ_LENGTH, BANK_LABELS } from '../../state/patterns';
import styles from '../styles/playhead-ruler.module.css';

export type RulerLane = 'seq' | 'drum' | 'sampler' | 'motion';

/** Global state class marking the live step. Only ever set while PLAYING. */
export const AT_CLASS = 'playing';
/**
 * Global state class marking the cue — where Play will begin (transport-position.md
 * REQ-14). Global for the same reason `AT_CLASS` is: every other class here is
 * CSS-Module hashed, so E2E has nothing else to select. The name is already a
 * global state class in this app (the Play button's demo cue).
 */
export const CUE_CLASS = 'cue';

/**
 * The bank accessors behind the readout (REQ-15), threaded in from `laneHooks` so
 * the letter uses the SAME source as the `BankBar` beside it and the two can
 * never disagree. Passed in rather than imported because `laneHooks` lives in the
 * scaffold, which imports *this* module.
 *
 * This is the **edit** bank, deliberately. The readout only names a bank while
 * nothing is chained, and a disabled lane plays its edit bank (`Arrangement`'s
 * `resolveLane`) — so edit *is* what sounds. `Arrangement.<lane>PlayBank` would
 * be the semantic-looking choice and the wrong one: it is a cached field
 * recomputed only on tick / seek / chain change, so it reads stale after a bank
 * click while the transport is stopped.
 */
export interface RulerLaneHooks {
  getBank(): number;
  onBankChange(fn: () => void): () => void;
}

export interface PlayheadRuler {
  /**
   * The 16 tick buttons' container. It carries **no grid of its own** — the
   * panel puts its own steps-grid class on it (`drum.cells`, `seq.stepRow`, …),
   * so the ticks inherit that grid's column count and gap and cannot drift out
   * of alignment with the steps below. See transport-position.md.
   */
  readonly cellsEl: HTMLElement;
  /**
   * The position readout — place it in the panel's row-label slot. `BANK A` with
   * no stepper while nothing is chained, `‹ BAR n/N ›` once bars exist (REQ-15,
   * REQ-16).
   */
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
 * Two marks, never one (REQ-14): a solid **playhead** at the live step while
 * playing, and a **cue** ring at the step Play will begin from. Conflating them
 * meant a stopped ruler looked exactly like a running one, so clicking a tick
 * gave no "starts here" feedback at all.
 */
export function buildPlayheadRuler(
  api: StudioApi,
  lane: RulerLane,
  gate?: VisibilityGate,
  hooks?: RulerLaneHooks,
): PlayheadRuler {
  const cellsEl = document.createElement('div');
  cellsEl.dataset.testid = `ruler-${lane}`;
  cellsEl.setAttribute('role', 'group');
  cellsEl.setAttribute('aria-label', 'Transport position');

  // --- Readout: `BANK A` (nothing chained) or `‹ BAR n/N ›` (REQ-15/REQ-16) ---
  const barEl = document.createElement('div');
  barEl.className = styles.barGroup!;

  const mkNav = (glyph: string, delta: -1 | 1): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = styles.barNav!;
    b.dataset.testid = `ruler-${lane}-bar-${delta < 0 ? 'prev' : 'next'}`;
    b.textContent = glyph;
    b.addEventListener('click', () => {
      const pos = position();
      const bars = api.arrangement.songBars();
      // Preserve the 16th — the whole point of this control, since Shift+arrows
      // zero it (REQ-16). Clamp inside the song rather than wandering past it.
      const bar = Math.floor(pos / SEQ_LENGTH) + delta;
      const max = bars > 0 ? bars - 1 : bar;
      api.seekTo(Math.min(Math.max(0, bar), max) * SEQ_LENGTH + (pos % SEQ_LENGTH));
    });
    return b;
  };
  const prevBtn = mkNav('‹', -1);
  const nextBtn = mkNav('›', 1);
  const label = document.createElement('div');
  label.className = styles.bar!;
  label.dataset.testid = `ruler-${lane}-bar`;
  barEl.append(prevBtn, label, nextBtn);

  const ticks: HTMLButtonElement[] = [];
  for (let i = 0; i < SEQ_LENGTH; i++) {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = i % 4 === 0 ? `${styles.tick!} ${styles.beat!}` : styles.tick!;
    t.dataset.testid = `ruler-${lane}-${i}`;
    // Only the beat columns are labelled — sixteen numerals do not fit at tick
    // width — so the title names the beat too, not a second numbering (REQ-17).
    t.textContent = i % 4 === 0 ? String(i / 4 + 1) : '';
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

  let paintedAt = -1;
  let paintedCue = -1;
  let paintedLabel = '';
  let paintedNav: boolean | null = null;

  const paint = (): void => {
    // The live playhead exists only while playing: a stopped strip must not look
    // like a running one (REQ-14).
    const at = api.clock.playing ? api.clock.step % SEQ_LENGTH : -1;
    if (at !== paintedAt) {
      ticks[paintedAt]?.classList.remove(AT_CLASS);
      ticks[at]?.classList.add(AT_CLASS);
      paintedAt = at;
    }
    // The cue always shows where Play/resume begins — including while playing,
    // where it is the mark Stop → Play will return to.
    const cue = api.clock.cue % SEQ_LENGTH;
    if (cue !== paintedCue) {
      ticks[paintedCue]?.classList.remove(CUE_CLASS);
      ticks[cue]?.classList.add(CUE_CLASS);
      paintedCue = cue;
    }

    // Readout. `songBars() === 0` means no lane is chained, so the song is one
    // bank looping and a bar number would be fiction (REQ-15).
    const bars = api.arrangement.songBars();
    let text: string;
    if (bars === 0) {
      const bank = hooks ? BANK_LABELS[hooks.getBank()] ?? '?' : '?';
      text = `Bank <b>${bank}</b>`;
    } else {
      const bar = Math.floor(position() / SEQ_LENGTH) % bars;
      text = `Bar <b>${bar + 1}</b>/${bars}`;
    }
    if (text !== paintedLabel) {
      paintedLabel = text;
      label.innerHTML = text;
    }
    const showNav = bars > 0;
    if (showNav !== paintedNav) {
      paintedNav = showNav;
      prevBtn.hidden = !showNav;
      nextBtn.hidden = !showNav;
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
    // The readout's mode and bank letter live outside the clock: enabling a chain
    // flips BANK -> BAR, and the play bank moves with the arrangement and with the
    // user's own bank clicks. Both are low-frequency (never per tick).
    api.arrangement.onChange(sync),
  ];
  if (hooks) unsubs.push(hooks.onBankChange(sync));
  if (gate) unsubs.push(gate.whenShown(paint));

  // Whether a seek is even allowed moves under us (sync mode, a capture starting
  // or ending). All three are low-frequency, so refresh the affordance from them
  // rather than testing canSeek() on every tick.
  const refreshEnabled = (): void => {
    const can = api.canSeek();
    cellsEl.classList.toggle(styles.off!, !can);
    barEl.classList.toggle(styles.off!, !can);
    // Don't keep promising a move that is refused (REQ-17). The buttons stay
    // un-`disabled`: the refusal is Engine.seekTo's silent no-op, not the DOM's.
    const why = 'Moving the playhead is unavailable right now';
    ticks.forEach((t, i) => {
      t.setAttribute('aria-disabled', String(!can));
      t.title = can ? `Move the playhead to beat ${Math.floor(i / 4) + 1} of this bar` : why;
    });
    for (const [b, dir] of [[prevBtn, 'previous'], [nextBtn, 'next']] as const) {
      b.setAttribute('aria-disabled', String(!can));
      b.title = can ? `Move the playhead to the ${dir} bar, same step` : why;
    }
  };
  unsubs.push(
    api.sync.onStatus(refreshEnabled),
    api.recorder.onPhase(refreshEnabled),
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
