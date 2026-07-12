// "AI Prompt" button + modal. Hands the user a copyable prompt that
// exactly describes the song formats (the compact authoring dialect first,
// canonical as appendix; the PARAMS table is generated live from ParamBus so
// it can never drift from registerDefaults) plus the built-in "I Feel Love"
// demo as a worked, downloadable example. Reuses the Modal lifecycle and the
// modal.module.css styling. The prompt text itself lives in the pure
// state/authoring-guide.ts (shared with the MCP server); this module keeps
// the modal and re-exports buildSongPrompt for its existing consumers.
import type { ParamBus } from '../../state/params';
import { buildSongPrompt } from '../../state/authoring-guide';
import { Song, DEMO_SONGS } from '../../state/song';
import switchStyles from '../styles/switch.module.css';
import { createButton } from './button';
import { copyText, flashCopied } from '../clipboard';
import { Modal } from './modal';
import modalStyles from '../styles/modal.module.css';
import songStyles from '../styles/song-panel.module.css';

export { buildSongPrompt } from '../../state/authoring-guide';

const EXAMPLE_NAME = 'I Feel Love';

/** Greyed example shown in the "Describe your song" field (placeholder only). */
const BRIEF_PLACEHOLDER =
  "e.g. a song in the style of Herbie Hancock's breakdance hit Rockit — a " +
  '12-bar loop with some crazy breaks. Take advantage of the fact that ' +
  "you're a robot yourself and you'd be dancing to it too.";

export function createAiPromptButton(bus: ParamBus): HTMLButtonElement {
  // `open` is a hoisted function declaration, so wiring it here is safe.
  const btn = createButton({
    label: '✨ AI Prompt',
    className: songStyles.demo,
    onClick: open,
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

  function open(): void {
    window.clearTimeout(closeTimer);
    backdrop ??= buildModal(bus, close);
    document.body.appendChild(backdrop);
    // Force reflow so the opacity transition runs from the .hidden state.
    void backdrop.offsetWidth;
    backdrop.classList.remove('hidden');
    window.addEventListener('keydown', onKey, true);
  }

  return btn;
}

function buildModal(bus: ParamBus, close: () => void): HTMLElement {
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
    'Describe your song, copy the prompt into any AI agent, then import the ' +
    'JSON it returns via Song → Import.';

  // Editable creative brief. Seeded only as a placeholder so an un-typed copy
  // never injects the example text; the prompt updates live as the user types.
  const briefLabel = document.createElement('label');
  briefLabel.className = modalStyles.aiLabel!;
  briefLabel.textContent = 'Describe your song';
  briefLabel.htmlFor = 'ai-prompt-brief';

  const brief = document.createElement('textarea');
  brief.id = 'ai-prompt-brief';
  brief.className = modalStyles.aiBrief!;
  brief.placeholder = BRIEF_PLACEHOLDER;

  const example = Song.toJSON(DEMO_SONGS[EXAMPLE_NAME]!);

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
  actions.appendChild(closeBtn);

  card.appendChild(title);
  card.appendChild(tag);
  card.appendChild(briefLabel);
  card.appendChild(brief);
  card.appendChild(ta);
  card.appendChild(actions);
  backdrop.appendChild(card);
  return backdrop;
}
