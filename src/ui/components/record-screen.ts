/**
 * The sample studio's Record screen (sample-recorder.md
 * REQ-the-record-screen-shows-every-state): the live take, the input meter, the
 * big record button, the timer, the count-in and the take bound.
 *
 * One object per showing. It owns everything the screen opens — the mic
 * session, the meter's animation frame, the time watch, the count-in's beat
 * listener — and `destroy()` releases all of it. The studio asks it only two
 * things: what `state` it is in (the close guard) and to `press()` (the `R` key).
 */
import recStyles from '../styles/record-sound.module.css';
import type { StudioApi } from '../studio-api';
import type { Metronome } from '../../audio/metronome';
import type { StudioTransport } from './studio-transport';
import type { CapturedAudio } from '../../audio/recorder/node';
import { openMicSession, MicCaptureError, type MicSession } from '../../audio/recorder/mic-capture';
import { capturedFrames, crop } from '../../audio/recorder/buffer-dsp';
import { createButton } from './button';
import { UI_ICONS } from './ui-icons';
import { el, fitCanvas, drawMidline, fmtTime, waveColours } from './studio-kit';

/** A take stops itself here (REQ-a-take-is-bounded). Sizes memory, not trust. */
export const MAX_TAKE_SECONDS = 120;
/** "2:00" — the take bound as the timer shows it. */
const TAKE_LIMIT_LABEL = fmtTime(MAX_TAKE_SECONDS).replace(/\.0$/, '');
/** The input meter's clip light (REQ-the-mic-opens-with-the-studio): −0.5 dBFS. */
const CLIP_LEVEL = Math.pow(10, -0.5 / 20);
/** How often the screen re-reads time (the timer, the count, the bound). */
const WATCH_MS = 50;

export type RecState = 'opening' | 'ready' | 'counting' | 'recording' | 'stopping' | 'error';

export interface RecordScreenDeps {
  engine: StudioApi;
  metronome: Metronome;
  transport: Pick<StudioTransport, 'onHeardBeat'>;
  /** Already emptied by the studio; the screen fills them. */
  screen: HTMLElement;
  footer: HTMLElement;
  /** Shown in place of the Ready line — e.g. "Nothing was recorded". */
  message?: string;
  /** The Count-in box's remembered state (session memory, never persisted). */
  countIn: { get(): boolean; set(on: boolean): void };
  /** A discarded take on offer (REQ-a-discarded-take-can-be-restored), or null. */
  restore: { seconds: number; onRestore(): void } | null;
  /** Cancel: the studio's guarded close. */
  onCancel(): void;
  /** A take came in, pre-roll already cropped. */
  onTake(audio: CapturedAudio, reason: string): void;
  /** A take came in empty — the studio shows the screen again with a message. */
  onNothing(): void;
}

export interface RecordScreen {
  readonly state: RecState;
  /** The record button, pressed — also what `R` does. */
  press(): void;
  destroy(): void;
}

function errorText(code: string): string {
  switch (code) {
    case 'insecure-context':
      return 'Microphone needs HTTPS or localhost. The network/LAN address is plain HTTP and is blocked — open the app on the host machine via http://localhost, or serve it over HTTPS.';
    case 'denied':
      return "Microphone permission was blocked. Allow mic access in your browser's site settings, then try again.";
    case 'no-device':
      return 'No microphone was found. Connect one and try again.';
    case 'unsupported':
      return "This browser can't record audio.";
    default:
      return 'Could not start the microphone. Try again.';
  }
}

