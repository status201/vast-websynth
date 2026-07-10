import type { SyncController } from '../../audio/transport/sync/sync-controller';
import type { SyncMode, SyncStatus } from '../../audio/transport/sync/sync-types';
import type { WebRtcSyncTransport } from '../../audio/webrtc-sync-transport';
import { createButton } from './button';
import segmentedStyles from '../styles/segmented.module.css';
import switchStyles from '../styles/switch.module.css';
import styles from '../styles/song-panel.module.css';

/**
 * The Song panel's "Sync" section (midi-clock-sync REQ-8): a three-way
 * Off/Master/Slave control plus a status line. Not a bus-bound `Segmented` —
 * the mode is device-scoped state on the SyncController, never a param
 * (precedent: the WAV/MP3 format selector in song-panel.ts).
 */

const MODES: Array<[label: string, mode: SyncMode]> = [
  ['Off', 'off'],
  ['Master', 'master'],
  ['Slave', 'slave'],
];

export function buildSyncSection(sync: SyncController, rtc: WebRtcSyncTransport): HTMLElement {
  const root = document.createElement('div');
  root.className = styles.io!;

  const label = document.createElement('div');
  label.className = styles.sectionLabel!;
  label.textContent = 'Sync';
  root.appendChild(label);

  const ioLabel = document.createElement('span');
  ioLabel.className = styles.ioLabel!;
  ioLabel.textContent = 'MIDI clock:';
  root.appendChild(ioLabel);

  const sel = document.createElement('div');
  sel.className = segmentedStyles.root!;
  const btns = new Map<SyncMode, HTMLButtonElement>();
  for (const [lbl, mode] of MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = lbl;
    b.dataset.testid = `sync-mode-${mode}`;
    b.title = mode === 'master'
      ? 'Broadcast MIDI clock + start/stop to all MIDI outputs'
      : mode === 'slave'
        ? 'Follow MIDI clock + start/stop from any MIDI input'
        : 'No MIDI transport sync';
    b.addEventListener('click', () => {
      sync.setMode(mode);
      paintMode(sync.mode);
    });
    btns.set(mode, b);
    sel.appendChild(b);
  }
  root.appendChild(sel);

  const status = document.createElement('span');
  status.className = styles.ioLabel!;
  status.dataset.testid = 'sync-status';
  root.appendChild(status);

  // WiFi pairing (WebRTC) — coexists with MIDI; opens the serverless pair modal.
  // Lazy-loaded: pairing is rare, so the modal (+ vendored QR encoder) is
  // code-split out of the initial bundle (webrtc-sync REQ-7).
  const wifiBtn = createButton({
    label: 'WiFi link…',
    className: switchStyles.root!,
    testId: 'sync-wifi-link',
    onClick: () => { void import('./sync-pair-modal').then((m) => m.openSyncPairModal(rtc, sync)); },
  });
  wifiBtn.title = 'Pair another device over WiFi (same network, client isolation off)';
  root.appendChild(wifiBtn);

  const paintMode = (mode: SyncMode): void => {
    for (const [m, b] of btns) b.classList.toggle('active', m === mode);
  };

  const paintStatus = (s: SyncStatus): void => {
    status.textContent = statusText(s);
  };

  paintMode(sync.mode);
  paintStatus(sync.status);
  sync.onStatus((s) => {
    paintMode(s.mode);
    paintStatus(s);
  });

  return root;
}

function statusText(s: SyncStatus): string {
  const midi = s.links.find((l) => l.id === 'midi');
  const wifi = s.links.find((l) => l.id === 'wifi');

  let text: string;
  if (!midi) text = 'MIDI unavailable';
  else if (midi.ins === 0 && midi.outs === 0) text = 'No MIDI ports';
  else text = `${midi.ins} in · ${midi.outs} out`;

  if (s.mode === 'slave') {
    if (s.stalled) text += ' · stalled (free-running)';
    else if (s.followedBpm !== null) text += ` · following ${s.followedBpm.toFixed(1)} BPM`;
  }

  if (wifi) text += wifi.ins > 0 || wifi.outs > 0 ? ' · WiFi: linked' : ' · WiFi: not linked';
  return text;
}
