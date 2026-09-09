/**
 * Factory EQ curves — see `specs/features/equalizer.md` REQ-15.
 *
 * A "preset" here is just a named table of scalar param values applied through
 * the `ParamBus`: no new audio code, no new persistence, and every param it
 * touches is already captured by presets and songs. That is deliberately the
 * same shape `audio/drums/drum-kits.ts` uses — the pattern earns its keep twice.
 *
 * The four **De-…** entries are the reason the band centres are where they are
 * (`eq.ts` REQ-2): each one cuts the band sitting inside the matching zone the
 * Spectrum names, so "I can see the problem" and "I can fix the problem" use the
 * same vocabulary.
 */
import type { ParamBus } from './params';
import {
  EQ_BAND_COUNT, EQ_HP_REF, EQ_LP_REF, EQ_WIDTH_DEFAULT,
  type EqSettings,
} from './eq';

export interface EqPreset {
  /** dB per band, length `EQ_BAND_COUNT`. */
  b: readonly number[];
  /** Highpass corner in Hz; omitted means open. */
  hp?: number;
  /** Lowpass corner in Hz; omitted means open. */
  lp?: number;
  /** Peaking Q; omitted means the registered default. */
  width?: number;
}

/**
 * Shown in the dropdown when the curve matches no table entry. Never a key of
 * `EQ_PRESETS` — it is a *report*, not something you can pick, so that the
 * control never names a shape that is no longer on screen (ADR-014 law 5, the
 * rule the scratch presets already follow).
 */
export const EQ_PRESET_CUSTOM = 'Custom';

/** The entry that reproduces the registered defaults exactly — the way back. */
export const EQ_PRESET_FLAT = 'Flat';

const Z = [0, 0, 0, 0, 0, 0, 0, 0];

/*  band:      0     1     2      3       4      5       6     7
    hz:       60   150   400    900    2000   5000    8000  12000
    role:    SUB   MUD   BOX  NASAL    PRES  HARSH     SIB    AIR   */
export const EQ_PRESETS: Record<string, EqPreset> = {
  // The no-op safety net, exactly as `DRUM_KITS.Default` is: every field at its
  // registered default, so picking it can never leave a stray value behind.
  [EQ_PRESET_FLAT]: { b: Z, hp: EQ_HP_REF, lp: EQ_LP_REF, width: EQ_WIDTH_DEFAULT },

  // — the filter shapes, which is what the real HP/LP are for (REQ-3) —
  'Low Pass': { b: Z, lp: 800 },
  'High Pass': { b: Z, hp: 300 },
  'Band Pass': { b: Z, hp: 300, lp: 3000 },
  // Narrow band plus a presence bump — the shape everyone recognises.
  Telephone: { b: [0, 0, 0, 0, 6, 0, 0, 0], hp: 500, lp: 3000 },

  // — corrective —
  'Hiss Removal': { b: [0, 0, 0, 0, 0, 0, -9, -6], lp: 9000 },
  'Rumble Cut': { b: [-6, 0, 0, 0, 0, 0, 0, 0], hp: 45 },

  // — problem frequencies, one per named Spectrum zone. Narrow on purpose:
  //   this is the "surgical" end of the WIDTH knob doing its job.
  'De-Mud': { b: [0, -8, -3, 0, 0, 0, 0, 0], width: 1.4 },
  'De-Box': { b: [0, 0, -8, 0, 0, 0, 0, 0], width: 2 },
  'De-Nasal': { b: [0, 0, 0, -8, 0, 0, 0, 0], width: 2 },
  'De-Harsh': { b: [0, 0, 0, 0, 0, -8, 0, 0], width: 2 },

  // — tone —
  Warmth: { b: [3, 2, 0, 0, 0, -3, 0, 0], width: 0.8 },
  Presence: { b: [0, 0, 0, 0, 3, 4, 2, 0], width: 0.8 },
  Air: { b: [0, 0, 0, 0, 0, 0, 0, 5] },
};

export function eqPresetNames(): string[] {
  return Object.keys(EQ_PRESETS);
}

/** A preset's fields with its omissions filled in — the shape the bus wants. */
function settingsOf(p: EqPreset): EqSettings {
  return {
    gains: p.b,
    width: p.width ?? EQ_WIDTH_DEFAULT,
    hp: p.hp ?? EQ_HP_REF,
    lp: p.lp ?? EQ_LP_REF,
  };
}

function write(bus: ParamBus, prefix: string, s: EqSettings): void {
  for (let i = 0; i < EQ_BAND_COUNT; i++) bus.set(`${prefix}.b${i}`, s.gains[i] ?? 0);
  bus.set(`${prefix}.width`, s.width);
  bus.set(`${prefix}.hp`, s.hp);
  bus.set(`${prefix}.lp`, s.lp);
}

/**
 * Apply a named curve to one lane **and engage it** (REQ-15).
 *
 * Writing `.on` is the load-bearing half: picking a preset is intent to *hear*
 * it, and a preset that silently did nothing because the lane was bypassed would
 * be exactly the invisible state ADR-014 law 5 forbids. The switch's LED moves
 * with it, so the outcome is visible where the gesture happened.
 */
export function applyEqPreset(bus: ParamBus, prefix: string, name: string): void {
  const p = EQ_PRESETS[name];
  if (!p) return;
  write(bus, prefix, settingsOf(p));
  bus.set(`${prefix}.on`, 1);
}

/**
 * Flatten one lane, leaving its on/off alone — what the panel's RESET does.
 * Deliberately *not* `applyEqPreset(bus, prefix, 'Flat')`: RESET undoes a curve,
 * it does not switch the effect on, and one gesture owes one outcome.
 */
export function resetEq(bus: ParamBus, prefix: string): void {
  write(bus, prefix, settingsOf(EQ_PRESETS[EQ_PRESET_FLAT]!));
}

/** Within a hair of each other, in dB or Hz — presets are authored round. */
function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

/**
 * Which preset a lane is currently sitting on, or `EQ_PRESET_CUSTOM`.
 *
 * Derived rather than stored, on purpose: the dropdown and the curve would
 * otherwise be two sources of truth for one thing, and the stored one would go
 * stale the first time a band was dragged.
 */
export function matchEqPreset(s: EqSettings): string {
  for (const [name, p] of Object.entries(EQ_PRESETS)) {
    const t = settingsOf(p);
    if (!near(t.width, s.width, 0.01)) continue;
    if (!near(t.hp, s.hp, 0.5) || !near(t.lp, s.lp, 0.5)) continue;
    let same = true;
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      if (!near(t.gains[i] ?? 0, s.gains[i] ?? 0, 0.05)) { same = false; break; }
    }
    if (same) return name;
  }
  return EQ_PRESET_CUSTOM;
}