export function buildRecordScreen(deps: RecordScreenDeps): RecordScreen {
  const { engine, metronome, screen, footer } = deps;
  let state: RecState = 'opening';
  let session: MicSession | null = null;
  /** Count-in: the context time the take really starts at. */
  let captureAt: number | null = null;
  let meterRaf = 0;
  let watchTimer = 0;
  /** Set by `destroy()`: anything still in flight (a mic prompt, a final batch) builds nothing. */
  let destroyed = false;

  screen.dataset.testid = 'rec-screen-record';
  screen.classList.remove(recStyles.recording!);

  if (deps.restore) {
    const banner = el('div', recStyles.banner);
    banner.append(el('span', undefined, `Your last recording (${deps.restore.seconds.toFixed(1)} s) was discarded.`));
    banner.append(createButton({ label: 'Restore', testId: 'rec-restore', onClick: deps.restore.onRestore }));
    screen.appendChild(banner);
  }

  // The take's envelope, growing live while it records.
  const live = el('canvas', recStyles.liveWave);
  screen.appendChild(live);

  const meterRow = el('div', recStyles.meterRow);
  meterRow.dataset.testid = 'mic-meter';
  const meterLabel = el('span', recStyles.meterLabel, 'Input');
  // The scale is the meter's own gradient; a cover slides off it from the
  // right, so the colour under the level is the colour of that level.
  const meter = el('div', recStyles.meter);
  const meterCover = el('div', recStyles.meterCover);
  meter.appendChild(meterCover);
  const meterDb = el('span', recStyles.meterDb, '−∞ dB');
  const clip = el('span', recStyles.clip, 'Clip');
  clip.title = 'Lights when the input reaches full scale — move away or turn the input down.';
  meterRow.append(meterLabel, meter, meterDb, clip);
  screen.appendChild(meterRow);

  const recArea = el('div', recStyles.recArea);
  const recBtn = el('button', recStyles.recBtn);
  recBtn.type = 'button';
  recBtn.dataset.testid = 'mic-record-toggle';
  const recFace = el('span', recStyles.recFace);
  const recLabel = el('span', recStyles.recLabel, 'Record');
  recBtn.append(recFace, recLabel);
  const timer = el('div', recStyles.timer);
  timer.dataset.testid = 'mic-timer';
  const stateLine = el('div', recStyles.stateLine);
  stateLine.dataset.testid = 'mic-state';
  recArea.append(recBtn, timer, stateLine);
  screen.appendChild(recArea);

  const countRow = el('label', recStyles.countRow);
  const countBox = el('input');
  countBox.type = 'checkbox';
  countBox.dataset.testid = 'mic-countin';
  countBox.checked = deps.countIn.get();
  countBox.addEventListener('change', () => deps.countIn.set(countBox.checked));
  countRow.append(countBox, el('span', undefined, 'Count-in: one bar on the click, then record from the downbeat'));
  screen.appendChild(countRow);

  screen.appendChild(el('div', recStyles.tip,
    'Tip: wear headphones if you record while the song plays — otherwise the mic hears the speakers too.'));

  let retry: HTMLButtonElement | null = null;
  footer.append(el('span', recStyles.footSpacer), createButton({
    label: 'Cancel',
    testId: 'mic-cancel',
    onClick: () => deps.onCancel(),
  }));

  /** Repaint the button, the timer and the state line from `state`. */
  const paint = (count?: number): void => {
    recBtn.dataset.state = state;
    recBtn.disabled = state === 'opening' || state === 'stopping' || state === 'error';
    screen.classList.toggle(recStyles.recording!, state === 'recording');
    recFace.replaceChildren();
    switch (state) {
      case 'opening':
        recFace.innerHTML = UI_ICONS.record;
        recLabel.textContent = 'Record';
        stateLine.textContent = 'Opening the microphone — allow access in your browser’s prompt.';
        break;
      case 'ready':
        recFace.innerHTML = UI_ICONS.record;
        recLabel.textContent = 'Record';
        stateLine.textContent = deps.message ?? 'Ready. Check the input meter, then press Record (or R).';
        break;
      case 'counting':
        recFace.textContent = count != null && count > 0 ? String(count) : '';
        recLabel.textContent = 'Cancel count';
        stateLine.textContent = 'Counting in — recording starts on the downbeat.';
        break;
      case 'recording':
        recFace.innerHTML = UI_ICONS.stop;
        recLabel.textContent = 'Stop';
        stateLine.textContent = 'Recording. Press Stop (or R) when you are done.';
        break;
      case 'stopping':
        recFace.innerHTML = UI_ICONS.stop;
        recLabel.textContent = 'Stop';
        stateLine.textContent = 'Finishing the take…';
        break;
      case 'error':
        recFace.innerHTML = UI_ICONS.record;
        recLabel.textContent = 'Record';
        break;
    }
    recBtn.setAttribute('aria-label', recLabel.textContent ?? 'Record');
  };

  const showTimer = (): void => {
    if (state === 'recording' && session) {
      const t0 = captureAt ?? session.startedAt;
      const elapsed = engine.ctx.currentTime - t0;
      const left = MAX_TAKE_SECONDS - elapsed;
      timer.textContent = left <= 10
        ? `● REC ${fmtTime(elapsed)} — ${Math.ceil(Math.max(0, left))} s left`
        : `● REC ${fmtTime(elapsed)} / ${TAKE_LIMIT_LABEL}`;
    } else if (state === 'counting') {
      timer.textContent = 'Count-in';
    } else {
      timer.textContent = `0:00.0 / ${TAKE_LIMIT_LABEL}`;
    }
  };

  // ---- the meter and the live envelope (REQ-the-mic-opens-with-the-studio) ----
  const trail: number[] = [];
  let clipUntil = 0;
  const drawLive = (): void => {
    const fit = fitCanvas(live);
    if (!fit) return;
    const { g, w, h } = fit;
    const ink = waveColours();
    drawMidline(g, w, h, ink.midline);
    const n = trail.length;
    if (n === 0) return;
    const cols = Math.max(1, Math.floor(w));
    // Fill the width as the take grows; once it is longer than the canvas,
    // squeeze it — max per column — so the whole take stays in view.
    const per = Math.max(1, n / cols);
    const shown = Math.min(cols, n);
    for (let c = 0; c < shown; c++) {
      const from = Math.floor(c * per);
      const to = Math.max(from + 1, Math.floor((c + 1) * per));
      let pk = 0;
      for (let i = from; i < to && i < n; i++) pk = Math.max(pk, trail[i]!);
      const y = Math.min(1, pk) * (h / 2 - 2);
      g.strokeStyle = pk >= CLIP_LEVEL ? ink.clipped : ink.inside;
      g.beginPath();
      g.moveTo(c + 0.5, h / 2 - y);
      g.lineTo(c + 0.5, h / 2 + Math.max(0.5, y));
      g.stroke();
    }
  };

  const meterLoop = (): void => {
    meterRaf = 0;
    if (destroyed || !session) return;
    const { peak } = session.level();
    const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const pct = db === -Infinity ? 0 : Math.max(0, Math.min(1, (db + 60) / 60));
    meterCover.style.width = `${((1 - pct) * 100).toFixed(1)}%`;
    meter.dataset.level = pct.toFixed(3);
    meterDb.textContent = db === -Infinity ? '−∞ dB' : `${db.toFixed(0)} dB`;
    const now = performance.now();
    if (peak >= CLIP_LEVEL) clipUntil = now + 1000;
    clip.classList.toggle(recStyles.clipOn!, now < clipUntil);
    if (state === 'recording') {
      trail.push(peak);
      drawLive();
    }
    meterRaf = requestAnimationFrame(meterLoop);
  };

  /** Time-driven transitions: the count ends, the bound is hit, the timer moves. */
  const watch = (): void => {
    if (destroyed || !session) return;
    const now = engine.ctx.currentTime;
    if (state === 'counting' && captureAt !== null && now >= captureAt) {
      state = 'recording';
      paint();
    }
    if (state === 'recording') {
      const t0 = captureAt ?? session.startedAt;
      if (now - t0 >= MAX_TAKE_SECONDS) {
        void finishRecording(`Stopped at the ${TAKE_LIMIT_LABEL} limit`);
        return;
      }
    }
    showTimer();
  };

  /** Beats from `when` to the counted downbeat. */
  const beatsLeft = (when: number): number =>
    captureAt === null ? 0 : Math.round((captureAt - when) / Math.max(1e-6, metronome.beatDuration()));
  // The count shows the beats left, painted when each is heard.
  const offBeat = deps.transport.onHeardBeat((b) => {
    if (state !== 'counting') return;
    const left = beatsLeft(b.when);
    if (left > 0) paint(left);
  });

  const openMic = async (): Promise<void> => {
    state = 'opening';
    paint();
    retry?.remove();
    retry = null;
    let s: MicSession;
    try {
      s = await openMicSession(engine.ctx);
    } catch (err) {
      if (destroyed) return;
      state = 'error';
      paint();
      stateLine.textContent = errorText(err instanceof MicCaptureError ? err.code : 'unknown');
      retry = createButton({ label: 'Try again', testId: 'mic-retry', onClick: () => { void openMic(); } });
      recArea.appendChild(retry);
      return;
    }
    // Closed, or left for the Edit screen, while the permission prompt was up.
    if (destroyed || session) {
      s.dispose();
      return;
    }
    session = s;
    state = 'ready';
    paint();
    showTimer();
    meterRaf = requestAnimationFrame(meterLoop);
    window.clearInterval(watchTimer);
    watchTimer = window.setInterval(watch, WATCH_MS);
  };

  const press = (): void => {
    switch (state) {
      case 'ready': {
        if (!session) return;
        trail.length = 0;
        session.start();
        if (countBox.checked) {
          // Capture starts now; the pre-roll is cropped to the downbeat on stop
          // (REQ-count-in-lands-the-take-on-a-downbeat).
          captureAt = metronome.countIn();
          state = 'counting';
          paint(Math.max(1, beatsLeft(engine.ctx.currentTime)));
        } else {
          captureAt = null;
          state = 'recording';
          paint();
        }
        showTimer();
        return;
      }
      case 'counting': {
        // Cancel the count: no take is kept, and the mic comes back fresh.
        metronome.cancelCountIn();
        captureAt = null;
        const old = session;
        session = null;
        if (old) void old.stop().catch(() => undefined).finally(() => old.dispose());
        void openMic();
        return;
      }
      case 'recording':
        void finishRecording();
        return;
      default:
    }
  };
  recBtn.addEventListener('click', press);

  async function finishRecording(reason?: string): Promise<void> {
    if (!session) return;
    const take = session;
    session = null; // claim it first — a second tap must not stop it twice
    state = 'stopping';
    paint();
    const at = captureAt;
    metronome.cancelCountIn();
    // Await the take BEFORE disposing: `dispose()` releases the recorder, and
    // the worklet's final batch is still in flight until `stop()` resolves
    // (audio-export.md REQ-chunks-are-batched-then-flushed). Disposing first would truncate every take.
    let captured = await take.stop();
    take.dispose();
    // Closed while the final batch was in flight: the studio's teardown has
    // already run, and it is the only teardown there will be — so build nothing
    // it cannot release (REQ-the-editor-owns-its-teardown).
    if (destroyed) return;
    if (at !== null) {
      const pre = Math.max(0, Math.round((at - take.startedAt) * captured.sampleRate));
      captured = pre < capturedFrames(captured)
        ? crop(captured, pre, capturedFrames(captured))
        : { left: new Float32Array(0), right: new Float32Array(0), sampleRate: captured.sampleRate };
    }
    captureAt = null;
    if (capturedFrames(captured) === 0) {
      deps.onNothing();
      return;
    }
    deps.onTake(captured, reason ?? 'Recorded');
  }

  paint();
  showTimer();
  void openMic();

  return {
    get state() { return state; },
    press,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      session?.dispose();
      session = null;
      cancelAnimationFrame(meterRaf);
      meterRaf = 0;
      window.clearInterval(watchTimer);
      watchTimer = 0;
      if (captureAt !== null) metronome.cancelCountIn();
      captureAt = null;
      offBeat();
    },
  };
}
