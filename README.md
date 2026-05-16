# WebSynth — VAST G1-J5

A browser-based polyphonic subtractive synthesizer built on the Web Audio API.
Vanilla TypeScript + Vite, zero runtime dependencies.

## Features

- **8-voice polyphony** with mono/poly switching and glide
- **Dual oscillator** (sine/triangle/saw/square) + noise, per-osc octave/detune/level
- **Sub oscillator** (one/two octaves down) for analogue weight
- **Unison** voice-stacking with detune spread (fat supersaw)
- **Oscillator drift / "Age"** — subtle analogue tuning instability
- **Vintage glide modes**: off / always / legato (portamento)
- **Moog-style 4-pole ladder filter** with resonance and drive, implemented as a custom AudioWorklet (cutoff modulated in semitones)
- **Two ADSR envelopes** (amp + filter), filter-envelope amount in semitones
- **LFO** routable to cutoff, pitch, amp, or pulse width
- **FX chain**: distortion → wah → phaser → delay → reverb (each independently bypassable)
- **Transport**: clock, arpeggiator, 16-step note sequencer, 8-track drum machine
- **Pattern banks**: the sequencer and drum machine each have 4 banks (A/B/C/D), independently copyable and chainable
- **Song chains**: build an arrangement (e.g. `A A B A C A A D`) per machine — separate seq and drum lanes
- **Live DJ FX**: momentary Fill, Stutter/beat-repeat (1 / 1/8 / 1/4), Filter Drop, Tape Stop, and a manual bipolar DJ Filter sweep (LP ← → HP)
- **Songs**: save/load complete songs (all settings + every bank + chains) as portable `.json` files and browser slots; built-in demos **Knight Rider** and **Zombie Nation**
- **Presets**: factory bank (basic, bass, lead, pad, pluck, wobble) + user presets saved to `localStorage`
- **Input**: on-screen keyboard, computer-keyboard mapping, and Web MIDI
- Oscilloscope / spectrum display, pitch-bend and mod wheels

## Running

```bash
npm install
npm run dev      # vite dev server, --host (open the printed URL)
npm run build    # tsc typecheck + vite production build to dist/
npm run preview  # serve the production build
npm run typecheck
npm test         # vitest run — unit tests (jsdom)
```

Audio starts behind a **"Tap to start"** overlay — browsers require a user
gesture before an `AudioContext` may produce sound.

## Controls

- **Computer keyboard**: `z s x d c v g b h n j m ,` = lower octave,
  `q 2 w 3 e r 5 t 6 y 7 u i` = upper octave
- **Arrow Left/Right**: shift keyboard octave
- **`.` / `/`**: pitch bend up / down (springs back on release)
- **Space**: transport play / stop
- **F** (hold): drum fill
- **Esc**: panic (all notes off)

## Project layout

```
src/
  main.ts            boot: create Engine + ParamBus, mount UI, wire input
  audio/             AudioContext graph
    engine.ts        voice allocation, FX chain wiring, param subscriptions
    voice.ts         one voice: 2 osc + noise → ladder filter → amp
    oscillator.ts, envelope.ts, lfo.ts, midi.ts
    ladder-filter/   AudioWorklet wrapper (worklet in public/worklets/)
    effects/         distortion, wah, phaser, delay, reverb
    drums/           drum synthesis
    transport/       clock, arpeggiator, sequencer, drum-machine,
                     arrangement (chain lanes), performance (live DJ FX)
  state/
    params.ts        ParamBus + all parameter definitions
    patterns.ts      PatternStore (4 seq + 4 drum banks)
    preset.ts        factory bank + localStorage persistence
    song.ts          full-song save/load + demo songs
  ui/                hand-built DOM components and panels
                     (incl. song-panel: chains, DJ FX, song I/O)
  styles/            CSS (base, theme, components, layout)
public/worklets/     ladder-filter.js (runs on the audio thread)
```
