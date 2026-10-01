// The AI Prompt modal's body (ai-prompt.md). Split from `ai-prompt.ts` so the
// button stays on the boot path and this — plus the paste fragment it embeds —
// loads with the first click (runtime-performance.md REQ-boot-cost-matches-the-request).
import type { ParamBus } from '../../state/params';

import { Song, DEMO_SONGS } from '../../state/song';
import switchStyles from '../styles/switch.module.css';
import { createButton } from './button';
import { copyText, flashCopied } from '../clipboard';
import { buildPasteImport } from './paste-import';
import { Modal } from './modal';
import modalStyles from '../styles/modal.module.css';
import type { AiPromptRoutes } from './ai-prompt';

const EXAMPLE_NAME = 'Mordor';

/** Greyed example shown in the "Describe your song" field (placeholder only). */
const BRIEF_PLACEHOLDER =
  "e.g. a song in the style of Herbie Hancock's breakdance hit Rockit — a " +
  '12-bar loop with some crazy breaks. Take advantage of the fact that ' +
  "you're a robot yourself and you'd be dancing to it too.";

export function buildModal(
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

  // The shorter route, offered before the three-step round trip (REQ-the-modal-offers-the-connector). An
  // agent with MCP connector support does not need this modal at all, and the
  // person most likely to benefit is the one who just opened it.
  //
  // Origin-resolved like REQ-the-prompt-cites-absolute-schema-urls's schema URLs, so a fork points at its own host
  // rather than advertising ours. Plain text, NOT an anchor: the endpoint
  // answers POST only, so a click would render a 405 JSON body and read as a
  // broken link (mcp-server.md REQ-no-sse-every-response-is-one-json-body).
  //
  // Nothing about this goes into the prompt text — REQ-the-modal-offers-the-connector has the reasoning.
  const connector = document.createElement('div');
  connector.className = modalStyles.aiConnector!;

  const connectorText = document.createElement('span');
  connectorText.textContent =
    'Using an AI that supports MCP connectors? Add this and it can validate ' +
    'and fix songs directly — no copy-paste round trip:';

  const connectorUrl = document.createElement('span');
  connectorUrl.className = modalStyles.aiConnectorUrl!;
  const origin =
    typeof window !== 'undefined' && window.location ? window.location.origin : '';
  connectorUrl.textContent = `${origin}/mcp`;

  const copyConnector = createButton({
    label: 'Copy URL',
    onClick: () =>
      flashCopied(copyConnector, 'Copy URL', copyText(connectorUrl.textContent!)),
  });

  connector.appendChild(connectorText);
  connector.appendChild(connectorUrl);
  connector.appendChild(copyConnector);

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

  // Step 3 — the shared paste fragment (paste-import.md REQ-one-paste-fragment-two-placements). Agents answer
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
  card.appendChild(connector);
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
