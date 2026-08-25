// WiFi sync pairing wizard (webrtc-sync.md REQ-5/REQ-9/REQ-10). Serverless: two
// devices swap an offer↔answer blob by QR or copy-paste. A **linear wizard** —
// Choose a role → (Master: show offer → get answer | Slave: get offer → show
// answer) → Linked — presenting one step at a time so the two-way handshake is
// foolproof. Built on the reusable Modal (backdrop-dismiss disabled so a stray
// outside click can't discard progress). QR display uses the vendored encoder;
// QR scan uses the platform BarcodeDetector where present, else the vendored
// jsQR decoder (Windows desktop, iOS Safari lack BarcodeDetector).
import { Modal } from './modal';
import { createButton } from './button';
import { copyText, flashCopied } from '../clipboard';
import { qrcode } from '../../vendor/qr';
import { SignalDecodeError } from '../../audio/webrtc-signaling';
import type { WebRtcSyncTransport } from '../../audio/webrtc-sync-transport';
import type { SyncController } from '../../audio/transport/sync/sync-controller';
import { type WebRtcDiagnostics, summarizeDiagnostics } from '../../audio/webrtc-diagnostics';
import modalStyles from '../styles/modal.module.css';
import { UI_ICONS, iconLabel, iconTextEl, type IconName } from './ui-icons';

type El = HTMLElement;

// QR render tuning (webrtc-sync REQ-5): 1 device-px per module + a 4-module
// quiet zone, then CSS-upscaled to QR_MAX_PX (never downscaled) so a dense
// full-SDP code stays camera-scannable.
const QR_QUIET = 4;
const QR_MAX_PX = 420;

// Textareas are half the shared modal heights (aiText 320 / aiBrief 84) — the QR
// + Copy are the primary transfer; the text blob is a fallback (REQ-5).
const READONLY_TA_PX = 160;
const INPUT_TA_PX = 42;

// Connection-feedback tuning (REQ-9). Causes ordered most-common-first — a
// firewall is the usual laptop culprit (confirmed in the field).
const CONNECT_WATCHDOG_MS = 12_000;
const CONNECT_FAIL_MSG =
  "Couldn't connect. On a laptop this is usually a firewall blocking the browser — allow it "
  + 'through Windows Defender Firewall, or set the Wi-Fi network to Private. A VPN or a virtual '
  + 'network adapter (WSL, Docker, Hyper-V, VirtualBox) can also block it. Make sure both devices '
  + 'are on the same Wi-Fi with client isolation ("AP isolation") off. See the connection details below.';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Sans-serif body/intro/instruction text — the type rule reserves serif for
 *  titles, subtitles and taglines (webrtc-sync REQ-5). */
function bodyText(text: string): HTMLDivElement {
  const p = el('div', undefined, text);
  p.style.fontFamily = 'var(--sans)';
  p.style.fontSize = '12.5px';
  p.style.lineHeight = '1.55';
  p.style.color = 'var(--text-dim)';
  return p;
}

/**
 * Whether to offer QR scan: we can scan on any device with a **camera** — the
 * decoder is always available (BarcodeDetector fast path, else vendored jsQR),
 * so the only gate is `getUserMedia`. (Absent in jsdom + non-camera devices →
 * no Scan button; paste always works.)
 */
function scanSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/** True when the platform QR reader is available (fast path); else jsQR is used. */
function hasBarcodeDetector(): boolean {
  return typeof (window as { BarcodeDetector?: unknown }).BarcodeDetector !== 'undefined';
}

/** A non-blocking reason WiFi pairing may misbehave here (REQ-8); null = fine. */
function insecureWarning(): string | null {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return 'WiFi sync needs a secure connection. Open the app over https:// on both devices — '
      + 'plain http://<ip> blocks WebRTC, the clipboard and the QR camera.';
  }
  return null;
}

/** Render the connection-failure guidance readably (REQ-9) — the aiLabel style is
 *  uppercase + letter-spaced, an unreadable wall for a full sentence. */
function showConnectFailure(target: El): void {
  target.textContent = CONNECT_FAIL_MSG;
  target.style.textTransform = 'none';
  target.style.letterSpacing = 'normal';
  target.style.lineHeight = '1.5';
  target.style.color = 'var(--accent)';
}

