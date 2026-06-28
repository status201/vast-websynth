import { describe, it, expect, afterEach } from 'vitest';
import {
  buildSongPrompt,
  createAiPromptButton,
} from '../../src/ui/components/ai-prompt';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { Song, DEMO_SONGS } from '../../src/state/song';
import modalStyles from '../../src/ui/styles/modal.module.css';

const EXAMPLE_NAME = 'I Feel Love';

function bus() {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

describe('buildSongPrompt', () => {
  it('cites the schema as an absolute, host-resolved URL', () => {
    const prompt = buildSongPrompt(bus());
    // jsdom serves an http(s) origin, so the link is absolute (not "/schema/…").
    expect(window.location.origin).toMatch(/^https?:\/\//);
    expect(prompt).toContain(
      `${window.location.origin}/schema/websynth-song.schema.json`,
    );
  });

  it('injects a creative brief into the SONG REQUEST section', () => {
    const brief = 'in the style of Rockit — a 12-bar loop with crazy breaks';
    const prompt = buildSongPrompt(bus(), brief);
    expect(prompt).toContain('SONG REQUEST');
    expect(prompt).toContain(brief);
  });

  it('uses a bracketed placeholder (not the example) when no brief is given', () => {
    for (const blank of [undefined, '', '   ']) {
      const prompt = buildSongPrompt(bus(), blank);
      expect(prompt).toContain('[Describe the song you want');
      // The Rockit example lives only in the field placeholder, never the prompt.
      expect(prompt).not.toMatch(/Rockit|Herbie/);
    }
  });

  it('embeds only an illustrative skeleton, not a full song', () => {
    const prompt = buildSongPrompt(bus());
    expect(prompt).toContain('EXAMPLE SHAPE');
    expect(prompt).toContain('…');
    // The whole "I Feel Love" demo must no longer be pasted into the prompt.
    expect(prompt).not.toContain(Song.toJSON(DEMO_SONGS[EXAMPLE_NAME]!));
  });
});

describe('AI Prompt modal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens a card that is both base .card (capped/scrollable) and .cardWide', () => {
    const btn = createAiPromptButton(bus());
    document.body.appendChild(btn);
    btn.click();
    const card = document.querySelector('[role="dialog"]');
    expect(card).not.toBeNull();
    // Base .card carries max-height/overflow so the title + Close stay reachable
    // on small screens; .cardWide only widens it. Regressing to wide-only would
    // let the modal overflow the viewport.
    expect(card!.className).toContain(modalStyles.card!);
    expect(card!.className).toContain(modalStyles.cardWide!);
  });
});
