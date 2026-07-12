import { describe, it, expect } from 'vitest';
import { SustainPedal } from '../../src/audio/sustain-pedal';

describe('SustainPedal (input-control REQ-8)', () => {
  it('passes note-offs through while the pedal is up', () => {
    const p = new SustainPedal();
    p.noteOn(60);
    expect(p.noteOff(60)).toBe(true);
  });

  it('defers note-offs while the pedal is down and flushes them on release', () => {
    const p = new SustainPedal();
    expect(p.setPedal(true)).toEqual([]);
    p.noteOn(60);
    p.noteOn(64);
    expect(p.noteOff(60)).toBe(false);
    expect(p.noteOff(64)).toBe(false);
    expect(p.setPedal(false).sort()).toEqual([60, 64]);
  });

  it('flushes each sustained note exactly once', () => {
    const p = new SustainPedal();
    p.setPedal(true);
    p.noteOn(60);
    p.noteOff(60);
    p.noteOff(60); // duplicate note-off from the device
    expect(p.setPedal(false)).toEqual([60]);
    expect(p.setPedal(false)).toEqual([]); // nothing left to flush
  });

  it('does not flush a note retriggered while sustained (no stale note-off)', () => {
    const p = new SustainPedal();
    p.setPedal(true);
    p.noteOn(60);
    p.noteOff(60);       // sustained
    p.noteOn(60);        // retrigger: live again
    expect(p.setPedal(false)).toEqual([]); // key is still down — nothing flushes
    expect(p.noteOff(60)).toBe(true);      // its own note-off passes through
  });

  it('a note released after pedal release passes through normally', () => {
    const p = new SustainPedal();
    p.setPedal(true);
    p.noteOn(60);
    p.setPedal(false); // pedal up before the key is released
    expect(p.noteOff(60)).toBe(true);
  });

  it('pressing the pedal again does not resurrect flushed notes', () => {
    const p = new SustainPedal();
    p.setPedal(true);
    p.noteOn(60);
    p.noteOff(60);
    p.setPedal(false);
    expect(p.setPedal(true)).toEqual([]);
    expect(p.setPedal(false)).toEqual([]);
  });
});
