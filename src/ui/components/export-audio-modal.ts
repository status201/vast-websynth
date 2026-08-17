import { Modal } from './modal';
import { Dropdown } from './dropdown';
import { createButton } from './button';
import type { StudioApi } from '../studio-api';
import { FALLBACK_BARS, MAX_RUNS, type ExportFormat } from '../../audio/recorder/recorder-controller';
import switchStyles from '../styles/switch.module.css';
import segmentedStyles from '../styles/segmented.module.css';
import dialogStyles from '../styles/dialog.module.css';
import rowStyles from '../styles/export-song-modal.module.css';
import styles from '../styles/export-audio-modal.module.css';

/**
 * Options for rendering the song to audio (audio-export.md REQ-9), and then the
 * render's own progress surface (REQ-10).
 *
 * Confirming deliberately does **not** close it. Export runs in real time — ten
 * runs of a long song is a ten-minute wait — and a dialog that vanishes for that
 * long with nothing in its place reads as a crash.
 *
 * Deliberately a *separate* modal from `export-song-modal.ts`, which chooses
 * between a `.json` song and a `.zip` project — a different flow with a
 * different output. Sharing one modal would mean one dialog whose controls half
 * apply, which is exactly the "depends on hidden state" ADR-014 forbids.
 */

/** How long the "done" confirmation shows before the modal closes itself. */
const DONE_MS = 900;

const RUN_OPTIONS = Array.from({ length: MAX_RUNS }, (_, i) => String(i + 1));

/** `1 m 04 s` / `48 s` — a rough duration, so it reads as an estimate. */
function describeSeconds(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  return `${Math.floor(total / 60)} m ${String(total % 60).padStart(2, '0')} s`;
}

