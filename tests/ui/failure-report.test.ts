import { describe, it, expect } from 'vitest';
import {
  buildFailureReport, buildFailureReportFor, failureMessage, isCapped,
} from '../../src/ui/failure-report';

// specs/features/failure-report.md — the copyable diagnostic block. The point of
// the facility is that it is built from the ERROR ARRAY, so it stays complete
// while the dialog that raised it shows only the first eight messages.
describe('failure report', () => {
  const many = Array.from({ length: 50 }, (_, i) => `field${i} is wrong`);

  it('carries every message, not the truncated view (REQ-1)', () => {
    const report = buildFailureReport({ title: 'Import failed', errors: many, capped: true });
    for (const e of many) expect(report).toContain(e);
    // The dialog renders 8; the 9th and the 50th are the ones that used to die
    // with it.
    expect(report).toContain('field8 is wrong');
    expect(report).toContain('field49 is wrong');
    expect(report.match(/^• /gm)).toHaveLength(50);
  });

  it('opens with a header that identifies the failure (REQ-2)', () => {
    const lines = buildFailureReport({
      title: 'Import failed', file: 'night-drive.json', errors: ['nope'],
    }).split('\n');
    expect(lines[0]).toMatch(/^VAST G1-J8 \d+\.\d+\.\d+ — Import failed$/);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(lines[2]).toBe('file: night-drive.json');
  });

  it('omits the file line when there is no file (REQ-2)', () => {
    const report = buildFailureReport({ title: 'Import failed', errors: ['nope'] });
    expect(report).not.toContain('file:');
    expect(report.split('\n')[2]).toBe('1 error:');
  });

  it('admits when the validator stopped early, and counts honestly (REQ-3)', () => {
    expect(buildFailureReport({ title: 'x', errors: many, capped: true }))
      .toContain('50 errors (validator cap reached):');
    // Without the flag it must not claim a cap it does not know about.
    expect(buildFailureReport({ title: 'x', errors: many })).toContain('50 errors:');
    expect(buildFailureReport({ title: 'x', errors: ['one'] })).toContain('1 error:');
  });

  it('is pure formatting — same inputs, same string bar the timestamp (REQ-4)', () => {
    const drop = (s: string) => s.split('\n').filter((_, i) => i !== 1).join('\n');
    const opts = { title: 'Load failed', file: 'kick.wav', errors: ['a', 'b'] };
    expect(drop(buildFailureReport(opts))).toBe(drop(buildFailureReport(opts)));
  });

  // REQ-6 — the alert's own text. One implementation, because a second copy of
  // the "use Copy errors" line drifts and then points at a button by a name it
  // no longer has.
  it('failureMessage bullets the first 8 and names Copy for the rest', () => {
    const msg = failureMessage('Could not import song', many);
    expect(msg.startsWith('Could not import song:\n• field0 is wrong')).toBe(true);
    expect(msg.match(/^• /gm)).toHaveLength(8);
    expect(msg).toContain('…and 42 more — use Copy errors for the full list');
    expect(msg).not.toContain('field8 is wrong'); // past the cut, on screen
  });

  it('failureMessage adds no truncation line when everything fits', () => {
    const msg = failureMessage('Could not load "A Demo"', ['just the one']);
    expect(msg).toBe('Could not load "A Demo":\n• just the one');
    expect(failureMessage('x', many.slice(0, 8))).not.toContain('and 0 more');
  });

  it('isCapped is the validator budget, derived in one place (REQ-3)', () => {
    expect(isCapped(many)).toBe(true);           // exactly MAX_ERRORS
    expect(isCapped(many.slice(0, 49))).toBe(false);
    expect(isCapped([])).toBe(false);
  });

  it('buildFailureReportFor is the single-message shorthand', () => {
    const report = buildFailureReportFor('Demo failed to load', 'fetch failed (404)', 'A Demo');
    expect(report).toContain('— Demo failed to load');
    expect(report).toContain('file: A Demo');
    expect(report).toContain('1 error:');
    expect(report).toContain('• fetch failed (404)');
    expect(buildFailureReportFor('Load failed', 'corrupt')).not.toContain('file:');
  });
});
