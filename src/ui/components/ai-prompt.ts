// "AI Prompt" button + modal. Hands the user a copyable prompt that
// exactly describes the song-JSON format (schema generated live from
// ParamBus so it can never drift from registerDefaults) plus the built-in
// "I Feel Love" demo as a worked, downloadable example. Reuses the
// Modal lifecycle and the modal.module.css styling.
import type { ParamBus } from '../../state/params';
import { DRUM_TRACK_LABELS } from '../../state/params';
import {
  SEQ_LENGTH,
  BANK_COUNT,
  BANK_LABELS,
  DRUM_TRACK_COUNT,
  SAMPLER_SLOT_COUNT,
} from '../../state/patterns';
import { Song, DEMO_SONGS } from '../../state/song';
import switchStyles from '../styles/switch.module.css';
import { createButton, setButtonLabel } from './button';
import { Modal } from './modal';
import modalStyles from '../styles/modal.module.css';
import songStyles from '../styles/song-panel.module.css';

const EXAMPLE_NAME = 'I Feel Love';

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
  card.className = Modal.cardWideClass;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Generate a song with AI');

  const title = document.createElement('div');
  title.className = Modal.titleClass;
  title.textContent = 'Generate a song with AI';

  const tag = document.createElement('div');
  tag.className = Modal.tagClass;
  tag.textContent =
    'Copy the prompt into any AI agent, then import the JSON it returns ' +
    'via Song → Import.';

  const prompt = buildSongPrompt(bus);
  const example = Song.toJSON(DEMO_SONGS[EXAMPLE_NAME]!);

  const ta = document.createElement('textarea');
  ta.className = modalStyles.aiText!;
  ta.readOnly = true;
  ta.value = prompt;
  ta.addEventListener('focus', () => ta.select());

  const actions = document.createElement('div');
  actions.className = modalStyles.aiActions!;

  const copyPrompt = createButton({
    label: 'Copy Prompt',
    onClick: () => flash(copyPrompt, 'Copy Prompt', copyText(prompt)),
  });
  const copyExample = createButton({
    label: 'Copy Example JSON',
    onClick: () => flash(copyExample, 'Copy Example JSON', copyText(example)),
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
  card.appendChild(ta);
  card.appendChild(actions);
  backdrop.appendChild(card);
  return backdrop;
}

/** Swap a button label to "Copied!" / "Failed" briefly after a copy. */
function flash(
  btn: HTMLButtonElement,
  original: string,
  done: Promise<boolean>,
): void {
  void done.then((ok) => {
    setButtonLabel(btn, ok ? 'Copied!' : 'Press Ctrl+C');
    window.setTimeout(() => setButtonLabel(btn, original), 1200);
  });
}

/** Clipboard write with a legacy fallback. No util exists in the codebase. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const t = document.createElement('textarea');
      t.value = text;
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand('copy');
      t.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Build the prompt text. The parameter table is generated from the live
 * ParamBus registry so it always matches `registerDefaults()`.
 */
export function buildSongPrompt(bus: ParamBus): string {
  const params = bus
    .ids()
    .map((id) => {
      const d = bus.def(id);
      if (!d) return `- "${id}"`;
      const range = `${d.min}..${d.max}`;
      const parts = [`range ${range}`, `default ${d.default}`];
      if (d.step !== undefined) parts.push(`step ${d.step}`);
      if (d.labels && d.labels.length) {
        parts.push(`values ${d.labels.map((l, i) => `${i}=${l}`).join(' ')}`);
      }
      return `- "${id}": number  // ${parts.join(', ')}`;
    })
    .join('\n');

  const drumTracks = DRUM_TRACK_LABELS.map((l, i) => `${i}=${l}`).join(', ');
  const example = Song.toJSON(DEMO_SONGS[EXAMPLE_NAME]!);

  return `You are generating a song file for the WebSynth (VAST G1-J5) browser synthesizer.

OUTPUT RULES
- Respond with ONE valid JSON object and nothing else (no markdown, no commentary).
- It must parse and conform exactly to the schema below.
- The user imports it via the synth's Song panel → Import.

TOP-LEVEL SHAPE
{
  "format": "websynth-song",          // literal, required
  "version": 2,                        // 2 (1 is the legacy form without the sampler fields)
  "name": "string",                    // song title
  "params": { "<id>": number, ... },   // synth parameters (see PARAMS)
  "seqBanks":  SeqStep[${BANK_COUNT}][${SEQ_LENGTH}],          // ${BANK_COUNT} banks, ${SEQ_LENGTH} steps each
  "drumBanks": DrumCell[${BANK_COUNT}][${DRUM_TRACK_COUNT}][${SEQ_LENGTH}],   // ${BANK_COUNT} banks, ${DRUM_TRACK_COUNT} tracks, ${SEQ_LENGTH} steps
  "seqChain":  { "enabled": boolean, "steps": number[] },   // bank order, indices 0..${BANK_COUNT - 1}
  "drumChain": { "enabled": boolean, "steps": number[] },
  // ---- v2 sampler fields, all OPTIONAL (omit them unless asked for sampler parts) ----
  "samplerBanks": SamplerStep[${BANK_COUNT}][${SAMPLER_SLOT_COUNT}][${SEQ_LENGTH}],   // ${BANK_COUNT} banks, ${SAMPLER_SLOT_COUNT} slots, ${SEQ_LENGTH} steps
  "samplerChain": { "enabled": boolean, "steps": number[] },
  "sampleNames":  (string | null)[${SAMPLER_SLOT_COUNT}]   // filenames only — audio is NEVER embedded; the user loads files by hand
}

SeqStep  = { "on": boolean, "note": number /* MIDI 0-127 */, "velocity": number /* 0..1 */, "gate": number /* 0..1 of a step */,
             "prob": number /* 0..1 chance the step fires, default 1 */, "ratchet": number /* 1-4 sub-hits in the step, default 1 */,
             "tie": boolean /* hold into the next step (legato/slide), default false */ }
DrumCell = { "on": boolean, "velocity": number /* 0..1 */ }
SamplerStep = { "on": boolean, "velocity": number /* 0..1 */ }

Banks are labelled ${BANK_LABELS.join('/')}. A chain with enabled:false just plays bank A.
Drum track index → instrument: ${drumTracks}.

NOTES
- A bank must contain all ${SEQ_LENGTH} steps even when "on" is false (set a sensible "note").
- "filter.cutoff" is a MIDI NOTE NUMBER, not Hz. Filter env/LFO modulate it additively in semitones.
- Any param omitted from "params" falls back to its default. Include the full set for predictable results.
- For a resonant, moving filter (acid/disco bass), use high "filter.resonance", a fast "env.fil.decay",
  positive "filter.envAmount", and route the LFO to cutoff with "lfo.dest": 1.
- Use "prob" (< 1) for evolving hats/ghost notes, "ratchet" (2-4) for rolls, and "tie" + "mixer.glide"
  in Mono voicing for acid slides.
- Two bus compressors are available: "fx.drum.comp.*" (1176 FET style — punchy drums; ratio index 4 = ALL,
  the crushed all-buttons-in sound) and "fx.master.comp.*" (SSL G bus style — mix glue; release index 4 = auto).
  Their "ratio"/"release" params are discrete INDICES — see the value maps in PARAMS.

PARAMS (id, range, default, discrete value map)
${params}

EXAMPLE — the built-in "${EXAMPLE_NAME}" demo (a valid, complete song file):
${example}`;
}
