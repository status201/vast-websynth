import { describe, it, expect } from 'vitest';
import { extractJson, classifyPayload } from '../../src/state/paste-payload';

/**
 * paste-import.md REQ-1..REQ-4 — the tolerance layer. Every case here is
 * something an AI agent actually does: fences the JSON, chats around it,
 * forgets the format tag, or gets cut off mid-object.
 */

const AUTHOR = '{"format":"websynth-song-author","version":1,"name":"Night Drive"}';

describe('extractJson', () => {
  it('takes the body of a fenced code block', () => {
    expect(extractJson('```json\n' + AUTHOR + '\n```')).toBe(AUTHOR);
    expect(extractJson('```\n' + AUTHOR + '\n```')).toBe(AUTHOR);
  });

  it('strips prose before and after', () => {
    const reply = `Here's your song!\n\n${AUTHOR}\n\nLet me know if you want changes.`;
    expect(extractJson(reply)).toBe(AUTHOR);
  });

  it('strips prose AND fences together (the usual reply shape)', () => {
    const reply = `Sure — a driving synthwave loop:\n\n\`\`\`json\n${AUTHOR}\n\`\`\`\n\nEnjoy!`;
    expect(extractJson(reply)).toBe(AUTHOR);
  });

  it('slices to the LAST closing brace, so nested objects survive', () => {
    const nested = '{"a":{"b":1},"c":2}';
    expect(extractJson('text ' + nested + ' more text')).toBe(nested);
  });

  it('returns null when there is no object at all', () => {
    expect(extractJson('')).toBeNull();
    expect(extractJson('no braces here')).toBeNull();
    expect(extractJson('} backwards {')).toBeNull();
  });
});

describe('classifyPayload', () => {
  it('routes by format tag', () => {
    expect(classifyPayload(AUTHOR)).toMatchObject({ kind: 'author', name: 'Night Drive' });
    expect(classifyPayload('{"format":"websynth-song","name":"X"}')).toMatchObject({ kind: 'song', name: 'X' });
    expect(classifyPayload('{"format":"websynth-preset","name":"lead","params":{}}'))
      .toMatchObject({ kind: 'preset', name: 'lead', count: 1 });
  });

  it('counts the sounds in a bank', () => {
    const bank = '{"format":"websynth-preset-bank","name":"mine","presets":{"a":{},"b":{},"c":{}}}';
    expect(classifyPayload(bank)).toMatchObject({ kind: 'bank', name: 'mine', count: 3 });
  });

  it('hands back the extracted json, not the pasted text (REQ-1)', () => {
    const res = classifyPayload('blah\n```json\n' + AUTHOR + '\n```\nblah');
    expect(res.json).toBe(AUTHOR);
  });

  // REQ-3 — an agent that drops one field must still reach the validator.
  it('infers a song from its keys when the format tag is missing', () => {
    expect(classifyPayload('{"name":"X","seqBanks":[],"drumBanks":[]}'))
      .toMatchObject({ kind: 'song', assumed: true });
    expect(classifyPayload('{"name":"X","seq":[],"drums":[]}'))
      .toMatchObject({ kind: 'author', assumed: true });
  });

  // REQ-4 — every refusal explains itself.
  it('refuses with a reason', () => {
    expect(classifyPayload('just prose')).toMatchObject({
      kind: 'unknown',
      reason: expect.stringContaining('No JSON'),
    });
    // Cut off mid-object: the brace slice succeeds, the parse does not.
    expect(classifyPayload('{"format":"websynth-song","seqBanks":[{"on":tr}')).toMatchObject({
      kind: 'unknown',
      reason: expect.stringContaining('incomplete or malformed'),
    });
    expect(classifyPayload('{"hello":"world"}')).toMatchObject({
      kind: 'unknown',
      reason: expect.stringContaining('"format"'),
    });
    expect(classifyPayload('{"format":"ableton-live-set"}')).toMatchObject({
      kind: 'unknown',
      reason: expect.stringContaining('ableton-live-set'),
    });
  });

  it('never throws, whatever it is handed', () => {
    for (const junk of ['', '{', '{}', '[]', '{"format":null}', '{"a":{}}']) {
      expect(() => classifyPayload(junk)).not.toThrow();
    }
  });
});
