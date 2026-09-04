import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openPresetManagerModal } from '../../src/ui/components/preset-manager-modal';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PresetSession } from '../../src/state/preset-session';
import { parsePresetPayload } from '../../src/state/preset-file';
import { installLocalStorageMock } from '../storage-mock';
import styles from '../../src/ui/styles/preset-manager.module.css';

// presets.md REQ-16. The wizard's error strip used to render `errors[0]` and
// drop the rest before they reached the DOM — and this strip is the only place
// they are ever shown, since the paste door raises no dialog of its own.

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const shown = (id: string) => {
  const el = byId(id);
  return el !== null && el.style.display !== 'none';
};
/** The message rows only — not the box that holds them. */
const rowsIn = (id: string, cls: string) =>
  Array.from(byId(id)?.querySelectorAll('.' + cls) ?? []).map((d) => d.textContent ?? '');

function bus(): ParamBus {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

/** Open the manager already on the outcome of parsing `payload`. */
function openWith(payload: unknown, b = bus()): void {
  openPresetManagerModal({
    bus: b,
    session: new PresetSession(),
    onPresetsChanged: () => {},
    initialImport: parsePresetPayload(JSON.stringify(payload), b),
  });
}

/** A bank whose every preset trips a different structural error. */
function tenBadPresets(): Record<string, unknown> {
  const presets: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) presets[`bad ${i}`] = { 'filter.cutoff': `not-a-number-${i}` };
  return { format: 'websynth-preset-bank', version: 1, name: 'Broken', presets };
}

describe('preset manager import errors', () => {
  beforeEach(() => {
    installLocalStorageMock();
    document.body.innerHTML = '';
  });

  it('renders every message, not just the first (REQ-16)', () => {
    openWith(tenBadPresets());
    expect(shown('preset-import-errors')).toBe(true);
    const rows = rowsIn('preset-import-errors', styles.errorRow!);
    // One row per message, plus the count line — the bug was exactly one row.
    expect(rows.filter((t) => t.includes('must be a finite number'))).toHaveLength(10);
    expect(rows.some((t) => t.includes('bad 9'))).toBe(true);
    expect(byId('preset-import-errors')!.textContent).toContain('10 problems');
  });

  it('copies the whole list, built from the array and not the rows (REQ-16)', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    openWith(tenBadPresets());

    (byId('preset-import-copy') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    const report = writeText.mock.calls[0]![0] as unknown as string;
    expect(report).toContain('— Preset import failed');
    expect(report).toContain('10 errors:');
    expect(report).toContain('bad 0');
    expect(report).toContain('bad 9');    // the nine that used to be dropped
    expect(report).toContain('file: pasted text');
  });

  it('falls back to a sentence when the parse gave no message', () => {
    // Reached through the empty-array guard, not any real parse.
    openPresetManagerModal({
      bus: bus(),
      session: new PresetSession(),
      onPresetsChanged: () => {},
      initialImport: { ok: false, errors: [] },
    });
    expect(byId('preset-import-errors')!.textContent).toContain('Could not read that file.');
    // The copy control is hidden with its row when there is nothing to copy.
    expect(byId('preset-import-copy')!.parentElement!.style.display).toBe('none');
  });

  it('shows no error strip on a clean file', () => {
    openWith({
      format: 'websynth-preset', version: 1, name: 'Fine',
      params: { 'filter.cutoff': 90 },
    });
    expect(shown('preset-import-errors')).toBe(false);
    expect(shown('preset-import-review')).toBe(true);
  });
});

describe('preset manager import warnings', () => {
  beforeEach(() => {
    installLocalStorageMock();
    document.body.innerHTML = '';
  });

  it('shows a song setting as a warning on the review step, and still imports', () => {
    openWith({
      format: 'websynth-preset', version: 1, name: 'Tempo Thief',
      params: { 'filter.cutoff': 90, 'transport.bpm': 128 },
    });
    expect(shown('preset-import-review')).toBe(true);
    expect(shown('preset-import-warnings')).toBe(true);
    expect(byId('preset-import-warnings')!.textContent).toContain('transport.bpm');
    // A warning says what will not survive — it must never block the import.
    expect((byId('preset-import-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('warns about an out-of-range value instead of refusing the file (REQ-8)', () => {
    openWith({
      format: 'websynth-preset', version: 1, name: 'Too Hot',
      params: { 'filter.cutoff': 9000 },
    });
    expect(shown('preset-import-errors')).toBe(false);
    expect(shown('preset-import-review')).toBe(true);
    expect(byId('preset-import-warnings')!.textContent).toContain('filter.cutoff');
  });

  it('shows no warning block for a clean file', () => {
    openWith({
      format: 'websynth-preset', version: 1, name: 'Fine',
      params: { 'filter.cutoff': 90 },
    });
    expect(shown('preset-import-warnings')).toBe(false);
  });
});
