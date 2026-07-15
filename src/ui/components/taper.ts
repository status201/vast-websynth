// Moved to src/utils/taper.ts so the audio layer (motion sequencer) can use the
// taper math without importing UI code; re-exported here for existing imports.
export { toNorm, fromNorm } from '../../utils/taper';