/**
 * Open the WiFi-sync pairing wizard. `sync` is narrowed to `setMode` (ISP): the
 * role choice sets Master/Slave so the pairing UI and the Sync section's
 * Off/Master/Slave control agree (REQ-5).
 */
export function openSyncPairModal(rtc: WebRtcSyncTransport, sync: Pick<SyncController, 'setMode'>): void {
  let stopScan: (() => void) | null = null;
  let unsub: () => void = () => {};
  let unsubDiag: () => void = () => {};

  // Connection-feedback state (REQ-9): once a peer completes its half we wait for
  // the DataChannels to open. `currentErr` is the active step's inline message.
  let currentErr: El | null = null;
  let awaiting = false;
  let connectWatchdog = 0;

  const disarmAwaiting = (): void => {
    awaiting = false;
    window.clearTimeout(connectWatchdog);
    connectWatchdog = 0;
  };

  const armAwaiting = (msg: string): void => {
    awaiting = true;
    if (currentErr) currentErr.textContent = msg;
    window.clearTimeout(connectWatchdog);
    connectWatchdog = window.setTimeout(() => {
      if (awaiting && !rtc.linked && currentErr) showConnectFailure(currentErr);
    }, CONNECT_WATCHDOG_MS);
  };

  const modal = new Modal({
    title: 'WiFi sync — pair two devices',
    cardClass: Modal.cardWideClass,
    dismissOnBackdrop: false, // multi-step flow — an outside click must not discard it (REQ-10)
    onClose: () => { stopScan?.(); stopScan = null; disarmAwaiting(); unsub(); unsubDiag(); },
  });

  const content = el('div'); // the step area — replaced per wizard step

  const status = el('div', modalStyles.aiLabel);
  /** "Linked ✓" / "Not linked" — the tick is drawn, so it is replaced wholesale
   *  rather than written as text (iconography.md REQ-1). */
  const setStatus = (): void => {
    status.replaceChildren(
      rtc.linked ? iconTextEl('check', 'Linked', 'after') : document.createTextNode('Not linked'),
    );
  };
  setStatus();
  status.dataset.testid = 'sync-pair-status';

  unsub = rtc.onPortsChange(() => {
    if (rtc.linked) {
      setStatus();
      disarmAwaiting();
      showLinked();
      window.setTimeout(() => modal.close(), 1200);
    } else {
      status.textContent = 'Not linked';
      // A teardown while we were waiting means the link failed to open (REQ-9).
      if (awaiting) {
        disarmAwaiting();
        if (currentErr) showConnectFailure(currentErr);
      }
    }
  });

  // ---- steps ----

  /** Entry: pick a role. Create → Master, Join → Slave (also sets the mode). */
  function showChoose(): void {
    resetContent();
    const box = el('div');
    box.appendChild(roleChoice('Create Link', 'sync-pair-create', 'This device leads · becomes Master',
      () => { sync.setMode('master'); showMasterShow(); }));
    box.appendChild(roleChoice('Join a Link', 'sync-pair-join', 'This device follows · becomes Slave',
      () => { sync.setMode('slave'); showSlaveEnter(); }));
    content.appendChild(stepFrame({
      heading: 'Pair over Wi-Fi',
      hints: [
        'One device creates the link and leads (Master); the other joins and follows (Slave).',
        'Both must be on the same Wi-Fi.',
      ],
      body: box,
    }));
  }

  /** A big, prominent role button with a centred caption beneath it. */
  function roleChoice(label: string, testId: string, caption: string, onClick: () => void): El {
    const wrap = el('div');
    wrap.style.marginTop = '18px';
    const btn = createButton({ label, testId, onClick });
    btn.style.width = '100%';
    btn.style.justifyContent = 'center';
    btn.style.padding = '13px';
    btn.style.fontSize = '15px';
    const cap = bodyText(caption);
    cap.style.textAlign = 'center';
    cap.style.marginTop = '6px';
    wrap.appendChild(btn);
    wrap.appendChild(cap);
    return wrap;
  }

  /** Master step 1: show the offer, generate it, gate Next until it's ready. */
  function showMasterShow(): void {
    resetContent();
    const err = errorLine();
    currentErr = err;
    const panel = qrPanel('sync-pair-offer');
    const nav = navRow({
      back: () => showChoose(),
      primary: {
        label: 'Next',
        iconAfter: UI_ICONS.arrowRight,
        testId: 'sync-pair-next',
        disabled: true,
        onClick: () => showMasterReply(),
      },
    });
    content.appendChild(stepFrame({
      step: 'Step 1 of 2 · Create Link',
      heading: 'Show this to the other device',
      hints: ['On the other device, tap "Join a Link", then scan this code (or paste the text).'],
      body: panel.wrap,
      nav: nav.row,
    }));
    content.appendChild(err);

    err.textContent = 'Generating link…';
    void rtc.createLink().then((blob) => {
      err.textContent = '';
      panel.setBlob(blob);
      if (nav.primaryBtn) nav.primaryBtn.disabled = false;
    }).catch(() => { err.textContent = 'Could not create a link on this network.'; });
  }

  /** Master step 2: scan/paste the answer, then complete the link. */
  function showMasterReply(): void {
    resetContent();
    const err = errorLine();
    currentErr = err;
    const panel = scanPanel('sync-pair-answer', err);
    const nav = navRow({
      back: () => showMasterShow(),
      primary: {
        label: 'Complete link', testId: 'sync-pair-apply',
        onClick: () => runGuarded(err, async () => {
          await rtc.acceptAnswer(panel.getValue());
          armAwaiting('Connecting… keep both devices on this screen.');
        }),
      },
    });
    content.appendChild(stepFrame({
      step: 'Step 2 of 2 · Create Link',
      heading: 'Enter the reply',
      hints: ['Scan the reply the other device now shows — or paste it below.'],
      body: panel.wrap,
      nav: nav.row,
    }));
    content.appendChild(err);
  }

  /** Slave step 1: scan/paste the offer, then generate the answer. */
  function showSlaveEnter(): void {
    resetContent();
    const err = errorLine();
    currentErr = err;
    const panel = scanPanel('sync-pair-offer', err);
    const nav = navRow({
      back: () => showChoose(),
      primary: {
        label: 'Generate reply', testId: 'sync-pair-generate',
        onClick: () => runGuarded(err, async () => {
          const blob = await rtc.acceptOffer(panel.getValue());
          showSlaveReply(blob);
        }),
      },
    });
    content.appendChild(stepFrame({
      step: 'Step 1 of 2 · Join a Link',
      heading: "Enter the other device's link",
      hints: ['Scan the code on the other device — or paste it below.'],
      body: panel.wrap,
      nav: nav.row,
    }));
    content.appendChild(err);
  }

  /** Slave step 2: show the answer back; wait for the master to connect. */
  function showSlaveReply(answerBlob: string): void {
    resetContent();
    const err = errorLine();
    currentErr = err;
    const panel = qrPanel('sync-pair-answer');
    panel.setBlob(answerBlob);
    const nav = navRow({ back: () => showSlaveEnter() });
    content.appendChild(stepFrame({
      step: 'Step 2 of 2 · Join a Link',
      heading: 'Show this reply back',
      hints: ['On the first device, tap "Complete link" and scan this (or paste the text).'],
      body: panel.wrap,
      nav: nav.row,
    }));
    content.appendChild(err);
    armAwaiting('Waiting for the other device to connect…');
  }

  /** Success: swap in a confirmation; the modal self-closes shortly after. */
  function showLinked(): void {
    resetContent();
    content.appendChild(stepFrame({
      heading: 'Linked',
      headingIcon: 'check',
      hints: ['The two devices are synced. This will close automatically.'],
      body: el('div'),
    }));
  }

  // ---- reusable builders (DRY) ----

  function resetContent(): void {
    stopScan?.();
    stopScan = null;
    disarmAwaiting();
    currentErr = null;
    content.replaceChildren();
  }

  /** Consistent wizard chrome: step label, heading, instruction lines, body, nav. */
  function stepFrame(o: {
    step?: string; heading: string; headingIcon?: IconName; hints?: string[]; body: El; nav?: El;
  }): El {
    const frame = el('div');
    if (o.step) frame.appendChild(el('div', modalStyles.aiLabel, o.step));
    // A heading mark is drawn, never typed — a ✓ character comes back as a
    // colour emoji on Android (iconography.md REQ-1).
    const h = o.headingIcon
      ? (() => { const d = el('div'); d.innerHTML = iconLabel(o.headingIcon, o.heading, 'after'); return d; })()
      : el('div', undefined, o.heading); // subtitle → serif (per the type rule)
    h.style.fontFamily = 'var(--serif)';
    h.style.fontSize = '16px';
    h.style.fontWeight = '700';
    h.style.color = 'var(--text)';
    h.style.marginTop = o.step ? '6px' : '2px';
    frame.appendChild(h);
    (o.hints ?? []).forEach((hint, i) => {
      const p = bodyText(hint); // intro/instruction → sans-serif
      p.style.marginTop = i === 0 ? '8px' : '3px';
      frame.appendChild(p);
    });
    const bodyWrap = el('div');
    bodyWrap.style.marginTop = '14px';
    bodyWrap.appendChild(o.body);
    frame.appendChild(bodyWrap);
    if (o.nav) { o.nav.style.marginTop = '16px'; frame.appendChild(o.nav); }
    return frame;
  }

  function navRow(o: {
    back?: () => void;
    primary?: {
      label: string; testId: string; onClick: () => void; disabled?: boolean; iconAfter?: string;
    };
  }): { row: El; primaryBtn: HTMLButtonElement | null } {
    const row = el('div', modalStyles.aiActions);
    let primaryBtn: HTMLButtonElement | null = null;
    if (o.back) {
      row.appendChild(createButton({
        label: 'Back', iconBefore: UI_ICONS.arrowLeft, testId: 'sync-pair-back', onClick: o.back,
      }));
    }
    if (o.primary) {
      primaryBtn = createButton({
        label: o.primary.label,
        iconAfter: o.primary.iconAfter,
        testId: o.primary.testId,
        onClick: o.primary.onClick,
      });
      if (o.primary.disabled) primaryBtn.disabled = true;
      row.appendChild(primaryBtn);
    }
    return { row, primaryBtn };
  }

  /** QR + Copy + a half-height readonly text fallback, for an outgoing blob. */
  function qrPanel(textareaTestid: string): { wrap: El; setBlob: (blob: string) => void } {
    const wrap = el('div');
    const canvas = el('canvas');
    canvas.dataset.testid = 'sync-pair-qr';
    canvas.style.display = 'none'; // sizing + reveal happen in renderQr
    canvas.style.margin = '0 auto 12px';
    canvas.style.maxWidth = '100%';
    const ta = readonlyTextarea(textareaTestid);
    const copy = createButton({
      label: 'Copy',
      testId: `${textareaTestid}-copy`,
      onClick: () => flashCopied(copy, 'Copy', copyText(ta.value)),
    });
    wrap.appendChild(canvas);
    wrap.appendChild(ta);
    wrap.appendChild(copy);
    return { wrap, setBlob: (blob) => { ta.value = blob; renderQr(canvas, blob); } };
  }

  /** Scan (where a camera exists) + a half-height paste box, for an incoming blob. */
  function scanPanel(inputTestid: string, err: El): { wrap: El; getValue: () => string } {
    const wrap = el('div');
    const ta = inputTextarea(inputTestid);
    wrap.appendChild(ta);
    if (scanSupported()) {
      const scan = createButton({
        label: 'Scan QR',
        testId: 'sync-pair-scan',
        onClick: () => void startScan(err, wrap, (text) => { ta.value = text; }),
      });
      wrap.appendChild(scan);
    }
    return { wrap, getValue: () => ta.value.trim() };
  }

  function readonlyTextarea(testId: string): HTMLTextAreaElement {
    const ta = el('textarea', modalStyles.aiText);
    ta.dataset.testid = testId;
    ta.readOnly = true;
    ta.style.height = `${READONLY_TA_PX}px`;
    ta.addEventListener('focus', () => ta.select());
    return ta;
  }

  function inputTextarea(testId: string): HTMLTextAreaElement {
    const ta = el('textarea', modalStyles.aiBrief);
    ta.dataset.testid = testId;
    ta.placeholder = 'Paste the code here…';
    ta.style.height = `${INPUT_TA_PX}px`;
    return ta;
  }

  function errorLine(): El {
    const e = el('div', modalStyles.aiLabel);
    e.dataset.testid = 'sync-pair-error';
    return e;
  }

  async function runGuarded(err: El, fn: () => Promise<unknown>): Promise<void> {
    err.textContent = '';
    try {
      await fn();
    } catch (e) {
      err.textContent = e instanceof SignalDecodeError ? e.message
        : e instanceof Error && e.message ? e.message
        : 'Pairing failed — check the code and try again.';
    }
  }

  async function startScan(err: El, mount: El, onResult: (text: string) => void): Promise<void> {
    stopScan?.();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = el('video');
      video.setAttribute('playsinline', '');
      video.srcObject = stream;
      video.style.width = '220px';
      video.style.display = 'block';
      video.style.margin = '10px 0 0';
      mount.appendChild(video);
      await video.play().catch(() => {});
      const detect = await makeFrameDetector(); // BarcodeDetector fast path, else jsQR
      let timer = 0;
      const stop = (): void => {
        window.clearTimeout(timer);
        stream.getTracks().forEach((t) => t.stop());
        video.remove();
        stopScan = null;
      };
      stopScan = stop;
      const poll = async (): Promise<void> => {
        try {
          const text = await detect(video);
          if (text) { onResult(text); stop(); return; }
        } catch { /* transient decode error — keep polling */ }
        timer = window.setTimeout(() => void poll(), 300);
      };
      timer = window.setTimeout(() => void poll(), 300);
    } catch {
      err.textContent = 'Camera unavailable — paste the code instead.';
    }
  }

  // ---- assemble ----
  const warning = insecureWarning();
  if (warning) {
    const line = el('div', modalStyles.aiLabel, warning);
    line.dataset.testid = 'sync-pair-insecure';
    line.style.color = 'var(--accent)';
    line.style.textTransform = 'none';
    line.style.letterSpacing = 'normal';
    line.style.lineHeight = '1.5';
    line.style.marginBottom = '4px';
    modal.body.appendChild(line);
  }
  modal.body.appendChild(content);
  modal.body.appendChild(status);

  // Live per-attempt diagnostics under the status/error (REQ-11).
  const debug = buildDebugPanel();
  unsubDiag = rtc.onDiagnostics(() => debug.update(rtc.diagnostics));
  modal.body.appendChild(debug.el);

  // Default (base) button styling + full-width layout — Modal.closeBtnClass is
  // layout-only and would drop the button chrome (createButton replaces the class).
  const closeBtn = createButton({ label: 'Close', testId: 'sync-pair-close', onClick: () => modal.close() });
  closeBtn.style.width = '100%';
  closeBtn.style.justifyContent = 'center';
  closeBtn.style.marginTop = '20px';
  modal.body.appendChild(closeBtn);
  modal.open();
  showChoose();
}

