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
    b.addEventListener('click', () => {
      sync.setMode(mode);
      paint(sync.status);
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

  /**
   * The **selected** mode is always the lit segment — that is what makes the
   * setting visibly remembered across a disconnect (midi-clock-sync REQ-19).
   * When it isn't actually running, `armed` desaturates it: selected, not lit
   * (REQ-22).
   */
  const paintMode = (s: SyncStatus): void => {
    const armed = s.mode !== 'off' && s.activeMode === 'off';
    for (const [m, b] of btns) {
      const selected = m === s.mode;
      b.classList.toggle('active', selected);
      b.classList.toggle('armed', selected && armed);
      if (selected && armed) b.title = 'Remembered, but inactive until something is connected';
      else b.title = TITLES[m];
    }
  };

  const paintStatus = (s: SyncStatus): void => {
    status.textContent = statusText(s);
  };

  const paint = (s: SyncStatus): void => {
    paintMode(s);
    paintStatus(s);
  };

  paint(sync.status);
  sync.onStatus(paint);

  return root;
}

const TITLES: Record<SyncMode, string> = {
  off: 'No MIDI transport sync',
  master: 'Broadcast MIDI clock + start/stop to all MIDI outputs',
  slave: 'Follow MIDI clock + start/stop from any MIDI input',
};

function statusText(s: SyncStatus): string {
  const midi = s.links.find((l) => l.id === 'midi');
  const wifi = s.links.find((l) => l.id === 'wifi');

  let text: string;
  if (!midi) text = 'MIDI unavailable';
  else if (midi.ins === 0 && midi.outs === 0) text = 'No MIDI ports';
  else text = `${midi.ins} in · ${midi.outs} out`;

  if (s.activeMode === 'slave') {
    if (s.stalled) text += ' · stalled (free-running)';
    else if (s.followedBpm !== null) text += ` · following ${s.followedBpm.toFixed(1)} BPM`;
  }

  if (wifi) text += wifi.ins > 0 || wifi.outs > 0 ? ' · WiFi: linked' : ' · WiFi: not linked';

  // Spell out *why* an armed mode isn't doing anything (REQ-22) — otherwise a
  // lit-but-inert Slave reads as a bug.
  if (s.mode !== 'off' && s.activeMode === 'off') {
    if (s.mode === 'master') text += ' · Master armed — nothing connected';
    else text += s.links.some((l) => l.ins > 0)
      ? ' · Slave armed — no clock'
      : ' · Slave armed — no link';
  }
  return text;
}
