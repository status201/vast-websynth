import { Modal } from './modal';
import { createButton } from './button';
import { copyText, flashCopied } from '../clipboard';
import switchStyles from '../styles/switch.module.css';
import segmentedStyles from '../styles/segmented.module.css';
import dialogStyles from '../styles/dialog.module.css';
import styles from '../styles/export-song-modal.module.css';

/**
 * The Export chooser (project-export.md REQ-4): Song (.json) — the unchanged
 * default — or Project (.zip, song + sampler audio clips). Built on the shared
 * {@link Modal}. The Project row is disabled with an explanation when no
 * sampler slot has audio loaded; picking Project reveals a local-state WAV/MP3
 * clip-format toggle (WAV default; MP3 shows a length caveat).
 */

export type ExportKind = 'json' | 'project';
export type ClipFormat = 'wav' | 'mp3';

export interface ExportSongModalOptions {
  /** Whether any sampler slot has a decoded buffer (enables the Project row). */
  hasSamplerAudio: boolean;
  /** Called once on confirm, after the modal closes. Never called on cancel. */
  onExport: (kind: ExportKind, fmt: ClipFormat) => void;
  /**
   * When provided, renders a "Copy Link" action (testid `song-share-link`)
   * that copies a shareable URL for the current song (song-share-link.md
   * REQ-5). Independent of the export-kind rows; does not close the modal.
   */
  makeShareUrl?: () => Promise<string>;
}

export function openExportSongModal(opts: ExportSongModalOptions): void {
  let kind: ExportKind = 'json';
  let fmt: ClipFormat = 'wav';
  let confirmed = false;

  const modal = new Modal({
    title: 'Export song',
    onClose: () => {
      if (confirmed) opts.onExport(kind, fmt);
    },
  });
  modal.body.dataset.testid = 'export-modal';

  // ---- kind rows (radio-style) ----
  const rows = document.createElement('div');
  rows.className = styles.rows!;

  const makeRow = (title: string, desc: string, testId: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = styles.row!;
    b.dataset.testid = testId;
    const t = document.createElement('span');
    t.className = styles.rowTitle!;
    t.textContent = title;
    const d = document.createElement('span');
    d.className = styles.rowDesc!;
    d.textContent = desc;
    b.appendChild(t);
    b.appendChild(d);
    return b;
  };

  const jsonRow = makeRow('Song (.json)', 'Patterns, params and arrangement — audio not included.', 'export-kind-json');
  const projectRow = makeRow('Project (.zip)', 'The song plus every loaded sampler clip, importable in one step.', 'export-kind-project');
  rows.appendChild(jsonRow);
  rows.appendChild(projectRow);
  modal.body.appendChild(rows);

  const projectNote = document.createElement('p');
  projectNote.className = styles.note!;
  projectNote.dataset.testid = 'export-project-note';
  projectNote.textContent = 'No sampler audio loaded — a project would contain only the song.';
  modal.body.appendChild(projectNote);

  // ---- clip format (Project only; local state, not a ParamBus param) ----
  const fmtRow = document.createElement('div');
  fmtRow.className = styles.fmtRow!;
  const fmtLabel = document.createElement('span');
  fmtLabel.className = styles.fmtLabel!;
  fmtLabel.textContent = 'Clips:';
  fmtRow.appendChild(fmtLabel);

  const fmtSel = document.createElement('div');
  fmtSel.className = segmentedStyles.root!;
  const fmtBtns: HTMLButtonElement[] = [];
  (['wav', 'mp3'] as ClipFormat[]).forEach((f) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = f.toUpperCase();
    b.dataset.testid = `export-fmt-${f}`;
    if (f === fmt) b.classList.add('active');
    b.addEventListener('click', () => {
      fmt = f;
      for (const c of fmtBtns) c.classList.toggle('active', c === b);
      render();
    });
    fmtBtns.push(b);
    fmtSel.appendChild(b);
  });
  fmtRow.appendChild(fmtSel);
  modal.body.appendChild(fmtRow);

  const mp3Note = document.createElement('p');
  mp3Note.className = styles.note!;
  mp3Note.textContent = 'MP3 encoder padding slightly alters clip length — bar-exact loops may drift; use WAV for those.';
  modal.body.appendChild(mp3Note);

  // ---- actions ----
  const actions = document.createElement('div');
  actions.className = dialogStyles.actions!;
  if (opts.makeShareUrl) {
    const makeShareUrl = opts.makeShareUrl;
    const shareBtn = createButton({
      label: 'Copy Link',
      className: switchStyles.root!,
      testId: 'song-share-link',
      onClick: () => flashCopied(
        shareBtn,
        'Copy Link',
        makeShareUrl().then((url) => copyText(url)),
      ),
    });
    shareBtn.title = 'Copy a shareable URL that opens this song';
    actions.appendChild(shareBtn);
  }
  actions.appendChild(createButton({
    label: 'Cancel',
    className: switchStyles.root!,
    testId: 'export-cancel',
    onClick: () => modal.close(),
  }));
  const confirmBtn = createButton({
    label: 'Export',
    className: switchStyles.root!,
    testId: 'export-confirm',
    onClick: () => { confirmed = true; modal.close(); },
  });
  actions.appendChild(confirmBtn);
  modal.body.appendChild(actions);

  const render = (): void => {
    jsonRow.classList.toggle('on', kind === 'json');
    projectRow.classList.toggle('on', kind === 'project');
    projectRow.disabled = !opts.hasSamplerAudio;
    projectNote.style.display = opts.hasSamplerAudio ? 'none' : '';
    fmtRow.style.display = kind === 'project' ? '' : 'none';
    mp3Note.style.display = kind === 'project' && fmt === 'mp3' ? '' : 'none';
  };

  jsonRow.addEventListener('click', () => { kind = 'json'; render(); });
  projectRow.addEventListener('click', () => {
    if (projectRow.disabled) return;
    kind = 'project';
    render();
  });

  render();
  modal.open();
  confirmBtn.focus();
}
