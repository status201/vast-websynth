/**
 * The sample studio's Vocoder tab (vocoder.md): the selection is the carrier,
 * and the voice is a mic take recorded against it or a filled sampler slot.
 *
 * The page owns the voice take — the mic session, the watch interval, the
 * silenced click and the playhead override — and releases all of it on every
 * way a take can end, including the studio closing under it
 * (REQ-the-voice-take-owns-its-teardown). The voice and the settings live in the
 * studio, not here, so a tab change, an edit or a re-record keeps them
 * (REQ-vocoder-registers-no-params).
 */
import recStyles from '../styles/record-sound.module.css';
import type { CapturedAudio } from '../../audio/recorder/node';
import type { Metronome } from '../../audio/metronome';
import { createButton, setButtonLabel } from './button';
import { Dropdown } from './dropdown';
import { UI_ICONS } from './ui-icons';
import { el, fitCanvas, drawMidline, waveColours } from './studio-kit';
import type { ToolContext, ToolPage } from './studio-tools';
import { capturedFrames, computePeaks, crop } from '../../audio/recorder/buffer-dsp';
import { openMicSession, MicCaptureError, type MicSession } from '../../audio/recorder/mic-capture';
import { audioBufferToCaptured } from '../../audio/recorder/audio-buffer';
import { fitToFrames } from '../../audio/recorder/time-stretch';
import {
  vocode, MIN_SMOOTH_MS, MAX_SMOOTH_MS, type VocoderSettings,
} from '../../audio/recorder/vocoder';
import {
  buildCuePass, autoLatency, takeStartFrame, readVoice, VOICE_TAKE_MARGIN_S,
} from '../../audio/recorder/voice-take';
import { slotOptionLabels } from '../../state/patterns';
import {
  MAX_VOCODER_FRAMES, VOCODER_BANDS, MAX_VOCODER_FORMANT, MAX_VOICE_OFFSET_MS,
  MIN_STRETCH_RATIO, MAX_STRETCH_RATIO, MAX_STRETCH_OUTPUT_FRAMES,
} from '../../state/limits';
import { micErrorText } from './record-screen';
import { onPaletteChange } from '../theme-colors';

/** A mic take, kept whole so Offset can slide it (REQ-the-offset-slides-the-voice-without-re-recording). */
export interface VoiceTake {
  /** The whole capture, press to auto-stop. */
  raw: CapturedAudio;
  /** Frame of `raw` where the carrier's pass was heard, Offset 0. */
  start: number;
  /** The selection's length when it was taken. */
  frames: number;
  /** What `autoLatency()` measured, shown beside Offset. */
  latencyMs: number;
}

/** What the page keeps across rebuilds — studio-lifetime, never persisted. */
export interface VoiceState {
  source: 'mic' | number;
  take: VoiceTake | null;
  offsetMs: number;
  stretch: boolean;
}

export interface VocoderPageOptions {
  /** The header's own Play button — a playing song is stopped through it. */
  toggleTransport(): void;
  metronome: Pick<Metronome, 'click' | 'setClick' | 'beatDuration'>;
  settings: { get(): VocoderSettings; set(s: VocoderSettings): void };
  voice: { get(): VoiceState; set(v: VoiceState): void };
  /** The Effects page's auto-play box — reused, not a second preference. */
  autoPlay(): boolean;
  /** Whether the Vocoder tab shows: the lane's peak scans run only then. */
  visible(): boolean;
}

export interface VocoderPage extends ToolPage {
  destroy(): void;
}

type TakeState = 'idle' | 'opening' | 'cue' | 'take' | 'stopping';

const MIC = 'Mic take';
const WATCH_MS = 50;
/** A carrier that stops this much before its pass ends was stopped, not finished. */
const EARLY_STOP_S = 0.05;
/** How long the lane waits for a crop drag or a slider to settle before it repaints. */
const LANE_SETTLE_MS = 100;

