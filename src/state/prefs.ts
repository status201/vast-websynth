/**
 * Device-scoped preferences in `localStorage` — the one place the storage
 * try/catch lives (architecture.md → Persistence). Storage can be blocked
 * (private mode, a disabled origin) or full, and a preference must never cost
 * the app: a failed read is "nothing stored", a failed write keeps the choice
 * for this visit only.
 *
 * A stored value is untrusted (untrusted-input.md): callers validate what
 * `readPref` returns — `readChoice` does it for the common closed-set case.
 */

/** The stored string, or `null` for nothing stored or blocked storage. */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store `value`; a blocked or full storage is swallowed. */
export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — the choice still applies for this visit */
  }
}

/** Forget `key`; a blocked storage is swallowed. */
export function removePref(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
}

/** The stored value when it is one of `choices`, else `fallback`. */
export function readChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  const v = readPref(key);
  return v !== null && (choices as readonly string[]).includes(v) ? (v as T) : fallback;
}
