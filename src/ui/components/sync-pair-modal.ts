// WiFi sync pairing modal (webrtc-sync.md REQ-5). Serverless: two devices swap
// an offer↔answer blob by copy-paste or QR. Built on the reusable Modal, like
// record-sound-modal.ts. Copy-paste always works; QR display uses the vendored
// encoder; QR scan works on any device with a camera — via the platform
// BarcodeDetector where present, else the vendored jsQR decoder (Windows
// desktop, iOS Safari lack BarcodeDetector).
import { Modal } from './modal';
import { createButton } from './button';
import { copyText, flashCopied } from '../clipboard';
import { qrcode } from '../../vendor/qr';
import { SignalDecodeError } from '../../audio/webrtc-signaling';
import type { WebRtcSyncTransport } from '../../audio/webrtc-sync-transport';
import modalStyles from '../styles/modal.module.css';

type El = HTMLElement;

// QR render tuning (webrtc-sync REQ-5): 1 device-px per module + a 4-module
// quiet zone, then CSS-upscaled to QR_MAX_PX (never downscaled) so a dense
// full-SDP code stays camera-scannable.
const QR_QUIET = 4;
const QR_MAX_PX = 420;

// Connection-feedback tuning (REQ-9).
const CONNECT_WATCHDOG_MS = 12_000;
const CONNECT_FAIL_MSG =
  "Couldn't connect. Make sure both devices are on the same Wi-Fi and the router's " +
  'client isolation ("AP isolation") is off, then try again.';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
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

