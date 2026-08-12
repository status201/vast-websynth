// "AI Prompt" button + modal. Hands the user a copyable prompt that
// exactly describes the song formats (the compact authoring dialect first,
// canonical as appendix; the PARAMS table is generated live from ParamBus so
// it can never drift from registerDefaults) plus the built-in "I Feel Love"
// demo as a worked, downloadable example. Reuses the Modal lifecycle and the
// modal.module.css styling. The prompt text itself lives in the pure
// state/authoring-guide.ts (shared with the MCP server); this module keeps
// only the modal.
import type { ParamBus } from '../../state/params';

import { Song, DEMO_SONGS } from '../../state/song';
import switchStyles from '../styles/switch.module.css';
import { createButton } from './button';
import { copyText, flashCopied } from '../clipboard';
import { buildPasteImport, type PasteImportOptions } from './paste-import';
import { Modal } from './modal';
import modalStyles from '../styles/modal.module.css';
import songStyles from '../styles/song-panel.module.css';

const EXAMPLE_NAME = 'I Feel Love';

/** Greyed example shown in the "Describe your song" field (placeholder only). */
const BRIEF_PLACEHOLDER =
  "e.g. a song in the style of Herbie Hancock's breakdance hit Rockit — a " +
  '12-bar loop with some crazy breaks. Take advantage of the fact that ' +
  "you're a robot yourself and you'd be dancing to it too.";

/**
 * The two routes the embedded paste step hands its payload to — the Song panel
 * passes the same object it gives its own Paste button, so both doors behave
 * identically (paste-import.md REQ-5).
 */
export type AiPromptRoutes = Pick<PasteImportOptions, 'onSong' | 'onPresets'>;

export function createAiPromptButton(bus: ParamBus, routes: AiPromptRoutes): HTMLButtonElement {
  // `open` is a hoisted function declaration, so wiring it here is safe.
  const btn = createButton({
    label: '✨ AI Prompt',
    className: songStyles.demo,
    onClick: () => void open(),
  });

  let backdrop: HTMLElement | null = null;
  let closeTimer: number | undefined;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Beat the global Escape→panic handler in shortcuts.ts.
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  };

  function close(): void {
    if (!backdrop) return;
    window.removeEventListener('keydown', onKey, true);
    backdrop.classList.add('hidden');
    const el = backdrop;
    closeTimer = window.setTimeout(() => el.remove(), 200);
  }

  /**
   * The authoring guide is ~22 kB of prompt copy that only this modal reads, so
   * it loads with the click rather than at boot (runtime-performance.md REQ-1).
   * Awaited before the modal is built so the textarea is never briefly empty.
   */
  async function open(): Promise<void> {
    window.clearTimeout(closeTimer);
    const { buildSongPrompt } = await import('../../state/authoring-guide');
    backdrop ??= buildModal(bus, close, routes, buildSongPrompt);
    document.body.appendChild(backdrop);
    // Force reflow so the opacity transition runs from the .hidden state.
    void backdrop.offsetWidth;
    backdrop.classList.remove('hidden');
    window.addEventListener('keydown', onKey, true);
  }

  return btn;
}

function buildModal(
  bus: ParamBus,
  close: () => void,
  routes: AiPromptRoutes,
  buildSongPrompt: (bus: ParamBus, brief: string) => string,
): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = `${Modal.backdropClass} hidden`;
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });

  const card = document.createElement('div');
  // Base .card gives the 86vh cap + internal scroll (so the title/actions stay
  // reachable on small screens); .cardWide widens it (wins on width by source
  // order) — the same composition the reusable Modal helper uses.
  card.className = `${Modal.cardClass} ${Modal.cardWideClass}`;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Generate a song with AI');

  const title = document.createElement('div');
  title.className = Modal.titleClass;
  title.textContent = 'Generate a song with AI';

  const tag = document.createElement('div');
  tag.className = Modal.tagClass;
  tag.textContent =
    'Describe your song, copy the prompt into any AI agent, then paste the ' +
    'JSON it answers with straight back here.';

  // Editable creative brief. Seeded only as a placeholder so an un-typed copy
  // never injects the example text; the prompt updates live as the user types.
  const briefLabel = document.createElement('label');
  briefLabel.className = modalStyles.aiLabel!;
  briefLabel.textContent = '1 · Describe your song';
  briefLabel.htmlFor = 'ai-prompt-brief';

  const brief = document.createElement('textarea');
  brief.id = 'ai-prompt-brief';
  brief.className = modalStyles.aiBrief!;
  brief.placeholder = BRIEF_PLACEHOLDER;

  const example = Song.toJSON(DEMO_SONGS[EXAMPLE_NAME]!);

  const promptLabel = document.createElement('div');
  promptLabel.className = modalStyles.aiLabel!;
  promptLabel.textContent = '2 · Copy this prompt into any AI agent';

  const ta = document.createElement('textarea');
  ta.className = modalStyles.aiText!;
  ta.readOnly = true;
  ta.value = buildSongPrompt(bus, brief.value);
  ta.addEventListener('focus', () => ta.select());

  // Rebuild the prompt's SONG REQUEST section live as the brief changes.
  brief.addEventListener('input', () => {
    ta.value = buildSongPrompt(bus, brief.value);
  });

  const actions = document.createElement('div');
  actions.className = modalStyles.aiActions!;

  const copyPrompt = createButton({
    label: 'Copy Prompt',
    onClick: () => flashCopied(copyPrompt, 'Copy Prompt', copyText(ta.value)),
  });
  const copyExample = createButton({
    label: 'Copy Example JSON',
    onClick: () => flashCopied(copyExample, 'Copy Example JSON', copyText(example)),
  });
  const downloadExample = createButton({
    label: 'Download Example',
    onClick: () => Song.download(DEMO_SONGS[EXAMPLE_NAME]!),
  });
  const closeBtn = createButton({
    label: 'Close',
    className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
    onClick: close,
  });

  actions.appendChild(copyPrompt);
  actions.appendChild(copyExample);
  actions.appendChild(downloadExample);

  // Step 3 — the shared paste fragment (paste-import.md REQ-5). Agents answer
  // in chat rather than with a download, so the round trip closes here instead
  // of via a save-to-disk detour. A successful load closes the modal so the
  // user sees the song that just landed.
  const paste = buildPasteImport({
    ...routes,
    label: '3 · Paste the reply here',
    onDone: close,
  });

  card.appendChild(title);
  card.appendChild(tag);
  card.appendChild(briefLabel);
  card.appendChild(brief);
  card.appendChild(promptLabel);
  card.appendChild(ta);
  card.appendChild(actions);
  card.appendChild(paste.el);
  card.appendChild(closeBtn);
  backdrop.appendChild(card);
  return backdrop;
}
