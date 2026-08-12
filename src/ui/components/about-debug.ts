// The About modal's collapsible Debug section (debug-panel.md): a live key/value
// readout of runtime state plus the actions that act on it.
//
// The largest of about.ts's five former tenants, and the one with its own spec —
// so it gets its own file. It rides the lazy About chunk
// (runtime-performance.md REQ-1); the late-bound row sources it reads are in
// `state/debug-sources.ts` precisely so `main.ts` can bind them at boot without
// importing any of this.
import { Modal } from './modal';
import { createButton, setButtonLabel } from './button';
import { confirmDialog } from './dialog';
import { createCollapseToggle } from './collapse-toggle';
import { copyText, flashCopied } from '../clipboard';
import { isIOS } from '../../platform/ios';
import { perfDiagnostics } from '../../state/perf-mode';
import { SessionAutosave } from '../../state/session-autosave';
import { SampleAutosave } from '../../state/sample-autosave';
import { storageUsage } from '../../state/slot-store';
import { SAMPLER_SLOT_COUNT } from '../../state/patterns';
import { clipStats, midiStats, wakeState } from '../../state/debug-sources';
import type { StudioApi } from '../studio-api';
import switchStyles from '../styles/switch.module.css';
import dialogStyles from '../styles/dialog.module.css';
import styles from '../styles/modal.module.css';

declare const __APP_VERSION__: string;

/** An inline action button attached to a row's value cell (REQ-6). */
interface RowAction {
  label: string;
  testId: string;
  onClick: () => void;
  /** Destructive: styled red and confirmed before it runs. */
  danger?: boolean;
  /** Confirm copy — required when `danger`. */
  confirm?: { title: string; message: string; confirmLabel: string };
}

const MB = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;

