import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAiPromptButton, type AiPromptRoutes } from '../../src/ui/components/ai-prompt';
import { buildSongPrompt, buildAuthoringGuide } from '../../src/state/authoring-guide';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { Song, DEMO_SONGS } from '../../src/state/song';
import modalStyles from '../../src/ui/styles/modal.module.css';

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
    // No demo may be pasted in whole — asserted over all of them rather than the
    // one the modal happens to use, so renaming or swapping it changes nothing.
    for (const file of Object.values(DEMO_SONGS)) {
      expect(prompt, file.name).not.toContain(Song.toJSON(file));
    }
  });
});

describe('AI Prompt modal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const routes = (): AiPromptRoutes => ({
    onSong: vi.fn(async () => true),
    onPresets: vi.fn(),
  });

  it('opens a card that is both base .card (capped/scrollable) and .cardWide', async () => {
    const btn = createAiPromptButton(bus(), routes());
    document.body.appendChild(btn);
    btn.click();
    // The click `import()`s the authoring guide before building the modal
    // (runtime-performance.md REQ-1), so the card lands a microtask later.
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    const card = document.querySelector('[role="dialog"]');
    expect(card).not.toBeNull();
    // Base .card carries max-height/overflow so the title + Close stay reachable
    // on small screens; .cardWide only widens it. Regressing to wide-only would
    // let the modal overflow the viewport.
    expect(card!.className).toContain(modalStyles.card!);
    expect(card!.className).toContain(modalStyles.cardWide!);
  });

  // paste-import.md REQ-5 — the round trip closes inside this modal: the same
  // paste fragment the Song row's Paste button opens is embedded as step 3.
  it('embeds the paste fragment as step 3, above the Close button', async () => {
    const btn = createAiPromptButton(bus(), routes());
    document.body.appendChild(btn);
    btn.click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());

    const input = document.querySelector('[data-testid="paste-input"]');
    expect(input).not.toBeNull();
    const card = document.querySelector('[role="dialog"]')!;
    expect(card.textContent).toContain('3 · Paste the reply here');
    expect(card.lastElementChild!.textContent).toBe('Close');
  });

  // ai-prompt.md REQ-10 — the modal offers the connector, above step 1.
  it('offers the hosted MCP endpoint, origin-resolved, before step 1', async () => {
    const btn = createAiPromptButton(bus(), routes());
    document.body.appendChild(btn);
    btn.click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());

    const card = document.querySelector('[role="dialog"]')!;
    const url = card.querySelector(`.${modalStyles.aiConnectorUrl!}`);
    expect(url).not.toBeNull();
    // Resolved like REQ-3's schema URLs, so a fork advertises its own host.
    expect(url!.textContent).toBe(`${window.location.origin}/mcp`);

    // NOT an anchor: the endpoint answers POST only, so a click would render a
    // 405 JSON body and read as a broken link (mcp-server.md REQ-9b).
    expect(card.querySelector('a[href*="/mcp"]')).toBeNull();
    expect(url!.tagName).not.toBe('A');

    // It is an aside, not a fourth step — it precedes the numbered flow.
    const text = card.textContent!;
    expect(text.indexOf('/mcp')).toBeLessThan(text.indexOf('1 · Describe your song'));
  });
});

// The load-bearing half of REQ-10: the prompt text must NOT carry the pitch.
// buildAuthoringGuide is what the MCP server's get_song_format returns, so a
// connector line there would advertise the tool to an agent already holding it;
// and in buildSongPrompt it would cost context on every paste to describe a
// capability that reader lacks. Both are easy to "helpfully" add later.
describe('the connector pitch stays out of the prompt (REQ-10)', () => {
  it('is absent from buildSongPrompt and buildAuthoringGuide', () => {
    for (const text of [buildSongPrompt(bus(), 'a brief'), buildAuthoringGuide(bus())]) {
      expect(text).not.toMatch(/mcp/i);
      expect(text).not.toMatch(/connector/i);
    }
  });
});
