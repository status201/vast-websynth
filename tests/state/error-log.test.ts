// @vitest-environment jsdom
// debug-panel.md REQ-the-panel-keeps-the-last-errors: the last uncaught errors and
// rejections, bounded in count and length, observed without being swallowed.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  installErrorLog, recordError, errorLog, clearErrorLog,
  ERROR_LOG_CAPACITY, ERROR_MESSAGE_MAX,
} from '../../src/state/error-log';

beforeEach(() => clearErrorLog());

describe('error log', () => {
  it('records uncaught errors and unhandled rejections from window events', () => {
    installErrorLog(window);
    installErrorLog(window); // idempotent: one listener pair, not two
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'Uncaught Error: boom' }));
    const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
    rejection.reason = new Error('decode failed');
    window.dispatchEvent(rejection);

    const { entries, total } = errorLog();
    expect(total).toBe(2);
    expect(entries.map((e) => [e.kind, e.message])).toEqual([
      ['error', 'boom'],
      ['rejection', 'decode failed'],
    ]);
  });

  it('falls back to the event message when there is no Error object', () => {
    installErrorLog(window);
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    expect(errorLog().entries[0]!.message).toBe('Script error.');
  });

  it('never prevents the default, so the console still shows the error', () => {
    installErrorLog(window);
    const ev = new ErrorEvent('error', { error: new Error('seen'), cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('keeps only the last entries and caps each message', () => {
    for (let i = 0; i < 24; i++) recordError('error', new Error(`e${i}`));
    recordError('rejection', 'x'.repeat(10_000));
    const { entries, total } = errorLog();
    expect(total).toBe(25);
    expect(entries).toHaveLength(ERROR_LOG_CAPACITY);
    expect(entries[0]!.message).toBe('e15');
    for (const e of entries) expect(e.message.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
    expect(entries[entries.length - 1]!.message.endsWith('…')).toBe(true);
  });

  it('survives reasons that cannot be printed', () => {
    const hostile = { toString() { throw new Error('nope'); } };
    expect(() => recordError('rejection', hostile)).not.toThrow();
    expect(errorLog().entries[0]!.message).toBe('unprintable value');
    recordError('rejection', undefined);
    expect(errorLog().entries[1]!.message).toBe('undefined');
  });
});
