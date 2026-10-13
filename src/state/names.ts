import { MAX_NAME_CHARS } from './limits';

/** The first `max` code points of `s` — never half of an emoji's surrogate pair. */
export function capCodePoints(s: string, max: number): string {
  return [...s].slice(0, max).join('');
}

/**
 * The one name sanitiser (untrusted-input.md REQ-names-are-capped): control
 * characters out, trimmed, capped at `max` **code points** — slicing UTF-16
 * units could cut an emoji in half — and trimmed again, so a cut that lands
 * after a space leaves no trailing blank.
 */
export function cleanName(raw: string, max: number = MAX_NAME_CHARS): string {
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return capCodePoints(s, max).trim();
}