/** "3 min ago" / "just now" — enough to tell a stale autosave from a live one. */
function ago(at: number | null): string {
  if (at === null) return 'unknown age';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/**
 * Default-collapsed Debug section (debug-panel.md). Cross-platform and
 * intentionally minimal + extensible — a feature adds a row (and, since v3, an
 * action) without a contract change.
 *
 * The actions exist because a remote device has no console: on a borrowed phone
 * or a BrowserStack session, *observing* a wedged AudioContext or a poisoned
 * autosave is only half of what you need — you also have to be able to do
 * something about it, and "Restore to Factory Settings" is far too big a hammer.
 */
export function buildDebugSection(engine: StudioApi): {
  header: HTMLElement;
  body: HTMLElement;
  refresh: () => void;
  dispose: () => void;
} {
  const header = document.createElement('div');
  header.className = `${Modal.secClass} ${styles.secFold!}`;
  const label = document.createElement('span');
  label.className = styles.secFoldLabel!;
  label.textContent = 'Debug';
  header.appendChild(label);

  // The section body wraps the key/value grid AND the actions row, so collapsing
  // hides both and the grid keeps its own two-column layout.
  const body = document.createElement('div');
  body.className = styles.debugBody!;
  body.dataset.testid = 'debug-section';

  const grid = document.createElement('div');
  grid.className = Modal.keysClass;
  body.appendChild(grid);

  /** Every row, in order — the source for the copyable report (REQ-7). */
  const rows: Array<{ name: string; el: HTMLElement }> = [];

  const rowButton = (action: RowAction): HTMLButtonElement => createButton({
    label: action.label,
    className: `${switchStyles.root!} ${styles.debugBtn!}${action.danger ? ` ${dialogStyles.danger!}` : ''}`,
    testId: action.testId,
    onClick: () => {
      if (!action.confirm) { action.onClick(); return; }
      const c = action.confirm;
      void confirmDialog({ ...c, danger: action.danger ?? false }).then((ok) => {
        if (ok) action.onClick();
      });
    },
  });

  const addRow = (name: string, action?: RowAction): HTMLElement => {
    const k = document.createElement('div');
    k.className = Modal.keyClass;
    k.textContent = name;
    const v = document.createElement('div');
    v.className = Modal.actClass;
    grid.appendChild(k);
    grid.appendChild(v);
    if (!action) {
      rows.push({ name, el: v });
      return v;
    }
    // The value lives in its own span so `refresh` writing textContent can
    // never wipe the button beside it.
    v.classList.add(styles.debugActRow!);
    const val = document.createElement('span');
    v.appendChild(val);
    v.appendChild(rowButton(action));
    rows.push({ name, el: val });
    return val;
  };

  const stateVal = addRow('AudioContext');
  stateVal.dataset.testid = 'debug-ctx-state';
  const rateVal = addRow('Sample rate');
  const latencyVal = addRow('Latency');
  latencyVal.dataset.testid = 'debug-latency';
  // Transport: the clock's OWN bpm, which a slaved clock writes directly —
  // a disagreement with `transport.bpm` is the bug worth seeing (sync).
  const transportVal = addRow('Transport');
  transportVal.dataset.testid = 'debug-transport';
  const iosVal = addRow('iOS');
  // Device / performance-mode diagnostics (owned by performance-mode.md).
  const tierVal = addRow('Perf tier');
  tierVal.dataset.testid = 'debug-perf-tier';
  const coresVal = addRow('CPU cores');
  const memVal = addRow('Device memory');
  const mobileVal = addRow('Mobile UA');
  const profileVal = addRow('Audio profile');
  // Persisted sampler audio (owned by sample-persistence.md) — in-memory
  // bookkeeping, so opening About never touches IndexedDB.
  const clipsClear: RowAction = {
    label: 'Clear',
    testId: 'debug-clips-clear',
    danger: true,
    confirm: {
      title: 'Clear stored sampler clips',
      message: 'Empty every sampler slot and delete the audio kept on this device. The song itself is not touched.',
      confirmLabel: 'Clear clips',
    },
    onClick: () => {
      // Nulling the slots is what the autosaver watches, so it deletes them
      // too; the explicit wipe also clears any orphan the session never named.
      for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) engine.sampler.setBuffer(i, null);
      void SampleAutosave.clear();
    },
  };
  const clipsVal = addRow('Sampler clips', clipsClear);
  clipsVal.dataset.testid = 'debug-sampler-clips';
  const clipsBtn = clipsVal.nextElementSibling as HTMLButtonElement;
  // Session autosave (owned by session-autosave.md) — clearing it is the small
  // hammer for a session the app chokes on.
  const sessionVal = addRow('Session autosave', {
    label: 'Clear',
    testId: 'debug-session-clear',
    danger: true,
    confirm: {
      title: 'Clear the autosaved session',
      message: 'Forget the working session restored at boot. Saved songs and presets are untouched; the app reloads.',
      confirmLabel: 'Clear session',
    },
    onClick: () => { SessionAutosave.clear(); location.reload(); },
  });
  sessionVal.dataset.testid = 'debug-session';
  const storageVal = addRow('Local storage');
  storageVal.dataset.testid = 'debug-storage';
  // Service worker (owned by pwa-install.md) — a stale cache is the classic
  // "why am I not seeing the new version?" on an installed PWA.
  const swVal = addRow('Service worker', {
    label: 'Unregister',
    testId: 'debug-sw-unregister',
    danger: true,
    confirm: {
      title: 'Unregister the service worker',
      message: 'Drop the offline cache and reload. The app will re-register it on the next visit.',
      confirmLabel: 'Unregister',
    },
    onClick: () => { void unregisterServiceWorkers(); },
  });
  swVal.dataset.testid = 'debug-sw';
  const midiVal = addRow('MIDI ports');
  midiVal.dataset.testid = 'debug-midi';
  const wakeVal = addRow('Wake lock');
  wakeVal.dataset.testid = 'debug-wake';
  // iOS audio-session diagnostics (owned by ios-audio.md; inert off iOS).
  const unlockVal = addRow('Audio unlock');
  unlockVal.dataset.testid = 'debug-ios-unlock';
  const loopVal = addRow('Silent loop');
  loopVal.dataset.testid = 'debug-ios-loop';
  // Android keep-alive (owned by media-session.md; inert off Android).
  const mediaVal = addRow('Media session');
  mediaVal.dataset.testid = 'debug-media-session';
  // What the audio thread reports about itself while the page is hidden — the
  // one reading that says whether a background crackle is ours (audio-lifecycle).
  const bgVal = addRow('Background audio');
  bgVal.dataset.testid = 'debug-background';

  // ---- service-worker state (async, so polled far slower than the rows) ----
  let swText = 'unsupported';
  let swChecked = 0;
  const readSw = (): void => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistrations().then((regs) => {
      swText = regs.length === 0
        ? 'none registered'
        : `${regs.length} registered${navigator.serviceWorker.controller ? ' · controlling' : ''}`;
      swVal.textContent = swText;
    }).catch(() => { swText = 'unavailable'; });
  };

  // ---- actions (REQ-7) ----
  const actions = document.createElement('div');
  actions.className = styles.debugActions!;
  actions.dataset.testid = 'debug-actions';

  const ctxToggle = createButton({
    label: 'Resume',
    className: `${switchStyles.root!} ${styles.debugBtn!}`,
    testId: 'debug-ctx-toggle',
    onClick: () => {
      // Suspending is how you prove a stuck note is the graph and not the
      // device; resuming is the escape hatch when the OS suspended us.
      if (engine.ctx.state === 'running') void engine.ctx.suspend();
      else void engine.resume();
    },
  });

  const panicBtn = createButton({
    label: 'Panic',
    className: `${switchStyles.root!} ${styles.debugBtn!}`,
    testId: 'debug-panic',
    onClick: () => engine.panic(),
  });

  let stopTone: (() => void) | null = null;
  const toneBtn = createButton({
    label: 'Test tone',
    className: `${switchStyles.root!} ${styles.debugBtn!}`,
    testId: 'debug-test-tone',
    onClick: () => {
      stopTone?.();
      try {
        stopTone = playTestTone(engine.ctx, () => {
          stopTone = null;
          setButtonLabel(toneBtn, 'Test tone');
        });
        setButtonLabel(toneBtn, 'Playing…');
      } catch {
        setButtonLabel(toneBtn, 'Failed');
      }
    },
  });

  const report = (): string => [
    `VAST G1-J8 ${__APP_VERSION__}`,
    new Date().toISOString(),
    navigator.userAgent,
    '',
    ...rows.map((r) => `${r.name}: ${r.el.textContent ?? ''}`),
  ].join('\n');

  const copyBtn = createButton({
    label: 'Copy report',
    className: `${switchStyles.root!} ${styles.debugBtn!}`,
    testId: 'debug-copy',
    // The whole point of the panel on a device with no console: hand the
    // readout to someone else in one gesture.
    onClick: () => flashCopied(copyBtn, 'Copy report', copyText(report())),
  });

  actions.append(ctxToggle, panicBtn, toneBtn, copyBtn);
  body.appendChild(actions);

  // ---- polling tiers (REQ-11) ---------------------------------------------
  // The rows differ wildly in cost. Most are plain field reads, but the storage
  // and session rows walk (and JSON.parse) localStorage *synchronously* — far
  // too expensive to run at the interval's rate behind a playing audio graph.
  // A row that isn't due simply keeps the text it already has.
  const SLOW_MS = 2000;
  const SW_MS = 5000;
  let slowChecked = 0;

  const refresh = (force = false): void => {
    // ---- every tick: cheap field reads ----
    stateVal.textContent = engine.ctx.state;
    setButtonLabel(ctxToggle, engine.ctx.state === 'running' ? 'Suspend' : 'Resume');
    rateVal.textContent = `${engine.ctx.sampleRate} Hz`;
    const base = engine.ctx.baseLatency;
    const out = engine.ctx.outputLatency;
    latencyVal.textContent =
      `base ${base != null ? `${(base * 1000).toFixed(1)} ms` : '—'} · ` +
      `output ${out ? `${(out * 1000).toFixed(1)} ms` : '—'}`;
    transportVal.textContent =
      `${engine.clock.playing ? 'playing' : 'stopped'} · ` +
      `${engine.clock.bpm.toFixed(1)} BPM · sync ${engine.sync.mode} · ` +
      // The only on-device evidence that the wakeup source stalled — the phone
      // this happens on has no console (audio-lifecycle.md REQ-7).
      `${engine.clock.dropouts} dropouts`;
    iosVal.textContent = isIOS() ? 'yes' : 'no';
    const clips = clipStats();
    clipsVal.textContent = clips ? `${clips.count} · ${MB(clips.bytes)}` : 'n/a';
    // REQ-8 — an action whose source never bound is disabled, not broken.
    clipsBtn.disabled = clips === undefined;
    const midi = midiStats();
    midiVal.textContent = midi ? `${midi.inputs} in · ${midi.outputs} out` : 'n/a';
    const wake = wakeState();
    wakeVal.textContent = wake ? (wake.supported ? (wake.held ? 'held' : 'released') : 'unsupported') : 'n/a';
    const ios = engine.iosAudio;
    unlockVal.textContent = ios.status
      + (ios.routed ? ' · routed' : '')
      + (ios.audioSessionSet ? ' · session:playback' : '');
    // The reason the tick is as fast as it is: this clock visibly advances.
    loopVal.textContent = ios.paused === null
      ? (ios.active ? 'idle' : 'n/a')
      : (ios.paused ? 'paused' : `playing t=${(ios.currentTime ?? 0).toFixed(1)}`);
    // Android: did the session actually form? The keep-alive loop's own clock
    // advances beside it, which is what says the element is really playing.
    const bg = engine.backgroundAudio;
    const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
    bgVal.textContent =
      `${bg.watching ? 'watching' : 'idle'} · `
      + (bg.supported ? `underrun ${pct(bg.underrunRatio)} (worst ${pct(bg.worstUnderrunRatio)})` : 'underrun n/a')
      + ` · clock ${pct(bg.driftRatio)} · ${bg.suspensions} suspends`;
    const media = engine.mediaSession;
    mediaVal.textContent = !media.active
      ? 'n/a'
      : `${media.status} · ${media.playbackState} · ${media.handlers} actions`
        + (media.paused === false ? ` · t=${(media.currentTime ?? 0).toFixed(1)}` : '');

    const now = Date.now();

    // ---- ~2 s: synchronous localStorage walks + near-static device info ----
    if (force || now - slowChecked > SLOW_MS) {
      slowChecked = now;
      // Near-static, but re-read so a live Perf-modal change still shows up.
      const perf = perfDiagnostics();
      tierVal.textContent = `${perf.tier} (${perf.pref === 'auto' ? 'auto' : 'forced'})`;
      coresVal.textContent = perf.cores != null ? String(perf.cores) : 'unknown';
      memVal.textContent = perf.memoryGb != null ? `${perf.memoryGb} GB` : 'unknown';
      mobileVal.textContent = perf.mobile ? 'yes' : 'no';
      const p = perf.profile;
      profileVal.textContent =
        `${p.latencyHint} · ${p.voiceCount} voices · ${p.fps} fps · ` +
        `lookahead ${Math.round(p.scheduleAheadS * 1000)}ms · IR ≤${p.reverbIrMaxS}s · ` +
        `oversample ${p.fxOversample ? 'on' : 'off'}`;
      const session = SessionAutosave.stats();
      sessionVal.textContent = session
        ? `${MB(session.bytes)} · ${ago(session.savedAt)}`
        : 'none';
      const store = storageUsage();
      storageVal.textContent = `${store.keys} keys · ${MB(store.bytes)}`;
    }

    // ---- ~5 s: getRegistrations() is async, so it caches and rewrites ----
    if (force || now - swChecked > SW_MS) { swChecked = now; readSw(); }
    swVal.textContent = swText;
  };
  refresh(true);

  // Whole-header click toggles (chevron included), persisted; default collapsed.
  // Folded shut, the rows aren't merely invisible — they go unread (REQ-3):
  // someone who opened About for the credits shouldn't pay for a readout that
  // isn't on screen. `onChange` also fires once here with the stored/default
  // state, so `visible` is correct from the start without a second source.
  let visible = false;
  const toggle = createCollapseToggle(body, 'websynth.debug.about', {
    defaultCollapsed: () => true,
    trigger: header,
    onChange: (collapsed) => {
      visible = !collapsed;
      // Repaint every tier on expand, so the panel is never shown stale.
      if (visible) refresh(true);
    },
  });
  header.appendChild(toggle.el);

  /** What the modal's interval and `statechange` drive — gated per REQ-3. */
  const tick = (): void => { if (visible) refresh(); };

  // REQ-9 — nothing an action started may outlive the modal.
  const dispose = (): void => {
    stopTone?.();
    stopTone = null;
    setButtonLabel(toneBtn, 'Test tone');
  };

  return { header, body, refresh: tick, dispose };
}

/**
 * A 1 s A440 straight to `ctx.destination`, deliberately **bypassing** the
 * master chain: this answers "is this device making any sound at all?", which a
 * muted mix or a closed filter would otherwise hide. Returns a stopper.
 */
function playTestTone(ctx: AudioContext, onEnded: () => void): () => void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const t = ctx.currentTime;
  osc.frequency.value = 440;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.2, t + 0.02);
  gain.gain.setValueAtTime(0.2, t + 0.9);
  gain.gain.linearRampToValueAtTime(0, t + 1);
  osc.connect(gain).connect(ctx.destination);
  osc.onended = () => { gain.disconnect(); onEnded(); };
  osc.start(t);
  osc.stop(t + 1);
  return () => {
    try { osc.stop(); } catch { /* already stopped */ }
    osc.disconnect();
    gain.disconnect();
  };
}

/** Drop every service-worker registration, then reload into an uncached app. */
async function unregisterServiceWorkers(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    // no service worker / storage blocked — the reload below is still correct
  }
  location.reload();
}