/** A collapsible "Connection details" panel fed by the transport's diagnostics
 *  (REQ-11); hidden until a pairing attempt produces data. */
function buildDebugPanel(): { el: HTMLElement; update: (d: WebRtcDiagnostics) => void } {
  const details = document.createElement('details');
  details.dataset.testid = 'sync-pair-debug';
  details.style.marginTop = '10px';
  details.style.display = 'none';
  const summary = el('summary', undefined, 'Connection details');
  summary.style.cursor = 'pointer';
  summary.style.fontSize = '11px';
  summary.style.letterSpacing = '0.06em';
  summary.style.color = 'var(--text-dim)';
  const body = el('div');
  body.style.marginTop = '6px';
  details.appendChild(summary);
  details.appendChild(body);
  return {
    el: details,
    update: (d) => { renderDiagnosticsInto(body, d); details.style.display = 'block'; },
  };
}

/** Render a diagnostics snapshot (raw facts + plain-language hints) into `body`.
 *  Exported for the unit test. */
export function renderDiagnosticsInto(body: HTMLElement, d: WebRtcDiagnostics): void {
  const lines: string[] = [];
  if (d.iceHistory.length) lines.push('ICE: ' + d.iceHistory.join(' → '));
  if (d.connHistory.length) lines.push('Connection: ' + d.connHistory.join(' → '));
  lines.push('Gathering: ' + d.gathering);
  if (d.localCandidates.length) {
    lines.push('Local candidates:');
    for (const c of d.localCandidates) lines.push(`  ${c.type} ${c.protocol} ${c.address}`);
  }
  lines.push('Remote candidates received: ' + d.remoteCandidateCount);
  lines.push('Selected pair: ' + (d.selectedPair
    ? `${d.selectedPair.local.address} ↔ ${d.selectedPair.remote.address}`
    : 'none'));
  if (d.candidateErrors.length) lines.push('Candidate errors: ' + d.candidateErrors.join('; '));

  body.replaceChildren();
  const facts = el('div', undefined, lines.join('\n'));
  facts.style.fontFamily = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
  facts.style.fontSize = '10.5px';
  facts.style.lineHeight = '1.5';
  facts.style.color = 'var(--text-dim)';
  facts.style.whiteSpace = 'pre-wrap';
  facts.style.wordBreak = 'break-all';
  body.appendChild(facts);

  for (const hint of summarizeDiagnostics(d)) {
    const h = el('div');
    h.appendChild(iconTextEl('bulb', hint));
    h.style.color = 'var(--accent)';
    h.style.fontSize = '11.5px';
    h.style.lineHeight = '1.5';
    h.style.marginTop = '8px';
    body.appendChild(h);
  }
}

