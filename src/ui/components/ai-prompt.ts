// "AI Prompt" button + modal. Hands the user a copyable prompt that
// exactly describes the song formats (the compact authoring dialect first,
// canonical as appendix; the PARAMS table is generated live from ParamBus so
// it can never drift from registerDefaults) plus the built-in "Mordor"
// demo as a worked, downloadable example. The prompt text itself lives in the
// pure state/authoring-guide.ts (shared with the MCP server), and the modal
// body in ai-prompt-modal.ts; both load with the first click
// (runtime-performance.md REQ-boot-cost-matches-the-request). This module keeps
// only the button and the open/close lifecycle.
import type { ParamBus } from '../../state/params';
import type { PasteImportOptions } from './paste-import';
import { createButton } from './button';
import { showLazyLoadFailure } from './lazy-load-toast';
import songStyles from '../styles/song-panel.module.css';
import { UI_ICONS } from './ui-icons';

/**
 * The two routes the embedded paste step hands its payload to — the Song panel
 * passes the same object it gives its own Paste button, so both doors behave
 * identically (paste-import.md REQ-one-paste-fragment-two-placements).
 */
export type AiPromptRoutes = Pick<PasteImportOptions, 'onSong' | 'onPresets'>;

/** Type-only reference — carries no runtime edge to the lazy chunk. */
type BuildSongPrompt = typeof import('../../state/authoring-guide').buildSongPrompt;
type BuildModal = typeof import('./ai-prompt-modal').buildModal;

export function createAiPromptButton(bus: ParamBus, routes: AiPromptRoutes): HTMLButtonElement {
  // `open` is a hoisted function declaration, so wiring it here is safe.
  const btn = createButton({
    label: 'AI Prompt',
    iconBefore: UI_ICONS.sparkle,
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
   * The authoring guide is ~22 kB of prompt copy that only this modal reads, and
   * the modal body (with the paste fragment it embeds) is the rest; both load
   * with the click rather than at boot (runtime-performance.md REQ-boot-cost-matches-the-request).
   * Awaited before the modal is built so the textarea is never briefly empty.
   * Either rejecting is reported and returns null (lazy-load-failure.md) —
   * without this the button silently did nothing.
   *
   * The guide's destructure stays **inside** the `import()` expression. That is
   * what lets rollup shake the guide's other exports (`buildPresetGuide`,
   * `buildAuthoringGuide`, `paramTable`) out of the chunk; binding the
   * namespace to a variable first and destructuring after re-attaches them —
   * measured at +3.7 kB of prompt copy nothing on this path reads. The body is
   * wanted whole, so its fetch starts first and runs alongside.
   */
  async function loadModal(): Promise<{ buildSongPrompt: BuildSongPrompt; buildModal: BuildModal } | null> {
    const body = import('./ai-prompt-modal');
    body.catch(() => {}); // awaited below; never an unhandled rejection if the guide fails first
    try {
      const { buildSongPrompt } = await import('../../state/authoring-guide');
      return { buildSongPrompt, buildModal: (await body).buildModal };
    } catch {
      showLazyLoadFailure('the AI prompt', () => void open());
      return null;
    }
  }

  async function open(): Promise<void> {
    window.clearTimeout(closeTimer);
    const m = await loadModal();
    if (!m) return;
    backdrop ??= m.buildModal(bus, close, routes, m.buildSongPrompt);
    document.body.appendChild(backdrop);
    // Force reflow so the opacity transition runs from the .hidden state.
    void backdrop.offsetWidth;
    backdrop.classList.remove('hidden');
    window.addEventListener('keydown', onKey, true);
  }

  return btn;
}
