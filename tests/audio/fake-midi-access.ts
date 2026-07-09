import { vi } from 'vitest';

/**
 * Hand-rolled fake Web MIDI access for unit tests (jsdom has no Web MIDI).
 * Structurally satisfies the slice of `MIDIAccess` the code under test uses:
 * `inputs`/`outputs` Maps (with `.size` and `.forEach`) and recording
 * `output.send(data, timestamp)` spies.
 */

export interface FakeMidiOutput {
  id: string;
  send: ReturnType<typeof vi.fn>;
}

export interface FakeMidiAccess {
  access: MIDIAccess;
  outputs: FakeMidiOutput[];
}

export function makeFakeMidiAccess(ins = 1, outs = 2): FakeMidiAccess {
  const inputMap = new Map<string, { id: string }>();
  for (let i = 0; i < ins; i++) inputMap.set(`in-${i}`, { id: `in-${i}` });

  const outputs: FakeMidiOutput[] = [];
  const outputMap = new Map<string, FakeMidiOutput>();
  for (let i = 0; i < outs; i++) {
    const out: FakeMidiOutput = { id: `out-${i}`, send: vi.fn() };
    outputs.push(out);
    outputMap.set(out.id, out);
  }

  return {
    access: { inputs: inputMap, outputs: outputMap } as unknown as MIDIAccess,
    outputs,
  };
}