/** Resolve after the browser has had a chance to paint (so a "Vocode…" label shows). */
const afterPaint = (): Promise<void> => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
  else setTimeout(resolve, 0);
});

export function buildVocoderPage(ctx: ToolContext, opts: VocoderPageOptions): VocoderPage {
  const { engine } = ctx;
  const { srOf, selFrames, framesFor } = ctx.music;
  const page = el('div', recStyles.page);
  page.dataset.testid = 'voc-page';

  let destroyed = false;
  let state: TakeState = 'idle';
  let session: MicSession | null = null;
  let watchTimer = 0;
  /** The click as the toolbar had it, put back after the take; null when not held. */
  let clickWas: boolean | null = null;
  /** The take in flight. */
  let takeAt = 0;
  let passEnd = 0;
  let stopAt = 0;
  let latency = 0;
  let takeFrames = 0;
  /** The level trail drawn into the lane during the pass: [seconds into the pass, peak]. */
  const trail: Array<[number, number]> = [];
  /** A one-line message the state line shows until the next take (an error, a cancel). */
  let message = '';
  /** Bumped by each Record press, so a permission prompt resolved after a cancel is dropped. */
  let attempt = 0;

  const voice = (): VoiceState => opts.voice.get();
  const setVoice = (patch: Partial<VoiceState>): void => opts.voice.set({ ...voice(), ...patch });
  const settings = (): VocoderSettings => opts.settings.get();
  const setSetting = (patch: Partial<VocoderSettings>): void => opts.settings.set({ ...settings(), ...patch });

  // ---- row 1: the voice picker, Record voice, the state line ----
  const voiceRow = el('div', recStyles.fxRow);
  voiceRow.appendChild(el('span', recStyles.hint, 'Voice'));
  const sourceLabels = (): string[] => [MIC, ...slotOptionLabels(engine.patterns.sampleNames)];
  const labelFor = (src: 'mic' | number): string => (src === 'mic' ? MIC : sourceLabels()[src + 1] ?? MIC);
  const sourceDd = ctx.own(new Dropdown(sourceLabels(), labelFor(voice().source)));
  sourceDd.el.dataset.testid = 'voc-source';
  sourceDd.el.title = 'Sing into the mic against the selection, or use a sampler slot as the voice.';
  const recBtn = createButton({
    label: 'Record voice',
    iconBefore: UI_ICONS.record,
    testId: 'voc-record',
    title: 'Plays the selection once to count you in, then records you while it plays again.',
    onClick: () => press(),
  });
  const stateLine = el('span', recStyles.hint);
  stateLine.dataset.testid = 'voc-state';
  voiceRow.append(sourceDd.el, recBtn, stateLine);

  // ---- the voice lane: the carrier faint, the voice over it, one time axis ----
  const lane = el('canvas', recStyles.voiceLane);
  lane.dataset.testid = 'voc-lane';

  // ---- Offset (+ Stretch to fit for a slot voice) ----
  const offsetRow = el('div', recStyles.cutoff);
  const offsetLabel = el('span');
  const offset = el('input');
  offset.type = 'range';
  offset.min = String(-MAX_VOICE_OFFSET_MS);
  offset.max = String(MAX_VOICE_OFFSET_MS);
  offset.step = '5';
  offset.value = String(voice().offsetMs);
  offset.dataset.testid = 'voc-offset';
  offset.title = 'Move the voice later (right) or earlier (left) against the carrier.';
  offset.setAttribute('aria-label', 'Voice offset');
  offset.addEventListener('input', () => {
    setVoice({ offsetMs: Number(offset.value) });
    sync();
  });
  const stretchWrap = el('label', recStyles.autoplay);
  const stretch = el('input');
  stretch.type = 'checkbox';
  stretch.dataset.testid = 'voc-stretch';
  stretch.checked = voice().stretch;
  stretch.addEventListener('change', () => { setVoice({ stretch: stretch.checked }); sync(); });
  stretchWrap.append(stretch, el('span', undefined, 'Stretch to fit'));
  offsetRow.append(offsetLabel, offset, stretchWrap);

  // ---- the sound: Bands + five sliders ----
  const soundRow = el('div', recStyles.vocGrid);
  const bandLabel = (b: number): string => `${b} bands`;
  const bandsDd = ctx.own(new Dropdown(VOCODER_BANDS.map(bandLabel), bandLabel(settings().bands)));
  bandsDd.el.dataset.testid = 'voc-bands';
  bandsDd.el.title = 'More bands: clearer words. Fewer: the classic robot.';
  bandsDd.onChange((v) => setSetting({ bands: parseInt(v, 10) || settings().bands }));
  soundRow.appendChild(bandsDd.el);

  const slider = (
    key: 'formant' | 'smoothMs' | 'clarity' | 'sibilance' | 'dry',
    name: string, min: number, max: number, step: number,
    fmt: (v: number) => string, title: string,
  ): void => {
    const row = el('label', recStyles.cutoff);
    const label = el('span');
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(settings()[key]);
    input.dataset.testid = `voc-${key === 'smoothMs' ? 'smooth' : key}`;
    input.title = title;
    const paint = (): void => { label.textContent = `${name} ${fmt(Number(input.value))}`; };
    input.addEventListener('input', () => { setSetting({ [key]: Number(input.value) }); paint(); });
    paint();
    row.append(label, input);
    soundRow.appendChild(row);
  };
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  slider('formant', 'Formant', -MAX_VOCODER_FORMANT, MAX_VOCODER_FORMANT, 1,
    (v) => (v > 0 ? `+${v}` : String(v)), 'Shift the voice’s character up (brighter) or down (deeper), in bands.');
  slider('smoothMs', 'Smooth', MIN_SMOOTH_MS, MAX_SMOOTH_MS, 5,
    (v) => `${v} ms`, 'How quickly the voice lets go: short is crisp, long is legato.');
  slider('clarity', 'Clarity', 0, 1, 0.05, pct,
    'Flattens a dull carrier so the words come through.');
  slider('sibilance', 'Sibilance', 0, 1, 0.05, pct,
    'Lets the voice’s s and t sounds through on their own.');
  slider('dry', 'Dry', 0, 1, 0.05, pct, 'Mixes the untouched carrier back in.');

  // ---- Audition · Apply · the hint ----
  const actRow = el('div', recStyles.fxRow);
  const hint = el('span', recStyles.hint);
  hint.dataset.testid = 'voc-hint';
  const auditionBtn = createButton({
    label: 'Audition',
    testId: 'voc-audition',
    title: 'Hear it without applying it.',
    onClick: () => { void audition(); },
  });
  const applyBtn = createButton({
    label: 'Apply',
    testId: 'voc-apply',
    title: 'Vocode the selection. Undo takes it back.',
    onClick: () => {
      if (!ready()) return;
      ctx.runOp(applyBtn, 'Vocode', async (sel) => {
        await afterPaint();
        const v = voiceFor(capturedFrames(sel));
        return v ? vocode(sel, v, settings()) : sel;
      });
    },
  });
  ctx.track(auditionBtn, applyBtn);
  actRow.append(auditionBtn, applyBtn, hint);

  page.append(voiceRow, lane, offsetRow, soundRow, actRow,
    el('div', recStyles.hint, 'Use headphones for a voice take — speakers leak the carrier into the mic.'));

  // ---- the voice ----

  const selection = (): CapturedAudio | null => {
    const cur = ctx.working();
    return cur ? crop(cur, ctx.cropStart(), ctx.cropEnd()) : null;
  };
  const offsetFrames = (): number => Math.round((voice().offsetMs / 1000) * srOf());
  const slotBuffer = (slot: number): AudioBuffer | null => engine.sampler.buffers[slot] ?? null;
  const stretchOk = (from: number, to: number): boolean => {
    if (from <= 0 || to <= 0 || to > MAX_STRETCH_OUTPUT_FRAMES) return false;
    const r = to / from;
    return r >= MIN_STRETCH_RATIO && r <= MAX_STRETCH_RATIO;
  };

  /** A slot voice, memoised on the buffer and the length it was stretched to:
   *  the lane redraws on every Offset move, and a stretch is not free. */
  let slotMemo: { buf: AudioBuffer; frames: number; stretch: boolean; audio: CapturedAudio } | null = null;
  const slotVoice = (slot: number, frames: number): CapturedAudio | null => {
    const buf = slotBuffer(slot);
    if (!buf) return null;
    const want = voice().stretch && stretchOk(buf.length, frames);
    if (slotMemo && slotMemo.buf === buf && slotMemo.stretch === want && (!want || slotMemo.frames === frames)) {
      return slotMemo.audio;
    }
    const raw = audioBufferToCaptured(buf);
    const audio = want ? fitToFrames(raw, frames, 'tonal') : raw;
    slotMemo = { buf, frames, stretch: want, audio };
    return audio;
  };

  /** The voice, exactly `frames` long, Offset applied — or null when there is none. */
  const voiceFor = (frames: number): CapturedAudio | null => {
    const v = voice();
    if (v.source === 'mic') {
      return v.take ? readVoice(v.take.raw, v.take.start - offsetFrames(), frames) : null;
    }
    const audio = slotVoice(v.source, frames);
    return audio ? readVoice(audio, -offsetFrames(), frames) : null;
  };

  /** What stops a render, in words — or '' when nothing does. */
  const missing = (): string => {
    const frames = selFrames();
    if (frames <= 0) return 'Vocoder: nothing selected.';
    if (frames > MAX_VOCODER_FRAMES) return 'Vocoder: the selection is longer than 30 s — crop it first.';
    const v = voice();
    if (v.source === 'mic') return v.take ? '' : 'Record a voice, or pick a slot as the voice.';
    return slotBuffer(v.source) ? '' : 'That slot has no audio.';
  };
  const ready = (): boolean => missing() === '' && state === 'idle' && !ctx.isBusy();

  const audition = async (): Promise<void> => {
    if (!ready()) return;
    const sel = selection();
    if (!sel) return;
    setButtonLabel(auditionBtn, 'Audition…');
    await afterPaint();
    setButtonLabel(auditionBtn, 'Audition');
    if (destroyed || !ready()) return;
    const v = voiceFor(capturedFrames(sel));
    if (v) ctx.playClip(vocode(sel, v, settings()));
  };

  // ---- the voice take (REQ-the-voice-take-follows-the-carrier) ----

  /** Release what the take holds besides its session: the watch, the click, the playhead. */
  const releaseTake = (): void => {
    window.clearInterval(watchTimer);
    watchTimer = 0;
    if (clickWas !== null) {
      opts.metronome.setClick(clickWas);
      clickWas = null;
    }
    ctx.setPlayhead(null);
  };

  /** End a take keeping nothing (REQ-a-stopped-carrier-cancels-the-take). */
  const cancel = (why: string, stopCarrier: boolean): void => {
    const s = session;
    session = null;
    releaseTake();
    if (s) void s.stop().catch(() => undefined).finally(() => s.dispose());
    state = 'idle';
    message = why;
    if (stopCarrier && !destroyed) ctx.stopPreview();
    if (!destroyed) sync();
  };

  /** End a take keeping what was captured (REQ-the-voice-take-is-cropped-frame-exact). */
  const finish = async (early: boolean): Promise<void> => {
    const s = session;
    if (!s) return;
    session = null; // claimed — a second press must not stop it twice
    state = 'stopping';
    releaseTake();
    if (early) ctx.stopPreview();
    sync();
    // Await the take BEFORE disposing: the worklet's last batch is still in
    // flight until stop() resolves (sample-recorder.md REQ-the-editor-owns-its-teardown).
    const raw = await s.stop().catch(() => null);
    const first = s.firstFrame;
    const startedAt = s.startedAt;
    s.dispose();
    if (destroyed) return; // the studio closed meanwhile: build nothing
    state = 'idle';
    if (!raw || capturedFrames(raw) === 0) {
      message = 'Nothing was recorded — try again.';
      sync();
      return;
    }
    const sr = raw.sampleRate;
    const firstFrame = first ?? Math.round(startedAt * sr);
    const take: VoiceTake = {
      raw,
      start: takeStartFrame({ takeAt, latency, sampleRate: sr, firstFrame }),
      frames: takeFrames,
      latencyMs: latency * 1000,
    };
    message = '';
    setVoice({ source: 'mic', take });
    sourceDd.setValue(MIC);
    sync();
    if (opts.autoPlay()) void audition();
  };

  const start = async (): Promise<void> => {
    const sel = selection();
    const frames = sel ? capturedFrames(sel) : 0;
    if (!sel || frames <= 0 || frames > MAX_VOCODER_FRAMES) return;
    message = '';
    // A song playing would leak into the take; stop it the one way the studio may.
    if (engine.clock.playing) {
      opts.toggleTransport();
      message = 'Song stopped for the voice take.';
    }
    state = 'opening';
    const mine = ++attempt;
    sync();
    let s: MicSession;
    try {
      s = await openMicSession(engine.ctx);
    } catch (err) {
      if (destroyed || mine !== attempt) return;
      state = 'idle';
      message = micErrorText(err instanceof MicCaptureError ? err.code : 'unknown');
      sync();
      return;
    }
    // Closed, or cancelled, while the permission prompt was up.
    if (destroyed || mine !== attempt || state !== 'opening') {
      s.dispose();
      return;
    }
    session = s;
    // The carrier is the cue, and a free-running click is not aligned with it.
    clickWas = opts.metronome.click;
    opts.metronome.setClick(false);

    s.start();
    const sr = sel.sampleRate;
    const pass = buildCuePass(sel, framesFor(engine.barTicks));
    ctx.playClip(pass.audio);
    const preview = engine.clipPreview;
    takeAt = preview.startTime + pass.cueFrames / sr;
    passEnd = takeAt + frames / sr;
    takeFrames = frames;
    const ac = engine.ctx as AudioContext & { outputLatency?: number; baseLatency?: number };
    latency = autoLatency({ outputLatency: ac.outputLatency, baseLatency: ac.baseLatency, inputLatency: s.inputLatency() });
    stopAt = passEnd + latency + MAX_VOICE_OFFSET_MS / 1000 + VOICE_TAKE_MARGIN_S;
    ctx.setPlayhead(() => {
      const t = engine.ctx.currentTime - takeAt;
      return t >= 0 ? t * sr : null;
    });
    trail.length = 0;
    state = 'cue';
    sync();
    watchTimer = window.setInterval(watch, WATCH_MS);
  };

  /** Time-driven transitions: the cue ends, the carrier stops early, the take ends. */
  function watch(): void {
    if (destroyed || !session) return;
    const now = engine.ctx.currentTime;
    if ((state === 'cue' || state === 'take') && !engine.clipPreview.playing && now < passEnd - EARLY_STOP_S) {
      cancel('The carrier stopped, so the take was cancelled.', false);
      return;
    }
    if (state === 'cue' && now >= takeAt) state = 'take';
    if (state === 'take') {
      trail.push([now - takeAt, session.level().peak]);
      if (now >= stopAt) {
        void finish(false);
        return;
      }
    }
    paintState();
    drawLane();
  }

  function press(): void {
    switch (state) {
      case 'idle': void start(); return;
      case 'opening': attempt++; state = 'idle'; message = ''; sync(); return; // the open resolves into a dispose
      case 'cue': cancel('Take cancelled.', true); return;
      case 'take': void finish(true); return;
      default:
    }
  }

  // ---- paint ----

  const paintState = (): void => {
    let text = message;
    switch (state) {
      case 'opening': text = 'Allow microphone access…'; break;
      case 'cue': {
        const left = Math.ceil((takeAt - engine.ctx.currentTime) / Math.max(1e-6, opts.metronome.beatDuration()));
        text = left > 0 ? `Get ready… ${left}` : 'Get ready…';
        break;
      }
      case 'take': text = '● Sing now'; break;
      case 'stopping': text = 'Finishing the take…'; break;
      default:
        if (!text) {
          const t = voice().take;
          if (voice().source === 'mic' && t) text = `Mic take ${(t.frames / t.raw.sampleRate).toFixed(2)} s`;
        }
    }
    stateLine.textContent = text;
    stateLine.classList.toggle(recStyles.vocLive!, state === 'take');
    const label = state === 'cue' || state === 'opening' ? 'Cancel' : state === 'take' ? 'Stop' : 'Record voice';
    const face = state === 'take' ? UI_ICONS.stop : UI_ICONS.record;
    if (recBtn.dataset.face !== face) {
      // The face follows the state, like the Record screen's button.
      recBtn.dataset.face = face;
      recBtn.querySelector('svg')?.remove();
      recBtn.insertAdjacentHTML('afterbegin', face);
    }
    setButtonLabel(recBtn, label);
    recBtn.dataset.state = state;
    recBtn.classList.toggle('on', state === 'cue' || state === 'take');
  };

  /** Selection peaks, memoised on what they are a function of. */
  let carrierMemo: { key: string; cur: CapturedAudio; peaks: Float32Array } | null = null;
  const carrierPeaks = (cols: number): Float32Array | null => {
    const cur = ctx.working();
    if (!cur || selFrames() <= 0) return null;
    const key = `${ctx.cropStart()}:${ctx.cropEnd()}:${cols}`;
    if (carrierMemo && carrierMemo.cur === cur && carrierMemo.key === key) return carrierMemo.peaks;
    const peaks = computePeaks(crop(cur, ctx.cropStart(), ctx.cropEnd()), cols);
    carrierMemo = { key, cur, peaks };
    return peaks;
  };

  /**
   * Paint the lane — only while the tab shows, since it scans the selection's
   * and the voice's peaks, and a Stretch to fit voice is re-stretched whenever the
   * selection's length moves (sample-recorder.md
   * REQ-the-recorder-modal-hosts-the-vocoder). `sync` runs on every crop-handle
   * move, so it asks through `scheduleLane`, which waits for the drag to settle.
   */
  let laneTimer = 0;
  const scheduleLane = (): void => {
    window.clearTimeout(laneTimer);
    laneTimer = window.setTimeout(() => { laneTimer = 0; drawLane(); }, LANE_SETTLE_MS);
  };
  const drawLane = (): void => {
    if (destroyed || !opts.visible()) return;
    const fit = fitCanvas(lane);
    if (!fit) return;
    const { g, w, h } = fit;
    const ink = waveColours();
    drawMidline(g, w, h, ink.midline);
    const cols = Math.max(1, Math.floor(w));
    const bars = (peaks: Float32Array, colour: string): void => {
      g.strokeStyle = colour;
      g.lineWidth = 1;
      for (let c = 0; c < cols; c++) {
        const lo = Math.max(-1, peaks[c * 2] ?? 0);
        const hi = Math.min(1, peaks[c * 2 + 1] ?? 0);
        const y1 = h / 2 - hi * (h / 2 - 2);
        const y2 = h / 2 - lo * (h / 2 - 2);
        g.beginPath();
        g.moveTo(c + 0.5, y1);
        g.lineTo(c + 0.5, Math.max(y2, y1 + 0.5));
        g.stroke();
      }
    };
    const carrier = carrierPeaks(cols);
    if (carrier) bars(carrier, ink.outside);

    if (state === 'take' || state === 'stopping') {
      // The live level, laid on the same axis as the pass.
      const dur = takeFrames / srOf();
      g.strokeStyle = ink.inside;
      for (const [t, p] of trail) {
        const x = (t / Math.max(1e-6, dur)) * w;
        if (x > w) break;
        const y = Math.min(1, p) * (h / 2 - 2);
        g.beginPath();
        g.moveTo(x + 0.5, h / 2 - y);
        g.lineTo(x + 0.5, h / 2 + Math.max(0.5, y));
        g.stroke();
      }
      return;
    }
    const frames = selFrames();
    const v = frames > 0 ? voiceFor(frames) : null;
    if (v) bars(computePeaks(v, cols), ink.inside);
  };

  const paintOffset = (): void => {
    const v = voice();
    const ms = v.offsetMs;
    const auto = v.source === 'mic' && v.take ? ` (auto ${Math.round(v.take.latencyMs)} ms)` : '';
    offsetLabel.textContent = `Offset ${ms > 0 ? '+' : ''}${ms} ms${auto}`;
  };

  /** The picker's labels as last built — rebuilt only when a slot name moved. */
  let shownLabels = sourceLabels().join('|');
  /** Re-derive everything the page shows from the studio's state. */
  function sync(): void {
    if (destroyed) return;
    // Slot names move under a Load; the list follows them.
    const labels = sourceLabels();
    if (labels.join('|') !== shownLabels) {
      shownLabels = labels.join('|');
      sourceDd.setOptions(labels);
    }
    sourceDd.setValue(labelFor(voice().source));
    sourceDd.setDisabledOptions(labels.filter((_, i) => i > 0 && !slotBuffer(i - 1)));

    const v = voice();
    const isSlot = v.source !== 'mic';
    stretchWrap.hidden = !isSlot;
    if (isSlot) {
      const buf = slotBuffer(v.source as number);
      const ok = !!buf && stretchOk(buf.length, selFrames());
      stretch.disabled = !ok;
      stretchWrap.title = ok
        ? 'Retime the slot to the selection’s length, keeping its pitch.'
        : 'The slot is more than 4x longer or shorter than the selection.';
    }
    paintOffset();
    paintState();

    const why = missing();
    const taking = state !== 'idle';
    const busy = ctx.isBusy();
    auditionBtn.disabled = busy || taking || why !== '';
    applyBtn.disabled = busy || taking || why !== '';
    recBtn.disabled = state === 'stopping' || (state === 'idle' && (busy || selFrames() <= 0 || selFrames() > MAX_VOCODER_FRAMES));
    const frames = selFrames();
    hint.textContent = why || `Vocode the ${(frames / srOf()).toFixed(2)} s selection with ${
      v.source === 'mic' ? 'the mic take' : labelFor(v.source)}.`;
    scheduleLane();
  }

  sourceDd.onChange((label) => {
    const idx = sourceLabels().indexOf(label);
    setVoice({ source: idx <= 0 ? 'mic' : idx - 1 });
    message = '';
    sync();
  });

  // The lane repaints when it gets a box (its tab shown, the card resized) and
  // on a theme change (ui-themes.md REQ-a-theme-change-repaints-the-canvases).
  const laneObs = new ResizeObserver(() => drawLane());
  laneObs.observe(lane);
  const offPalette = onPaletteChange(() => drawLane());

  sync();

  return {
    el: page,
    sync: () => sync(),
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(laneTimer);
      laneObs.disconnect();
      offPalette();
      const s = session;
      session = null;
      releaseTake();
      if (s) void s.stop().catch(() => undefined).finally(() => s.dispose());
    },
  };
}
