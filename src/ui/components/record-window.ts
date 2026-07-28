import type { StudioApi } from '../studio-api';
import type { ExportFormat, RecorderPhase } from '../../audio/recorder/recorder-controller';
import { FloatingWindow } from './floating-window';
import { confirmDialog } from './dialog';
import switchStyles from '../styles/switch.module.css';
import segmentedStyles from '../styles/segmented.module.css';
import songStyles from '../styles/song-panel.module.css';
import styles from '../styles/record-window.module.css';

/**
 * The free-form recorder's floating transport (record-window.md).
 *
 * A pure view over `RecorderController.phase` — it holds no capture state of its
 * own, so it cannot disagree with the recorder. Built like TRANSPORT and LIVE FX:
 * one lazily-created window kept alive across closes, driven by a launcher that
 * doubles as the Song panel's Record button.
 */

/** How often the elapsed readout re-reads the recorder. Faster than the 1 s it
 *  displays, so the shown second turns over promptly rather than up to a second
 *  late; the write itself is skipped unless the string actually changed. */
const TICK_MS = 200;

export interface RecordWindowLauncher {
  /** The Song-panel button (also the help-badge anchor, testid `song-record`). */
  el: HTMLButtonElement;
  /** Open/close from anywhere — what `UiBridge.toggleRecordWindow` binds to. */
  toggle(): void;
}

