import { vi } from 'vitest';

/**
 * Hand-rolled fake Web MIDI access for unit tests (jsdom has no Web MIDI).
 * Structurally satisfies the slice of `MIDIAccess` the code under test uses:
 * `inputs`/`outputs` Maps (with `.size` and `.forEach`) and recording
 * `output.send(data, timestamp)` spies.
 *
 * Inputs carry a writable `onmidimessage` because `midi.ts` is the sole owner
 * of that property (input-control.md REQ-7) — `receive()` below delivers bytes
 * through whatever handler the code under test assigned, so a test drives the
 * real dispatch rather than a copy of it.
 */

export interface FakeMidiOutput {
  id: string;
  send: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
}

export interface FakeMidiInput {
  id: string;
  /** Single-assignment in the real API; whoever wired last wins here too. */
  onmidimessage: ((ev: MIDIMessageEvent) => void) | null;
  /** Deliver bytes as if the port received them. Throws when nothing is wired,
   *  so a silently-unwired port fails loudly instead of passing vacuously. */
  receive(bytes: number[], timeStamp?: number): void;
}

export interface FakeMidiAccess {
  access: MIDIAccess;
  inputs: FakeMidiInput[];
  outputs: FakeMidiOutput[];
  /** Hot-plug a port and fire `statechange`, the way a real device arriving
   *  after `initMIDI` does. Returns the new input so a test can drive it. */
  plugInput(id?: string): FakeMidiInput;
}

function makeInput(id: string): FakeMidiInput {
  return {
    id,
    onmidimessage: null,
    receive(bytes, timeStamp = 0) {
      if (!this.onmidimessage) throw new Error(`fake MIDI input ${id} has no onmidimessage handler`);
      this.onmidimessage({ data: Uint8Array.from(bytes), timeStamp } as MIDIMessageEvent);
    },
  };
}

export function makeFakeMidiAccess(ins = 1, outs = 2): FakeMidiAccess {
  const inputs: FakeMidiInput[] = [];
  const inputMap = new Map<string, FakeMidiInput>();
  for (let i = 0; i < ins; i++) {
    const input = makeInput(`in-${i}`);
    inputs.push(input);
    inputMap.set(input.id, input);
  }

  const outputs: FakeMidiOutput[] = [];
  const outputMap = new Map<string, FakeMidiOutput>();
  for (let i = 0; i < outs; i++) {
    const out: FakeMidiOutput = { id: `out-${i}`, send: vi.fn(), clear: vi.fn() };
    outputs.push(out);
    outputMap.set(out.id, out);
  }

  const access = {
    inputs: inputMap,
    outputs: outputMap,
    onstatechange: null,
  } as unknown as MIDIAccess;

  return {
    access,
    inputs,
    outputs,
    plugInput(id = `in-${inputs.length}`) {
      const input = makeInput(id);
      inputs.push(input);
      inputMap.set(id, input);
      access.onstatechange?.({} as MIDIConnectionEvent);
      return input;
    },
  };
}