/** Longest side (px) the jsQR fallback samples a camera frame at — enough to
 *  resolve a dense QR held to fill the frame, cheap enough to run a few times/s. */
const SCAN_SAMPLE_MAX = 640;

/**
 * A per-frame QR reader (webrtc-sync REQ-5): the platform `BarcodeDetector`
 * where available (fast, hardware-accelerated), else the vendored jsQR decoder
 * driven off a `<canvas>` frame — so scanning works on Windows desktop and iOS
 * Safari, which ship no BarcodeDetector. Returns the decoded text or null.
 *
 * The jsQR decoder is `import()`ed lazily here (REQ-7), so the ~large bundle is
 * fetched only when a device without `BarcodeDetector` actually starts a scan.
 */
async function makeFrameDetector(): Promise<(video: HTMLVideoElement) => Promise<string | null>> {
  if (hasBarcodeDetector()) {
    const Detector = (window as unknown as {
      BarcodeDetector: new (o: { formats: string[] }) => { detect(src: unknown): Promise<Array<{ rawValue: string }>> };
    }).BarcodeDetector;
    const detector = new Detector({ formats: ['qr_code'] });
    return async (video) => {
      const codes = await detector.detect(video);
      return codes.length && codes[0] ? codes[0].rawValue : null;
    };
  }
  // jsQR fallback: sample the frame through a scratch canvas, capped in size.
  const { jsQR } = await import('../../vendor/jsqr');
  const scratch = document.createElement('canvas');
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !ctx) return null;
    const scale = Math.min(1, SCAN_SAMPLE_MAX / Math.max(vw, vh));
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    scratch.width = w;
    scratch.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const res = jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
    return res ? res.data : null;
  };
}

