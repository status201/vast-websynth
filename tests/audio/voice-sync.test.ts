// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Voice } from '../../src/audio/voice';
import { SyncOscNode } from '../../src/audio/sync-osc/node';
import { DISCONNECT_DELAY_MS } from '../../src/audio/effects/effect';
import {
  makeMockAudioContext,
  installMockAudioWorkletNode,
  MockAudioWorkletNode,
  type MockAudioParam,
} from './mock-audio-context';

/**
 * specs/features/oscillator-sync.md — the voice side: how the pair is attached,
 * engaged, followed and gated. The mock graph has no sound, so these assert the
 * wiring and the ramps; what the crossfade sounds like is a listening job.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Spy = ReturnType<typeof vi.fn>;
interface MockNode { connect: Spy; disconnect: Spy; gain: MockAudioParam }

const HARD = 1;
const SOFT = 2;

beforeEach(() => {
  vi.useFakeTimers();
  installMockAudioWorkletNode();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function build(attach = true) {
  const ctx = makeMockAudioContext();
  const voice = await Voice.create(ctx as unknown as AudioContext);
  const pair = SyncOscNode.create(ctx as unknown as AudioContext);
  const node = MockAudioWorkletNode.instances.find((n) => n.workletName === 'sync-osc')!;
  if (attach) voice.attachSync(pair);
  const param = (name: string) => node.parameters.get(name);
  const master = pair.master as unknown as MockNode;
  const slave = pair.slave as unknown as MockNode;
  // Osc's native node and its fade gain, which the public surface rightly hides.
  const native = (o: 'osc1' | 'osc2') => ({
    osc: (voice[o] as any).osc as MockNode,
    fade: (voice[o] as any).fade as MockNode,
  });
  return { ctx, voice, pair, node, param, master, slave, native };
}

const lastTarget = (p: MockAudioParam) => p.setTargetAtTime.mock.calls.at(-1)?.[0];

describe('sync off is the native path (REQ-sync-off-is-the-native-path)', () => {
  it('a voice with no pair plays its native oscillators and never asks for one', async () => {
    const { voice, native } = await build(false);
    voice.setSyncMode(HARD); // stored, but there is nothing to engage yet
    voice.noteOn(60, 0.8, 0);
    expect(native('osc1').osc.disconnect).not.toHaveBeenCalled();
    expect(native('osc1').osc.connect).toHaveBeenCalledWith(native('osc1').fade);
  });

  it('attaching a pair while off leaves it silent and unconnected to the oscillators', async () => {
    const { voice, master, node } = await build();
    expect(master.connect).not.toHaveBeenCalledWith(voice.osc1.signal);
    expect(node.port.postMessage).toHaveBeenLastCalledWith(false);
  });
});

describe('engaging crossfades, then cuts the silent side (REQ-engaging-sync-crossfades)', () => {
  it('fades the pair in over the native oscillators, then disconnects the natives', async () => {
    const { voice, master, slave, native } = await build();
    voice.setSyncMode(HARD);
    expect(master.connect).toHaveBeenCalledWith(voice.osc1.signal);
    expect(slave.connect).toHaveBeenCalledWith(voice.osc2.signal);
    expect(lastTarget(master.gain)).toBe(1);
    expect(lastTarget(slave.gain)).toBe(1);
    expect(lastTarget(native('osc1').fade.gain)).toBe(0);
    expect(lastTarget(native('osc2').fade.gain)).toBe(0);
    expect(native('osc1').osc.disconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DISCONNECT_DELAY_MS);
    expect(native('osc1').osc.disconnect).toHaveBeenCalledWith(native('osc1').fade);
    expect(native('osc2').osc.disconnect).toHaveBeenCalledWith(native('osc2').fade);
  });

  it('a toggle back inside the window cancels the cut and cuts the pair instead', async () => {
    const { voice, master, native } = await build();
    voice.setSyncMode(HARD);
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS / 3);
    voice.setSyncMode(0);
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS * 2);
    expect(native('osc1').osc.disconnect).not.toHaveBeenCalled();
    expect(lastTarget(native('osc1').fade.gain)).toBe(1);
    expect(master.disconnect).toHaveBeenCalled();
  });

  it('disengaging re-attaches the natives before fading them back in', async () => {
    const { voice, native } = await build();
    voice.setSyncMode(HARD);
    vi.advanceTimersByTime(DISCONNECT_DELAY_MS);
    native('osc1').osc.connect.mockClear();
    voice.setSyncMode(0);
    expect(native('osc1').osc.connect).toHaveBeenCalledWith(native('osc1').fade);
    expect(lastTarget(native('osc1').fade.gain)).toBe(1);
  });

  it('hard to soft while engaged only changes the mode — no second crossfade', async () => {
    const { voice, param, master } = await build();
    voice.setSyncMode(HARD);
    const ramps = master.gain.setTargetAtTime.mock.calls.length;
    voice.setSyncMode(SOFT);
    expect(param('mode').value).toBe(SOFT);
    expect(master.gain.setTargetAtTime.mock.calls.length).toBe(ramps);
  });
});

describe('the pair follows the OSC panels (REQ-the-pair-follows-every-osc-control)', () => {
  it('picks up the current settings at attach, and every change after', async () => {
    const { voice, pair, param } = await build(false);
    voice.osc1.setWave(1);
    voice.osc2.setOctave(1);
    voice.osc2.setDetuneCents(7);
    voice.attachSync(pair);
    expect(param('wave1').value).toBe(1);
    expect(param('slaveCents').value).toBe(1207);

    // Width is mirrored whatever the wave (the pair applies it only to a square,
    // as the native path does) — and a non-square keeps the mock off the PWM bank.
    voice.osc1.setPulseWidth(0.8);
    voice.osc1.setWave(2);
    voice.osc1.setOctave(-1);
    expect(param('wave1').value).toBe(2);
    expect(param('width1').value).toBeCloseTo(0.8);
    expect(param('masterCents').value).toBe(-1200);
  });

  it('plays each note at the native oscillators’ frequency, glide included', async () => {
    const { voice, param } = await build();
    voice.noteOn(69, 0.8, 0.5);
    expect(param('frequency').setValueAtTime).toHaveBeenLastCalledWith(440, 0.5);
    voice.setGlide(0.3);
    voice.noteOn(81, 0.8, 1);
    const [hz, at, tau] = param('frequency').setTargetAtTime.mock.calls.at(-1)!;
    expect([hz, at]).toEqual([880, 1]);
    expect(tau).toBeCloseTo(0.1);
  });

  it('feeds the knob into the sync junction, which feeds the pair', async () => {
    const { voice, pair } = await build();
    voice.setSyncPitch(19);
    expect(lastTarget(voice.syncTarget as unknown as MockAudioParam)).toBe(19);
    expect((voice.syncMod as unknown as MockNode).connect).toHaveBeenCalledWith(pair.syncPitch);
    expect((voice.pitchMod as unknown as MockNode).connect).toHaveBeenCalledWith(pair.detune);
  });
});

describe('every pitch source reaches the pair (REQ-every-pitch-source-reaches-the-pair)', () => {
  it('pitchTargets is the three native detunes plus the pitch junction', async () => {
    const { voice } = await build();
    expect(voice.pitchTargets()).toEqual([
      voice.osc1.detuneParam, voice.osc2.detuneParam, voice.sub.detuneParam, voice.pitchMod.offset,
    ]);
  });

  it('the per-note bend is wired to every one of them', async () => {
    const { voice } = await build();
    const bend = voice.noteBend as unknown as MockNode;
    for (const t of voice.pitchTargets()) expect(bend.connect).toHaveBeenCalledWith(t);
  });
});

describe('FM reaches the pair (cross-modulation.md REQ-fm-reaches-the-sync-pair)', () => {
  it('the FM index junction feeds the pair\'s fm param once attached', async () => {
    const { voice, param } = await build();
    // The junction is the node whose offset is the voice's fm target.
    const junction = (voice as any).xmod.fmMod as MockNode;
    expect((junction as any).offset).toBe(voice.fmTarget);
    expect(junction.connect).toHaveBeenCalledWith(param('fm'));
  });
});

describe('the pair idles with the voice (REQ-the-pair-idles-with-the-voice)', () => {
  it('is active from noteOn and inactive once the voice is idle — only while engaged', async () => {
    const { voice, node } = await build();
    const post = node.port.postMessage;
    voice.noteOn(60, 0.8, 0);
    expect(post).toHaveBeenLastCalledWith(false); // not engaged: never woken

    voice.setSyncMode(HARD);
    expect(post).toHaveBeenLastCalledWith(true); // engaged over a sounding note
    voice.noteOff(0);
    vi.runOnlyPendingTimers();
    vi.runOnlyPendingTimers();
    expect(voice.state).toBe('idle');
    expect(post).toHaveBeenLastCalledWith(false);

    voice.noteOn(62, 0.8, 1);
    expect(post).toHaveBeenLastCalledWith(true);
  });

  it('engaging over an idle voice does not wake the pair', async () => {
    const { voice, node } = await build();
    voice.setSyncMode(HARD);
    expect(node.port.postMessage).toHaveBeenLastCalledWith(false);
  });
});