/** `m:ss`. Seconds precision is enough for a take (record-window.md REQ-4). */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function createRecordWindowLauncher(
  engine: StudioApi,
  defaultFormat: () => ExportFormat,
): RecordWindowLauncher {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${switchStyles.root!} ${songStyles.djBtn!}`;
  b.textContent = 'Record…';
  b.dataset.testid = 'song-record';
  b.title = 'Open the Record window (Shift+R)';
  const glyph = document.createElement('span');
  glyph.className = songStyles.winGlyph!;
  glyph.textContent = '❐';
  glyph.setAttribute('aria-hidden', 'true');
  b.appendChild(glyph);
  b.setAttribute('aria-label', 'Open Record window');

  let win: FloatingWindow | null = null;
  /** Per-window format override, seeded from the Song tab's global default and
   *  never written back (audio-export.md REQ-9). */
  let fmt: ExportFormat = defaultFormat();
  let timer: number | undefined;
  let lastTimerText = '';

  // ---- window contents (built once, with the window) ----
  const status = document.createElement('div');
  status.className = styles.status!;
  status.dataset.testid = 'record-status';

  const dot = document.createElement('span');
  dot.className = styles.dot!;
  dot.setAttribute('aria-hidden', 'true');
  const statusText = document.createElement('span');
  status.append(dot, statusText);

  const timerEl = document.createElement('div');
  timerEl.className = styles.timer!;
  timerEl.dataset.testid = 'record-timer';
  timerEl.textContent = '0:00';

  const mkBtn = (testid: string): HTMLButtonElement => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `${switchStyles.root!} ${styles.action!}`;
    el.dataset.testid = testid;
    return el;
  };

  // One button across Record / Pause / Resume. ADR-014 law 2 holds because the
  // outcome is written on its face, exactly as the Play/Stop button's is.
  const toggleBtn = mkBtn('record-toggle');
  const stopBtn = mkBtn('record-stop');
  stopBtn.textContent = 'Stop';
  const saveBtn = mkBtn('record-save');
  const discardBtn = mkBtn('record-discard');
  discardBtn.textContent = 'Discard';
  discardBtn.classList.add(styles.danger!);

  const fmtSel = document.createElement('div');
  // `.fmt` centres it and lets it shrink to its two buttons — the window body is
  // a column flex, which would otherwise stretch it edge to edge.
  fmtSel.className = `${segmentedStyles.root!} ${styles.fmt!}`;
  const fmtBtns: HTMLButtonElement[] = [];
  (['wav', 'mp3'] as ExportFormat[]).forEach((f) => {
    const fb = document.createElement('button');
    fb.type = 'button';
    fb.textContent = f.toUpperCase();
    fb.dataset.testid = `record-fmt-${f}`;
    fb.addEventListener('click', () => { fmt = f; render(); });
    fmtBtns.push(fb);
    fmtSel.appendChild(fb);
  });

  toggleBtn.addEventListener('click', () => {
    const p = engine.recorder.phase;
    if (p === 'recording') engine.recorder.pauseManual();
    else if (p === 'paused') engine.recorder.resumeManual();
    else engine.recorder.startManual();
  });
  stopBtn.addEventListener('click', () => engine.recorder.stopManual());
  saveBtn.addEventListener('click', () => { void engine.recorder.saveTake(fmt); });
  discardBtn.addEventListener('click', () => engine.recorder.discardTake());

  // ---- rendering ----

  const paintTimer = (): void => {
    // An export drives the same recorder, but its length is not *your* take —
    // showing it here would be a timer counting up for a recording you don't have.
    const secs = engine.recorder.isExporting() ? 0 : engine.recorder.capturedSeconds();
    const text = formatElapsed(secs);
    if (text === lastTimerText) return; // guarded DOM write (runtime-performance)
    lastTimerText = text;
    timerEl.textContent = text;
  };

  /** Runs only while the window is open AND capturing — a closed window costs
   *  nothing, and the value is derived, so a reopen is instantly correct. */
  const syncTimer = (): void => {
    const wanted = (win?.isOpen ?? false) && engine.recorder.phase === 'recording';
    if (wanted && timer === undefined) timer = window.setInterval(paintTimer, TICK_MS);
    else if (!wanted && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };

  const PHASE_TEXT: Record<RecorderPhase, string> = {
    idle: 'Ready',
    recording: 'REC',
    paused: 'PAUSED — the transport is still playing',
    review: 'captured',
    // An MP3 of a long take spends seconds in lamejs. Reporting that as `idle`
    // left the window looking like it had stopped responding.
    encoding: 'Preparing your download…',
  };

  function render(): void {
    const phase = engine.recorder.phase;
    const reviewing = phase === 'review';
    const encoding = phase === 'encoding';
    const f = fmt.toUpperCase();

    // An Export Song pass moves the SAME phases, so without this the window
    // would read "REC" with a climbing timer for a capture that is not the
    // user's take and that none of these buttons can touch (REQ-11).
    const exporting = engine.recorder.isExporting();
    status.dataset.phase = exporting ? 'busy' : phase;
    statusText.textContent = exporting ? 'Exporting the song…' : PHASE_TEXT[phase];
    // Class off the moment it stops being true — the pulse must never outlive
    // the capture it is reporting (record-window.md REQ-6).
    dot.classList.toggle(styles.live!, phase === 'recording' && !exporting);
    paintTimer();
    syncTimer();

    // Encoding keeps the review pair on screen but inert, so the window neither
    // jumps layout nor offers an action that would race the encode — but only
    // for a take of the user's. An export's encode is not one, so it keeps the
    // Record/Stop pair (disabled) rather than offering Save/Discard for a
    // buffer they never made.
    const reviewPair = !exporting && (reviewing || encoding);
    toggleBtn.hidden = reviewPair;
    stopBtn.hidden = reviewPair;
    saveBtn.hidden = !reviewPair;
    discardBtn.hidden = !reviewPair;
    saveBtn.disabled = encoding;
    discardBtn.disabled = encoding;

    toggleBtn.textContent = exporting
      ? 'Record'
      : phase === 'recording' ? 'Pause' : phase === 'paused' ? 'Resume' : 'Record';
    toggleBtn.classList.toggle('on', phase === 'recording' && !exporting);
    // One RecorderNode, one transport: an export owns both. Say so rather than
    // being a button whose click does nothing (REQ-11).
    toggleBtn.disabled = exporting;
    toggleBtn.title = exporting
      ? 'Busy exporting the song — wait for that render to finish'
      : phase === 'recording'
        ? 'Pause the RECORDER (the transport keeps playing)'
        : phase === 'paused'
          ? 'Resume recording — the paused stretch is left out of the take'
          : 'Start recording (starts the transport if it is stopped)';
    // Not `phase === 'idle'`: during an export the phase is `recording`, but
    // there is no take of yours to stop and `stopManual` would refuse anyway.
    stopBtn.disabled = phase === 'idle' || exporting;
    stopBtn.title = exporting
      ? 'Busy exporting the song — wait for that render to finish'
      : 'End the take — nothing is written until you save it';

    saveBtn.textContent = `Save as ${f}`;
    saveBtn.title = `Encode and download this take as ${f}`;
    discardBtn.title = 'Throw this take away';
    for (const fb of fmtBtns) {
      fb.classList.toggle('active', fb.dataset.testid === `record-fmt-${fmt}`);
    }

    // REQ-7 — a take running behind a closed window. An export is not one, so
    // it must not light the launcher either (REQ-11).
    b.classList.toggle('on', engine.recorder.isCapturing() && !exporting);
  }

  // Subscribed by the LAUNCHER, not the window, so the button keeps reporting a
  // capture running behind a closed window (REQ-7).
  engine.recorder.onPhase(render);

  const ensure = (): FloatingWindow => {
    if (win) return win;
    win = new FloatingWindow({
      title: 'RECORD',
      testId: 'record-window',
      // Every window shares one default position and z-index with no
      // bring-to-front, so a fourth would open exactly on top of the other
      // three (floating-window.md). Offset it.
      initial: { left: Math.max(24, Math.round(window.innerWidth / 2 - 220)), top: 148 },
      onClose: () => { syncTimer(); },
      // Supplied unconditionally, but a no-op while idle: an idle window must
      // close instantly rather than making you dismiss a dialog for nothing.
      confirmClose: async () => {
        if (engine.recorder.phase === 'idle') return true;
        const ok = await confirmDialog({
          title: 'Discard recording?',
          message: engine.recorder.phase === 'review'
            ? 'This take has not been saved. Closing throws it away.'
            : 'A recording is in progress. Closing stops it and throws it away.',
          detail: 'Save it first if you want to keep it.',
          confirmLabel: 'Discard',
          danger: true,
        });
        if (ok) engine.recorder.discardTake();
        return ok;
      },
    });
    win.body.className += ` ${styles.window!}`;
    const row = document.createElement('div');
    row.className = styles.row!;
    row.append(status, timerEl, toggleBtn, stopBtn, saveBtn, discardBtn);
    win.body.append(row, fmtSel);
    return win;
  };

  const toggle = (): void => {
    const w = ensure();
    if (w.isOpen) { w.close(); return; } // may be vetoed by confirmClose
    // Only seed from the global default when there is nothing in flight to
    // contradict — reopening mid-take must not silently change the format.
    if (engine.recorder.phase === 'idle') fmt = defaultFormat();
    w.open();
    render();
  };

  b.addEventListener('click', toggle);
  render();
  return { el: b, toggle };
}
