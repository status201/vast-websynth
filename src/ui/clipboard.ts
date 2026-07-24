// Shared clipboard helpers, extracted verbatim from ai-prompt.ts so the WiFi
// pair modal can reuse them (ai-prompt.md / webrtc-sync.md). Behaviour is
// unchanged: a navigator.clipboard write with a legacy execCommand fallback,
// plus a button "Copied!" flash.
import { setButtonLabel } from './components/button';

/** Clipboard write with a legacy fallback. Resolves to whether it succeeded. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const t = document.createElement('textarea');
      t.value = text;
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand('copy');
      t.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Clipboard *read*, or null when unavailable — no API (Firefox/Safari without a
 * user gesture), permission denied, or an empty clipboard. A convenience only:
 * the paste textarea is always the supported path (paste-import.md REQ-9).
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText();
    return text || null;
  } catch {
    return null;
  }
}

/** Swap a button label to "Copied!" / "Press Ctrl+C" briefly after a copy. */
export function flashCopied(
  btn: HTMLButtonElement,
  original: string,
  done: Promise<boolean>,
): void {
  void done.then((ok) => {
    setButtonLabel(btn, ok ? 'Copied!' : 'Press Ctrl+C');
    window.setTimeout(() => setButtonLabel(btn, original), 1200);
  });
}
