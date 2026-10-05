/**
 * General MIDI names, for reading a .mid as an arranger would
 * (midi-file-reader.md REQ-the-analysis-names-the-parts). Pure data.
 */

/** The 128 GM program names, index = program number (0-based, as on the wire). */
export const GM_PROGRAMS: readonly string[] = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
  'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
  'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass',
  'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
  'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
  'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
  'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto',
  'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
  'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
  'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

export interface GmDrum {
  /** The GM percussion name. */
  name: string;
  /**
   * What plays it here: a drum track key of the author dialect (`kick`, `snare`,
   * `chat`, `ohat`, `ltom`, `mtom`, `htom`, `clap`), `model:<Voice>` for a
   * percussion voice model a track can be switched to (`drum.t{i}.model`), or
   * null when the drum machine has nothing close.
   */
  websynth: string | null;
}

/** GM percussion key map, notes 35-81 (channel 10). */
const GM_DRUMS: Readonly<Record<number, readonly [string, string | null]>> = {
  35: ['Acoustic Bass Drum', 'kick'], 36: ['Bass Drum 1', 'kick'],
  37: ['Side Stick', 'snare'], 38: ['Acoustic Snare', 'snare'],
  39: ['Hand Clap', 'clap'], 40: ['Electric Snare', 'snare'],
  41: ['Low Floor Tom', 'ltom'], 42: ['Closed Hi-Hat', 'chat'],
  43: ['High Floor Tom', 'ltom'], 44: ['Pedal Hi-Hat', 'chat'],
  45: ['Low Tom', 'mtom'], 46: ['Open Hi-Hat', 'ohat'],
  47: ['Low-Mid Tom', 'mtom'], 48: ['Hi-Mid Tom', 'htom'],
  49: ['Crash Cymbal 1', null], 50: ['High Tom', 'htom'],
  51: ['Ride Cymbal 1', null], 52: ['Chinese Cymbal', null],
  53: ['Ride Bell', null], 54: ['Tambourine', 'model:Shaker'],
  55: ['Splash Cymbal', null], 56: ['Cowbell', 'model:Cowbell'],
  57: ['Crash Cymbal 2', null], 58: ['Vibraslap', null],
  59: ['Ride Cymbal 2', null], 60: ['Hi Bongo', 'model:Bongo'],
  61: ['Low Bongo', 'model:Bongo'], 62: ['Mute Hi Conga', 'model:Conga'],
  63: ['Open Hi Conga', 'model:Conga'], 64: ['Low Conga', 'model:Conga'],
  65: ['High Timbale', 'htom'], 66: ['Low Timbale', 'mtom'],
  67: ['High Agogo', 'model:Cowbell'], 68: ['Low Agogo', 'model:Cowbell'],
  69: ['Cabasa', 'model:Shaker'], 70: ['Maracas', 'model:Shaker'],
  71: ['Short Whistle', null], 72: ['Long Whistle', null],
  73: ['Short Guiro', null], 74: ['Long Guiro', null],
  75: ['Claves', 'model:Clave'], 76: ['Hi Wood Block', 'model:Clave'],
  77: ['Low Wood Block', 'model:Clave'], 78: ['Mute Cuica', null],
  79: ['Open Cuica', null], 80: ['Mute Triangle', null],
  81: ['Open Triangle', null],
};

/** The GM drum on `note`, or null outside the GM percussion map. */
export function gmDrum(note: number): GmDrum | null {
  const d = GM_DRUMS[note];
  return d ? { name: d[0], websynth: d[1] } : null;
}
