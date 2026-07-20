import { describe, it, expect, afterEach } from 'vitest';
import { createAiPromptButton } from '../../src/ui/components/ai-prompt';
import { buildSongPrompt } from '../../src/state/authoring-guide';
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
  it('cites both schemas as absolute, host-resolved URLs', () => {
    const prompt = buildSongPrompt(bus());
    // jsdom serves an http(s) origin, so the links are absolute (not "/schema/…").
    expect(window.location.origin).toMatch(/^https?:\/\//);
    expect(prompt).toContain(
      `${window.location.origin}/schema/websynth-song.schema.json`,
    );
    expect(prompt).toContain(
      `${window.location.origin}/schema/websynth-song-author.schema.json`,
    );
  });

  it('teaches the authoring dialect first, canonical as appendix', () => {
    const prompt = buildSongPrompt(bus());
    // The QUICKSTART example is a complete author-dialect song.
    expect(prompt).toContain('QUICKSTART');
    expect(prompt).toContain('"format": "websynth-song-author"');
    expect(prompt).toContain('COMPACT AUTHOR FORMAT');
    // The canonical full form is demoted to an appendix, after the dialect.
    const appendix = prompt.indexOf('APPENDIX');
    expect(appendix).toBeGreaterThan(prompt.indexOf('COMPACT AUTHOR FORMAT'));
    expect(prompt.indexOf('"format": "websynth-song"', appendix)).toBeGreaterThan(-1);
  });

  it('carries the anti-give-up guardrails', () => {
    const prompt = buildSongPrompt(bus());
    expect(prompt).toContain('exactly ONE JSON object');
    expect(prompt).toContain('NEVER truncate');
    expect(prompt).toMatch(/under ~80 lines/);
    expect(prompt).toMatch(/1-2 banks/);
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
