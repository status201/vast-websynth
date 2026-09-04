import { Modal } from './modal';
import { createButton, setButtonLabel } from './button';
import { readClipboardText } from '../clipboard';
import { classifyPayload, type PasteClassification } from '../../state/paste-payload';
import { parsePresetPayload, type PresetParse } from '../../state/preset-file';
import type { ParamBus } from '../../state/params';
import switchStyles from '../styles/switch.module.css';
import styles from '../styles/modal.module.css';

/**
 * The paste door — `specs/features/paste-import.md`. AI agents answer in chat,
 * not with a download, so the JSON they emit needs a way in that isn't "save it
 * to disk first".
 *
 * This module classifies and **routes**; it never validates or applies anything
 * itself (REQ-7). A song goes through `SongPanel.importBytes` — the same path the
 * file input uses, so error dialogs, the undo toast and the Play cue come free —
 * and a preset/bank goes into the preset manager's existing review step.
 *
 * `buildPasteImport` is a *fragment* rather than only a modal because it has two
 * homes: inline as step 3 of the ✨ AI Prompt modal (where the JSON actually
 * arrives) and inside `openPasteImportModal` behind the Song row's Paste button
 * (REQ-5). One implementation, two placements.
 */

export interface PasteImportOptions {
  /** Import pasted song bytes — `SongPanel.importBytes`. Resolves to applied?. */
  onSong: (bytes: Uint8Array, name: string) => Promise<boolean>;
  /** Hand a parsed preset/bank payload to the import wizard. */
  onPresets: (parse: PresetParse) => void;
  /**
   * The live registry, so a pasted preset gets the same warnings a chosen file
   * does (preset-authoring.md REQ-8). Omitted → structural checks only.
   */
  bus?: ParamBus;
  /** Successful hand-off — the host closes itself (REQ-8: not called on failure). */
  onDone?: () => void;
  /** Renders a Cancel button beside the confirm (the modal wrapper passes one). */
  onCancel?: () => void;
  /** Section label above the textarea. */
  label?: string;
}

export interface PasteImport {
  el: HTMLElement;
  focus: () => void;
}

const PLACEHOLDER =
  'Paste the reply here — ```json fences and the text around them are fine.';

/** The status line for a classification, plus whether confirm can act on it. */
function describe(c: PasteClassification): string {
  const named = c.name ? ` “${c.name}”` : '';
  const assumed = c.assumed ? ' — no "format" tag, Load will check it' : '';
  switch (c.kind) {
    case 'song': return `Song${named} — full format${assumed}`;
    case 'author': return `Song${named} — author dialect${assumed}`;
    case 'preset': return `Preset${named}`;
    case 'bank': return `Bank${named} — ${c.count ?? 0} sound${c.count === 1 ? '' : 's'}`;
    default: return c.reason ?? 'That is not websynth JSON.';
  }
}

function confirmLabel(c: PasteClassification): string {
  if (c.kind === 'song' || c.kind === 'author') return 'Load song';
  const n = c.count ?? 0;
  return `Review ${n} preset${n === 1 ? '' : 's'}`;
}

export function buildPasteImport(opts: PasteImportOptions): PasteImport {
  const el = document.createElement('div');

  const label = document.createElement('label');
  label.className = styles.aiLabel!;
  label.textContent = opts.label ?? 'Paste song or preset JSON';
  label.htmlFor = 'paste-import-input';

  const ta = document.createElement('textarea');
  ta.id = 'paste-import-input';
  ta.className = styles.pasteText!;
  ta.placeholder = PLACEHOLDER;
  ta.dataset.testid = 'paste-input';
  ta.spellcheck = false;

  const status = document.createElement('div');
  status.className = styles.pasteStatus!;
  status.dataset.testid = 'paste-status';

  const actions = document.createElement('div');
  actions.className = styles.aiActions!;

  const readBtn = createButton({
    label: 'Paste from clipboard',
    className: switchStyles.root!,
    testId: 'paste-read-clipboard',
    onClick: () => {
      void readClipboardText().then((text) => {
        // Null = no API / denied / empty. The textarea is the supported path,
        // so a refusal is silent rather than an error the user can't act on.
        if (text === null) return;
        ta.value = text;
        render();
      });
    },
  });
  actions.appendChild(readBtn);

  if (opts.onCancel) {
    const cancel = opts.onCancel;
    actions.appendChild(createButton({
      label: 'Cancel',
      className: switchStyles.root!,
      testId: 'paste-cancel',
      onClick: () => cancel(),
    }));
  }

  const confirm = createButton({
    label: 'Load',
    className: switchStyles.root!,
    testId: 'paste-confirm',
    onClick: () => { void submit(); },
  });
  actions.appendChild(confirm);

  let busy = false;

  function render(): void {
    const c = classifyPayload(ta.value);
    const empty = ta.value.trim() === '';
    status.textContent = empty ? '' : describe(c);
    status.classList.toggle(styles.pasteBad!, !empty && c.kind === 'unknown');
    status.classList.toggle(styles.pasteOk!, c.kind !== 'unknown');
    confirm.disabled = busy || c.kind === 'unknown';
    if (!busy) setButtonLabel(confirm, c.kind === 'unknown' ? 'Load' : confirmLabel(c));
  }

  async function submit(): Promise<void> {
    const c = classifyPayload(ta.value);
    if (busy || c.kind === 'unknown' || !c.json) return;
    busy = true;
    confirm.disabled = true;
    setButtonLabel(confirm, 'Working…');
    try {
      if (c.kind === 'song' || c.kind === 'author') {
        const ok = await opts.onSong(new TextEncoder().encode(c.json), 'pasted-song.json');
        // REQ-8 — the import path has already shown its own error dialog; keep
        // the text so the user can fix a line instead of pasting again.
        if (!ok) return;
      } else {
        opts.onPresets(parsePresetPayload(c.json, opts.bus));
      }
      opts.onDone?.();
    } finally {
      busy = false;
      render();
    }
  }

  ta.addEventListener('input', render);
  el.append(label, ta, status, actions);
  render();

  return { el, focus: () => ta.focus() };
}

/** The fragment behind the Song row's Paste button (REQ-5). */
export function openPasteImportModal(opts: PasteImportOptions): void {
  const modal = new Modal({
    title: 'Paste song or preset JSON',
    cardClass: Modal.cardWideClass,
  });
  modal.body.dataset.testid = 'paste-modal';

  const frag = buildPasteImport({
    ...opts,
    onCancel: () => modal.close(),
    onDone: () => { modal.close(); opts.onDone?.(); },
  });
  modal.body.appendChild(frag.el);

  modal.open();
  frag.focus();
}