export function openSyncPairModal(rtc: WebRtcSyncTransport): void {
  let stopScan: (() => void) | null = null;
  let unsub: () => void = () => {};

  // Connection-feedback state (REQ-9): once a peer completes its half we wait for
  // the DataChannels to open. `currentErr` is the active flow's inline message.
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
      if (awaiting && !rtc.linked && currentErr) currentErr.textContent = CONNECT_FAIL_MSG;
    }, CONNECT_WATCHDOG_MS);
  };

  const modal = new Modal({
    title: 'WiFi sync — pair two devices',
    cardClass: Modal.cardWideClass,
    onClose: () => { stopScan?.(); stopScan = null; disarmAwaiting(); unsub(); },
  });

  const tag = el('div', Modal.tagClass,
    'Same WiFi, client isolation off. Create on one device and Join on the other, ' +
    'then swap the codes (copy-paste or scan the QR).');

  // ---- mode toggle ----
  const modeRow = el('div', modalStyles.aiActions);
  const createBtn = createButton({ label: 'Create link', testId: 'sync-pair-create', onClick: () => showCreate() });
  const joinBtn = createButton({ label: 'Join a link', testId: 'sync-pair-join', onClick: () => showJoin() });
  modeRow.appendChild(createBtn);
  modeRow.appendChild(joinBtn);

  const content = el('div');

  const status = el('div', modalStyles.aiLabel, rtc.linked ? 'Linked ✓' : 'Not linked');
  status.dataset.testid = 'sync-pair-status';

  unsub = rtc.onPortsChange(() => {
    if (rtc.linked) {
      status.textContent = 'Linked ✓';
      disarmAwaiting();
      window.setTimeout(() => modal.close(), 1000);
    } else {
      status.textContent = 'Not linked';
      // A teardown while we were waiting means the link failed to open (REQ-9).
      if (awaiting) {
        disarmAwaiting();
        if (currentErr) currentErr.textContent = CONNECT_FAIL_MSG;
      }
    }
  });

  // ---- Create (host): offer out → paste answer in ----
  function showCreate(): void {
    resetContent();
    const offer = readonlyField('Your link (send to the other device)', 'sync-pair-offer');
    const qr = qrCanvas();
    const err = errorLine();
    currentErr = err;
    const answer = inputField('Paste the answer from the other device', 'sync-pair-answer');
    const actions = el('div', modalStyles.aiActions);

    const apply = createButton({
      label: 'Complete link',
      testId: 'sync-pair-apply',
      onClick: () => runGuarded(err, async () => {
        await rtc.acceptAnswer(answer.textarea.value.trim());
        armAwaiting('Connecting… keep both devices on this screen.');
      }),
    });
    actions.appendChild(apply);
    maybeScanButton(actions, err, answer);

    content.appendChild(offer.wrap);
    content.appendChild(qr.wrap);
    content.appendChild(err);
    content.appendChild(answer.wrap);
    content.appendChild(actions);

    // Kick off offer generation.
    err.textContent = 'Generating link…';
    void rtc.createLink().then((blob) => {
      err.textContent = '';
      offer.textarea.value = blob;
      renderQr(qr.canvas, blob);
    }).catch(() => { err.textContent = 'Could not create a link on this network.'; });
  }

  // ---- Join (guest): paste offer in → answer out ----
  function showJoin(): void {
    resetContent();
    const offer = inputField('Paste the link from the other device', 'sync-pair-offer');
    const err = errorLine();
    currentErr = err;
    const answer = readonlyField('Your answer (send back to the other device)', 'sync-pair-answer');
    const qr = qrCanvas();
    const actions = el('div', modalStyles.aiActions);

    const generate = createButton({
      label: 'Generate answer',
      testId: 'sync-pair-generate',
      onClick: () => runGuarded(err, async () => {
        const blob = await rtc.acceptOffer(offer.textarea.value.trim());
        answer.textarea.value = blob;
        renderQr(qr.canvas, blob);
        armAwaiting('Answer ready — send it back. Waiting for the other device to connect…');
      }),
    });
    actions.appendChild(generate);
    maybeScanButton(actions, err, offer);

    content.appendChild(offer.wrap);
    content.appendChild(actions);
    content.appendChild(err);
    content.appendChild(answer.wrap);
    content.appendChild(qr.wrap);
  }

  // ---- small builders ----

  function resetContent(): void {
    stopScan?.();
    stopScan = null;
    disarmAwaiting();
    currentErr = null;
    content.replaceChildren();
  }

  function field(labelText: string, testId: string, readOnly: boolean): { wrap: El; textarea: HTMLTextAreaElement } {
    const wrap = el('div');
    const label = el('label', modalStyles.aiLabel, labelText);
    const textarea = el('textarea', readOnly ? modalStyles.aiText : modalStyles.aiBrief);
    textarea.dataset.testid = testId;
    textarea.readOnly = readOnly;
    if (readOnly) {
      textarea.addEventListener('focus', () => textarea.select());
      const copy = createButton({
        label: 'Copy',
        testId: `${testId}-copy`,
        onClick: () => flashCopied(copy, 'Copy', copyText(textarea.value)),
      });
      wrap.appendChild(label);
      wrap.appendChild(textarea);
      wrap.appendChild(copy);
    } else {
      wrap.appendChild(label);
      wrap.appendChild(textarea);
    }
    return { wrap, textarea };
  }

  const readonlyField = (l: string, id: string) => field(l, id, true);
  const inputField = (l: string, id: string) => field(l, id, false);

  function qrCanvas(): { wrap: El; canvas: HTMLCanvasElement } {
    const wrap = el('div');
    const canvas = el('canvas');
    canvas.dataset.testid = 'sync-pair-qr';
    canvas.style.display = 'none'; // sizing + reveal happen in renderQr
    canvas.style.margin = '12px auto 0';
    canvas.style.maxWidth = '100%';
    wrap.appendChild(canvas);
    return { wrap, canvas };
  }

  function errorLine(): El {
    const e = el('div', modalStyles.aiLabel);
    e.dataset.testid = 'sync-pair-error';
    return e;
  }

  function maybeScanButton(actions: El, err: El, target: { textarea: HTMLTextAreaElement }): void {
    if (!scanSupported()) return; // paste always works; only offer Scan where possible
    const scan = createButton({
      label: 'Scan QR',
      testId: 'sync-pair-scan',
      onClick: () => startScan(err, (text) => { target.textarea.value = text; }),
    });
    actions.appendChild(scan);
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

  async function startScan(err: El, onResult: (text: string) => void): Promise<void> {
    stopScan?.();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = el('video');
      video.setAttribute('playsinline', '');
      video.srcObject = stream;
      video.style.width = '220px';
      video.style.display = 'block';
      content.appendChild(video);
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

  modal.body.appendChild(tag);
  const warning = insecureWarning();
  if (warning) {
    const line = el('div', modalStyles.aiLabel, warning);
    line.dataset.testid = 'sync-pair-insecure';
    line.style.color = 'var(--accent)';
    line.style.textTransform = 'none';
    line.style.letterSpacing = 'normal';
    line.style.lineHeight = '1.5';
    line.style.marginTop = '10px';
    modal.body.appendChild(line);
  }
  modal.body.appendChild(modeRow);
  modal.body.appendChild(content);
  modal.body.appendChild(status);
  modal.open();
  showCreate();
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