export function openExportAudioModal(engine: StudioApi, defaultFormat: ExportFormat): void {
  let fmt: ExportFormat = defaultFormat;
  let runs = 1;
  let tailBar = true; // checked by default (REQ-3) — humans want the tail
  let running = false;

  // The same three AUDIBLE lanes the recorder measures, so the length quoted
  // here can never describe a different song than the one that gets rendered.
  const songBars = engine.arrangement.songBars(['seq', 'drum', 'sampler']) || FALLBACK_BARS;
  const sixteenthS = engine.clock.sixteenthDuration();
  const busyReason = engine.recorder.phase === 'idle'
    ? null
    : 'A recording is in progress — save or discard it first';

  const modal = new Modal({
    title: 'Export audio',
    // A stray backdrop click must not abandon a ten-minute render. Escape still
    // closes, and closing mid-render cancels it (below), so the modal can
    // neither outlive the render nor be outlived by it.
    dismissOnBackdrop: false,
    onClose: () => {
      unsubs.forEach((u) => u());
      unsubs.length = 0;
      window.clearTimeout(doneTimer);
      if (running) engine.recorder.cancelExport();
    },
  });
  modal.body.dataset.testid = 'export-audio-modal';
  modal.body.classList.add(styles.body!);

  const unsubs: Array<() => void> = [];
  let doneTimer: number | undefined;

  // ---- options view ----
  const options = document.createElement('div');
  modal.body.appendChild(options);

  const runsRow = document.createElement('div');
  runsRow.className = rowStyles.fmtRow!;
  const runsLabel = document.createElement('span');
  runsLabel.className = rowStyles.fmtLabel!;
  runsLabel.textContent = 'Runs:';
  const runsDd = new Dropdown(RUN_OPTIONS, '1');
  runsDd.el.dataset.testid = 'export-audio-runs';
  runsDd.onChange((v) => { runs = Number(v) || 1; render(); });
  runsRow.append(runsLabel, runsDd.el);
  options.appendChild(runsRow);

  const tailRow = document.createElement('label');
  tailRow.className = styles.check!;
  const tailBox = document.createElement('input');
  tailBox.type = 'checkbox';
  tailBox.checked = tailBar;
  tailBox.dataset.testid = 'export-audio-tail';
  tailBox.addEventListener('change', () => { tailBar = tailBox.checked; render(); });
  const tailText = document.createElement('span');
  tailText.textContent = 'Add an empty bar at the end for reverb/delay tails';
  tailRow.append(tailBox, tailText);
  options.appendChild(tailRow);

  // The cost of the choice, before you commit to it: ten runs of a long song is
  // a ten-minute real-time render, which must not be a surprise.
  const lengthNote = document.createElement('p');
  lengthNote.className = rowStyles.note!;
  lengthNote.dataset.testid = 'export-audio-length';
  options.appendChild(lengthNote);

  // Format last, immediately above the actions: it is the one choice that reads
  // as part of the verb ("Export as WAV"), while Runs and the tail bar describe
  // what gets rendered. Grouping it with the button it renames also stops it and
  // the Song tab's WAV/MP3 switch reading as one setting.
  const fmtRow = document.createElement('div');
  fmtRow.className = `${rowStyles.fmtRow!} ${styles.fmtLast!}`;
  const fmtLabel = document.createElement('span');
  fmtLabel.className = rowStyles.fmtLabel!;
  fmtLabel.textContent = 'Format:';
  const fmtSel = document.createElement('div');
  fmtSel.className = segmentedStyles.root!;
  const fmtBtns: HTMLButtonElement[] = [];
  (['wav', 'mp3'] as ExportFormat[]).forEach((f) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = f.toUpperCase();
    b.dataset.testid = `export-audio-fmt-${f}`;
    b.addEventListener('click', () => { fmt = f; render(); });
    fmtBtns.push(b);
    fmtSel.appendChild(b);
  });
  fmtRow.append(fmtLabel, fmtSel);
  options.appendChild(fmtRow);

  // ---- progress view (REQ-10) ----
  const progress = document.createElement('div');
  progress.className = styles.progress!;
  progress.hidden = true;

  const status = document.createElement('p');
  status.className = styles.status!;
  status.dataset.testid = 'export-audio-status';

  // Determinate: the length is known exactly up front, and over minutes "how
  // much longer" is the actual question a spinner refuses to answer.
  const track = document.createElement('div');
  track.className = styles.track!;
  track.dataset.testid = 'export-audio-progress';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('div');
  fill.className = styles.fill!;
  track.appendChild(fill);

  progress.append(status, track);
  modal.body.appendChild(progress);

  // ---- actions ----
  const actions = document.createElement('div');
  actions.className = dialogStyles.actions!;
  const cancelBtn = createButton({
    label: 'Cancel',
    className: switchStyles.root!,
    testId: 'export-audio-cancel',
    onClick: () => modal.close(),
  });
  const confirmBtn = createButton({
    label: 'Export',
    className: switchStyles.root!,
    testId: 'export-audio-confirm',
    onClick: () => start(),
  });
  // Cancel is real or it is not there: mid-render this aborts the render, and
  // during the encode there is nothing left to abort, so it goes away.
  const abortBtn = createButton({
    label: 'Cancel',
    className: switchStyles.root!,
    testId: 'export-audio-abort',
    onClick: () => modal.close(), // onClose cancels the render
  });
  abortBtn.hidden = true;
  actions.append(cancelBtn, confirmBtn, abortBtn);
  modal.body.appendChild(actions);

  const totalBars = (): number => songBars * runs + (tailBar ? 1 : 0);

  function paintProgress(): void {
    const phase = engine.recorder.phase;
    if (phase === 'encoding') {
      status.textContent = 'Preparing your download…';
      fill.style.width = '100%';
      track.classList.add(styles.indeterminate!); // lamejs reports no progress
      track.removeAttribute('aria-valuenow');
      abortBtn.hidden = true;
      return;
    }
    const ratio = engine.recorder.exportProgress();
    const bars = songBars * runs;
    const at = Math.min(bars, Math.floor(ratio * bars) + 1);
    status.textContent = `Rendering… bar ${at} of ${bars}`;
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    track.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  function start(): void {
    running = true;
    options.hidden = true;
    progress.hidden = false;
    cancelBtn.hidden = true;
    confirmBtn.hidden = true;
    abortBtn.hidden = false;
    paintProgress();
    // The tick is the only thing that moves the playhead, so it is exactly the
    // right repaint clock — no rAF loop, no polling.
    unsubs.push(engine.clock.onTick(paintProgress));
    unsubs.push(engine.recorder.onPhase((p) => {
      if (p === 'encoding') { paintProgress(); return; }
      if (p !== 'idle') return;
      // Back to idle with the render finished: the file is written. The
      // browser's own download is the receipt, so a dialog the user has to
      // dismiss to acknowledge what they asked for buys nothing.
      running = false;
      status.textContent = 'Done — check your downloads.';
      track.classList.remove(styles.indeterminate!);
      doneTimer = window.setTimeout(() => modal.close(), DONE_MS);
    }));
    engine.recorder.exportSong(fmt, { runs, tailBar });
  }

  function render(): void {
    for (const b of fmtBtns) b.classList.toggle('active', b.dataset.testid === `export-audio-fmt-${fmt}`);
    // The song's own bar, so a 7/8 export is estimated in 7/8 bars (meter.md REQ-7).
    const seconds = totalBars() * engine.barTicks * sixteenthS;
    const runsPart = runs > 1 ? `${songBars} bars × ${runs}` : `${songBars} bars`;
    lengthNote.textContent =
      `${runsPart}${tailBar ? ' + 1 tail bar' : ''} — about ${describeSeconds(seconds)}, rendered in real time.`;
    // The button that writes names the format (REQ-8).
    confirmBtn.textContent = `Export as ${fmt.toUpperCase()}`;
    confirmBtn.disabled = busyReason !== null;
    confirmBtn.title = busyReason ?? `Render the song and download it as ${fmt.toUpperCase()}`;
  }

  render();
  modal.open();
  confirmBtn.focus();
}
