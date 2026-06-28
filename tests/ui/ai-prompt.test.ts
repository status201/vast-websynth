import { describe, it, expect } from 'vitest';
import { buildSongPrompt } from '../../src/ui/components/ai-prompt';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { Song, DEMO_SONGS } from '../../src/state/song';

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
