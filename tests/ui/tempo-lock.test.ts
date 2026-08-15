import { describe, it, expect } from 'vitest';
import { Knob } from '../../src/ui/components/knob';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { TEMPO_LOCKS, syncIdFor, tempoLockFor } from '../../src/state/tempo-lock';
import { DIVISION_LABELS } from '../../src/ui/components/tempo-lock';
import { DIVISIONS, SYNC_LABELS, nearestDivision } from '../../src/utils/tempo';
import knobStyles from '../../src/ui/styles/knob.module.css';

/**
 * The tempo lock a Knob grows on a lockable param (tempo-lock.md).
 *
 * One case per row of the spec's gesture inventory, per `design-an-interaction`
 * step 6 — including the rows that are deliberately `—`, since "nothing happens"
 * is the requirement there and only a test can hold it.
 *
 * jsdom sees no CSS, so the swap is asserted through the `synced` state class the
 * stylesheet keys off, not through computed styles.
 */

function bus() {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

const lockBtn = (k: Knob, id: string) =>
  k.el.querySelector<HTMLButtonElement>(`[data-testid="tempolock-${id}"]`);
const chip = (k: Knob, id: string) =>
  k.el.querySelector<HTMLElement>(`[data-testid="tempodiv-${id}"]`);
const chipLabel = (k: Knob, id: string) =>
  chip(k, id)!.querySelector<HTMLElement>('button span')!.textContent;
const readout = (k: Knob) => k.el.querySelector<HTMLElement>('.' + knobStyles.num!)!.textContent;
const options = (k: Knob, id: string) =>
  [...chip(k, id)!.querySelectorAll<HTMLButtonElement>('button')].slice(1);
const option = (k: Knob, id: string, label: string) =>
  options(k, id).find((o) => o.textContent === label)!;

describe('the lockable-param table', () => {
  it('names a sync param that is actually registered, for every entry', () => {
    const b = bus();
    for (const id of Object.keys(TEMPO_LOCKS)) {
      expect(b.def(id), id).toBeDefined();
      const sync = b.def(syncIdFor(id));
      expect(sync, syncIdFor(id)).toBeDefined();
      expect(sync!.default).toBe(0); // free, an exact no-op (REQ-8)
      expect(sync!.labels).toEqual(SYNC_LABELS);
    }
  });

  it('labels the chip with the space stripped, one per division', () => {
    expect(DIVISION_LABELS).toHaveLength(DIVISIONS.length);
    expect(DIVISION_LABELS).toContain('1/16D');
    expect(DIVISION_LABELS).not.toContain('free'); // REQ-5: no `free` row
    // The compact label is the registered one minus its space, so a row picked in
    // the menu and the chip it produces cannot say different things.
    expect(DIVISION_LABELS).toEqual(DIVISIONS.map((d) => d.label.replace(' ', '')));
  });
});

describe('Knob tempo lock', () => {
  it('grows nothing on a param that is not lockable (REQ-1)', () => {
    const b = bus();
    expect(tempoLockFor('filter.cutoff')).toBeUndefined();
    const k = new Knob({ bus: b, paramId: 'filter.cutoff' });
    expect(lockBtn(k, 'filter.cutoff')).toBeNull();
    expect(chip(k, 'filter.cutoff')).toBeNull();
    expect(k.el.querySelectorAll('button')).toHaveLength(0);
  });

  it('locks to the division nearest the current value, without moving it (REQ-4)', () => {
    const b = bus();
    b.set('transport.bpm', 120);
    b.set('fx.delay.time', 0.26);
    const k = new Knob({ bus: b, paramId: 'fx.delay.time', label: 'TIME' });

    lockBtn(k, 'fx.delay.time')!.click();

    // 0.26 s at 120 BPM sits between 1/8 (0.25) and 1/4 T (0.333).
    expect(b.get('fx.delay.sync')).toBe(nearestDivision(0.26, 120, 'time'));
    expect(SYNC_LABELS[b.get('fx.delay.sync')]).toBe('1/8');
    expect(b.get('fx.delay.time')).toBe(0.26); // the knob value is untouched
  });

  it('swaps the dial for the chip and derives the readout (REQ-3)', () => {
    const b = bus();
    b.set('transport.bpm', 120);
    const k = new Knob({ bus: b, paramId: 'fx.delay.time', label: 'TIME' });
    expect(k.el.classList.contains('synced')).toBe(false);

    b.set('fx.delay.sync', SYNC_LABELS.indexOf('1/8 D'));

    expect(k.el.classList.contains('synced')).toBe(true);
    expect(chipLabel(k, 'fx.delay.time')).toBe('1/8D');
    // A dotted eighth at 120 BPM is 0.375 s — shown through the param's own format.
    expect(readout(k)).toBe('375ms');
  });

  it('re-derives the readout when the tempo moves under a locked knob', () => {
    const b = bus();
    b.set('transport.bpm', 120);
    const k = new Knob({ bus: b, paramId: 'fx.delay.time', label: 'TIME' });
    b.set('fx.delay.sync', SYNC_LABELS.indexOf('1/4'));
    expect(readout(k)).toBe('500ms');

    b.set('transport.bpm', 60);
    expect(readout(k)).toBe('1.00s');
  });

  it('unlocks back to the stored value (REQ-4)', () => {
    const b = bus();
    b.set('fx.wah.rate', 6.8);
    const k = new Knob({ bus: b, paramId: 'fx.wah.rate', label: 'RATE' });
    const btn = lockBtn(k, 'fx.wah.rate')!;

    btn.click();
    expect(b.get('fx.wah.sync')).toBeGreaterThan(0);
    btn.click();

    expect(b.get('fx.wah.sync')).toBe(0);
    expect(b.get('fx.wah.rate')).toBe(6.8);
    expect(k.el.classList.contains('synced')).toBe(false);
    expect(readout(k)).toBe('6.80Hz');
  });

  it('announces the mode on the button, not just in colour (REQ-2)', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'fx.wah.rate', label: 'RATE' });
    const btn = lockBtn(k, 'fx.wah.rate')!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Lock RATE to the tempo');
    expect(btn.getAttribute('aria-label')).toBe(btn.title); // icon-only: name it
    expect(btn.classList.contains('on')).toBe(false);

    btn.click();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.title).toBe('Unlock RATE from the tempo');
    expect(btn.getAttribute('aria-label')).toBe(btn.title);
    expect(btn.classList.contains('on')).toBe(true);
  });

  it('sets the division from the menu (REQ-5)', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'fx.phaser.rate', label: 'RATE' });
    lockBtn(k, 'fx.phaser.rate')!.click();

    // 1 Hz at 120 BPM, inside the phaser's 0.05..5 Hz reach.
    option(k, 'fx.phaser.rate', '1/2')!.click();

    expect(SYNC_LABELS[b.get('fx.phaser.sync')]).toBe('1/2');
    expect(chipLabel(k, 'fx.phaser.rate')).toBe('1/2');
  });

  it('cannot be set to a greyed division (REQ-6)', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'fx.phaser.rate', label: 'RATE' });
    lockBtn(k, 'fx.phaser.rate')!.click();
    const before = b.get('fx.phaser.sync');

    // 1/16 is 8 Hz at 120 BPM, past the phaser's 5 Hz ceiling. The native
    // `disabled` attribute is what blocks it, so there is no guard to forget.
    const row = option(k, 'fx.phaser.rate', '1/16');
    expect(row.disabled).toBe(true);
    row.click();

    expect(b.get('fx.phaser.sync')).toBe(before);
  });

  it('offers the 18 divisions and no free row (REQ-5)', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'fx.phaser.rate', label: 'RATE' });
    const labels = options(k, 'fx.phaser.rate').map((o) => o.textContent);
    expect(labels).toEqual(DIVISION_LABELS);
    expect(labels).not.toContain('free');
  });

  it('greys a division the tempo puts out of range, without dropping it (REQ-6)', () => {
    const b = bus();
    b.set('transport.bpm', 60); // 1/1 is 4 s; fx.delay.time maxes at 1.5
    const k = new Knob({ bus: b, paramId: 'fx.delay.time', label: 'TIME' });

    const whole = option(k, 'fx.delay.time', '1/1');
    expect(whole).toBeDefined(); // shown, not removed
    expect(whole.disabled).toBe(true);
    expect(option(k, 'fx.delay.time', '1/8').disabled).toBe(false);
  });

  it('re-reaches when the tempo changes (REQ-6)', () => {
    const b = bus();
    b.set('transport.bpm', 60);
    const k = new Knob({ bus: b, paramId: 'fx.delay.time', label: 'TIME' });
    expect(option(k, 'fx.delay.time', '1/2').disabled).toBe(true); // 2 s

    b.set('transport.bpm', 160); // a half is now 0.75 s — reachable
    expect(option(k, 'fx.delay.time', '1/2').disabled).toBe(false);
  });

  it('never rewrites the value when a greyed row is the current one (edge, REQ-6)', () => {
    const b = bus();
    b.set('transport.bpm', 120);
    const whole = SYNC_LABELS.indexOf('1/1');
    b.set('fx.delay.sync', whole);
    const k = new Knob({ bus: b, paramId: 'fx.delay.time', label: 'TIME' });

    b.set('transport.bpm', 60); // 1/1 leaves the range under the locked knob
    expect(option(k, 'fx.delay.time', '1/1').disabled).toBe(true);
    expect(b.get('fx.delay.sync')).toBe(whole);
    expect(chipLabel(k, 'fx.delay.time')).toBe('1/1');
  });

  // Gesture-inventory rows that are deliberately `—`.
  it('does not reset the value when the chip is double-tapped', () => {
    const b = bus();
    b.set('fx.wah.rate', 6.8);
    const k = new Knob({ bus: b, paramId: 'fx.wah.rate', label: 'RATE' });
    lockBtn(k, 'fx.wah.rate')!.click();
    const sync = b.get('fx.wah.sync');

    const el = chip(k, 'fx.wah.rate')!;
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(b.get('fx.wah.rate')).toBe(6.8); // double-tap belongs to the dial
    expect(b.get('fx.wah.sync')).toBe(sync); // and it does not unlock either
  });

  it('drops its subscriptions on destroy', () => {
    const b = bus();
    const k = new Knob({ bus: b, paramId: 'fx.delay.time', label: 'TIME' });
    k.destroy();
    // A live subscription would repaint a detached node on every tempo change.
    expect(() => b.set('transport.bpm', 90)).not.toThrow();
    expect(k.el.isConnected).toBe(false);
  });
});
