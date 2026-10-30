/**
 * The two sync roles, behind one lazy import (midi-clock-sync.md
 * REQ-the-sync-roles-load-with-the-mode). `SyncController` loads this when a sync
 * mode is selected, so a session that never syncs never pays for either.
 */
export { SyncMaster } from './sync-master';
export { SyncSlave } from './sync-slave';