/**
 * Paint a QR of `text` onto `canvas` (auto version, EC level L) so it is
 * **camera-scannable** (webrtc-sync REQ-5). The bitmap is drawn at **one
 * device-pixel per module** plus a 4-module quiet zone, then CSS-**upscaled**
 * (never downscaled) with `image-rendering: pixelated` to a viewport-responsive
 * display size — crisp, square modules with plenty of pixels each. Exported for
 * the regression test. Hidden on overflow (blob too large for any version).
 */
export function renderQr(canvas: HTMLCanvasElement, text: string): void {
  try {
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const dim = count + QR_QUIET * 2; // 1px/module + quiet zone on all sides
    canvas.width = dim;
    canvas.height = dim;

    // Upscale a small crisp bitmap to a large display box — do NOT draw a big
    // bitmap and clamp it down (the v1 bug: ~2 px/module, unscannable).
    const vw = typeof window !== 'undefined' ? window.innerWidth : QR_MAX_PX;
    const displayPx = Math.min(QR_MAX_PX, Math.round(vw * 0.92));
    canvas.style.width = `${displayPx}px`;
    canvas.style.height = `${displayPx}px`;
    canvas.style.imageRendering = 'pixelated';

    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / no 2d context — paste still works, sizing already set
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(QR_QUIET + c, QR_QUIET + r, 1, 1);
      }
    }
    canvas.style.display = 'block';
  } catch {
    canvas.style.display = 'none'; // blob too large for a QR — copy-paste covers it
  }
}
