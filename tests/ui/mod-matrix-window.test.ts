import { describe, it, expect, beforeEach } from 'vitest';
import { createModMatrixWindowController } from '../../src/ui/components/mod-matrix-window';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { MOD_SRC, MOD_DST, MOD_ROWS, MOD_SOURCE_LABELS, MOD_DEST_LABELS } from '../../src/state/mod-routing';

/**
 * specs/features/mod-matrix.md — the window.
 *
 * The controller builds lazily on first open, so every test opens it first. That is
 * the behaviour, not a workaround: a window nobody has opened must cost nothing.
 */
// A FloatingWindow mounts itself into `document.body`, which jsdom shares across
// tests in a file — without this every `build()` would leave its window behind and
// `querySelector` would keep finding the first one.
beforeEach(() => { document.body.innerHTML = ''; });

function build() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const win = createModMatrixWindowController(bus);
  win.toggle();                       // builds + opens
  const root = document.querySelector<HTMLElement>('[data-testid="mod-window"]')!;
  return { bus, win, root };
}

const byId = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

/** An option button inside a row's destination picker, by label. */
function destOption(root: HTMLElement, row: number, label: string): HTMLButtonElement {
  return [...byId(root, `mod-dst-${row}`).querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent === label)!;
}

describe('mod matrix window', () => {
  it('builds nothing until it is first opened', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const win = createModMatrixWindowController(bus);
    expect(document.querySelector('[data-testid="mod-window"]')).toBeNull();
    expect(win.isOpen()).toBe(false);
    win.toggle();
    expect(document.querySelector('[data-testid="mod-window"]')).not.toBeNull();
  });

  it('shows eight rows: the two LFOs, then the six free ones (REQ-2)', () => {
    const { root } = build();
    for (let r = 0; r < MOD_ROWS + 2; r++) expect(byId(root, `mod-row-${r}`), `row ${r}`).toBeTruthy();
    expect(root.querySelector('[data-testid="mod-row-8"]')).toBeNull();
  });

  it('gives the LFO rows no source picker, because their source cannot change', () => {
    const { root } = build();
    // A dropdown with one option is a control that lies about being a choice.
    expect(root.querySelector('[data-testid="mod-src-0"]')).toBeNull();
    expect(root.querySelector('[data-testid="mod-src-1"]')).toBeNull();
    expect(byId(root, 'mod-src-2')).toBeTruthy();
  });

  it('binds the LFO rows to their OWN params, not to mod.* (REQ-2)', () => {
    const { root } = build();
    // This is the whole back-compat story: no migration, because nothing moved.
    expect(root.querySelector('[data-testid="knob-lfo.amount"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="knob-lfo2.amount"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="knob-mod.0.amt"]')).not.toBeNull();
  });

  it('writes a chosen source through to the bus', () => {
    const { bus, root } = build();
    const opt = [...byId(root, 'mod-src-2').querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === MOD_SOURCE_LABELS[MOD_SRC.lfo1]!)!;
    opt.click();
    expect(bus.get('mod.0.src')).toBe(MOD_SRC.lfo1);
  });

  it('repaints from the bus, so a preset load is reflected without a click', () => {
    const { bus, root } = build();
    bus.set('mod.0.src', MOD_SRC.random);
    // The toggle draws its own caret, so match the label rather than the whole text.
    const shown = byId(root, 'mod-src-2').querySelector('button')!.textContent!;
    expect(shown).toContain(MOD_SOURCE_LABELS[MOD_SRC.random]!);
  });
});

describe('mod matrix window — the per-voice rule (REQ-7)', () => {
  const PAN = MOD_DEST_LABELS[MOD_DST.pan]!;

  it('greys pan while the source is per-voice, and says why', () => {
    const { bus, root } = build();
    expect(destOption(root, 2, PAN).disabled).toBe(false);

    bus.set('mod.0.src', MOD_SRC.filEnv);
    expect(destOption(root, 2, PAN).disabled).toBe(true);
    // Greyed, never removed — the list must not reflow — and the reason is readable
    // without hover.
    expect(destOption(root, 2, PAN).isConnected).toBe(true);
    expect(byId(root, 'mod-dst-2').title).toContain('per-voice');
  });

  it('frees pan again for a global source', () => {
    const { bus, root } = build();
    bus.set('mod.0.src', MOD_SRC.velocity);
    expect(destOption(root, 2, PAN).disabled).toBe(true);
    bus.set('mod.0.src', MOD_SRC.lfo2);
    expect(destOption(root, 2, PAN).disabled).toBe(false);
    expect(byId(root, 'mod-dst-2').title).toBe('');
  });

  it('leaves every other destination selectable under a per-voice source', () => {
    const { bus, root } = build();
    bus.set('mod.0.src', MOD_SRC.ampEnv);
    for (const label of MOD_DEST_LABELS.filter((l) => l !== PAN)) {
      expect(destOption(root, 2, label).disabled, label).toBe(false);
    }
  });
});

describe('mod matrix window — idle rows (motion-sequencer.md REQ-16)', () => {
  it('never dims the row itself, or its own pickers become unreachable', () => {
    const { root } = build();
    const row = byId(root, 'mod-row-2');
    // The row carries the idle class, but the SOURCE picker must stay full-strength:
    // it is the one control you need in order to leave the idle state.
    const src = byId(root, 'mod-src-2');
    expect(src.getAttribute('disabled')).toBeNull();
    expect(row.contains(src)).toBe(true);
  });

  it('marks an assigned row as no longer idle', () => {
    const { bus, root } = build();
    const row = byId(root, 'mod-row-2');
    const idle = row.className;
    bus.set('mod.0.src', MOD_SRC.lfo1);
    expect(row.className).not.toBe(idle);
  });

  it('treats an LFO row with no destination as idle too', () => {
    const { bus, root } = build();
    const row = byId(root, 'mod-row-0');
    const idle = row.className;
    bus.set('lfo.dest', 1);            // cutoff
    expect(row.className).not.toBe(idle);
  });
});

describe('mod matrix window — the boundary is stated (ADR-017)', () => {
  it('says where to go for the params the matrix does not reach', () => {
    const { root } = build();
    const hint = byId(root, 'mod-hint').textContent!;
    // Without this the short destination list reads as a missing feature.
    expect(hint).toMatch(/Motion/);
    expect(hint).toMatch(/XY Pad/);
  });
});
