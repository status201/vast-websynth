import { describe, it, expect, beforeEach, vi } from 'vitest';
import { restoreFactorySettings } from '../../src/state/factory-reset';
import { installLocalStorageMock, installSessionStorageMock } from '../storage-mock';

describe('restoreFactorySettings', () => {
  let local: Map<string, string>;
  let session: Map<string, string>;

  beforeEach(() => {
    local = installLocalStorageMock();
    session = installSessionStorageMock();
  });

  it('clears both storages and then reloads', () => {
    local.set('websynth.preset.index', '[]');
    local.set('websynth.perf', 'strong');
    session.set('some.session.key', '1');

    const reload = vi.fn();
    restoreFactorySettings(reload);

    expect(local.size).toBe(0);
    expect(session.size).toBe(0);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when a storage clear throws', () => {
    vi.stubGlobal('localStorage', {
      clear: () => { throw new Error('blocked'); },
    } as unknown as Storage);
    session.set('k', 'v');

    const reload = vi.fn();
    restoreFactorySettings(reload);

    expect(session.size).toBe(0);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
