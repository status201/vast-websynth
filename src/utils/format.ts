/**
 * Counts and sizes as the UI spells them. Each of these used to be open-coded
 * at its call site — the `n === 1 ? '' : 's'` idiom about ten times over, and
 * two byte formatters that disagreed below a megabyte.
 */

/** `1 preset`, `3 presets`, `0 presets`. Regular plurals only. */
export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * `7.1 MB`, or whole kilobytes below a megabyte (`35 kB`) — a few kilobytes read
 * as `0.0 MB` otherwise. Decimal units, as the numbers a host or a file manager
 * reports. A non-zero size never rounds down to `0 kB`.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${megabytes(bytes)} MB`;
  if (bytes <= 0) return '0 kB';
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

/** Megabytes to one decimal, without the unit — for `3.1 / 7.1 MB` pairs. */
export const megabytes = (bytes: number): string => (bytes / 1e6).toFixed(1);
