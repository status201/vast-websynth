// WiFi sync pairing modal (webrtc-sync.md REQ-5). Serverless: two devices swap
// an offer↔answer blob by copy-paste or QR. Built on the reusable Modal, like
// record-sound-modal.ts. Copy-paste always works; QR display uses the vendored
// encoder; QR scan is offered only when a BarcodeDetector is available.
import { Modal } from './modal';
import { createButton } from './button';
import { copyText, flashCopied } from '../clipboard';
import { qrcode } from '../../vendor/qr';
import { SignalDecodeError } from '../../audio/webrtc-signaling';
import type { WebRtcSyncTransport } from '../../audio/webrtc-sync-transport';
import modalStyles from '../styles/modal.module.css';

type El = HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Feature-detect the QR scanner (absent → paste-only; no Scan button). */
function scanSupported(): boolean {
  return typeof (window as { BarcodeDetector?: unknown }).BarcodeDetector !== 'undefined';
}

export function openSyncPairModal(rtc: WebRtcSyncTransport): void {
  let stopScan: (() => void) | null = null;
  let unsub: () => void = () => {};

  const modal = new Modal({
    title: 'WiFi sync — pair two devices',
    cardClass: Modal.cardWideClass,
    onClose: () => { stopScan?.(); stopScan = null; unsub(); },
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
      window.setTimeout(() => modal.close(), 1000);
    } else {
      status.textContent = 'Not linked';
    }
  });

  // ---- Create (host): offer out → paste answer in ----
  function showCreate(): void {
    resetContent();
    const offer = readonlyField('Your link (send to the other device)', 'sync-pair-offer');
    const qr = qrCanvas();
    const err = errorLine();
    const answer = inputField('Paste the answer from the other device', 'sync-pair-answer');
    const actions = el('div', modalStyles.aiActions);

    const apply = createButton({
      label: 'Complete link',
      testId: 'sync-pair-apply',
      onClick: () => runGuarded(err, () => rtc.acceptAnswer(answer.textarea.value.trim())),
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
    canvas.style.width = '180px';
    canvas.style.height = '180px';
    canvas.style.imageRendering = 'pixelated';
    canvas.style.display = 'none'; // shown once a blob is rendered
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
      const Detector = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => { detect(src: unknown): Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
      const detector = new Detector({ formats: ['qr_code'] });
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
          const codes = await detector.detect(video);
          if (codes.length && codes[0]) { onResult(codes[0].rawValue); stop(); return; }
        } catch { /* transient decode error — keep polling */ }
        timer = window.setTimeout(() => void poll(), 300);
      };
      timer = window.setTimeout(() => void poll(), 300);
    } catch {
      err.textContent = 'Camera unavailable — paste the code instead.';
    }
  }

  modal.body.appendChild(tag);
  modal.body.appendChild(modeRow);
  modal.body.appendChild(content);
  modal.body.appendChild(status);
  modal.open();
  showCreate();
}

/** Paint a QR of `text` onto `canvas` (auto version, EC level L). Hidden on overflow. */
function renderQr(canvas: HTMLCanvasElement, text: string): void {
  try {
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const cell = 4;
    const margin = cell * 4;
    const size = count * cell + margin * 2;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / no 2d context — paste still works
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
      }
    }
    canvas.style.display = 'block';
  } catch {
    canvas.style.display = 'none'; // blob too large for a QR — copy-paste covers it
  }
}
