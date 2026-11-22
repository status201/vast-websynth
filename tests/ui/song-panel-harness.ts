import { buildSongPanel, type SongPanel } from '../../src/ui/panels/song-panel';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { Arrangement } from '../../src/audio/transport/arrangement';
import { UiBridge } from '../../src/ui/ui-bridge';
import { TestClock } from '../audio/transport/test-clock';
import { installLocalStorageMock } from '../storage-mock';

/**
 * Every property another stub, every call one too — whatever the panel reaches
 * for. Never a thenable, so an `await` on it does not hang.
 */
export function anything(): unknown {
  const fn = function () { /* stub */ };
  const proxy: unknown = new Proxy(fn, {
    get: (_t, key) => {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === Symbol.iterator) return function* () { /* empty */ };
      if (key === 'then') return undefined;
      return proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

/**
 * A Song panel in the document over a real `PatternStore` and `Arrangement`;
 * everything else it touches is {@link anything}. Installs the storage mock.
 */
export function mountSongPanel(): { panel: SongPanel; arrangement: Arrangement; patterns: PatternStore } {
  installLocalStorageMock();
  const bus = new ParamBus();
  registerDefaults(bus);
  const patterns = new PatternStore();
  const arrangement = new Arrangement(patterns, new TestClock());
  const stub = anything() as Record<PropertyKey, unknown>;
  const engine = new Proxy(stub, {
    get: (t, key) => key === 'arrangement' ? arrangement : key === 'patterns' ? patterns : t[key],
  }) as never;
  const a = anything() as never;
  const panel = buildSongPanel(bus, engine, a, a, new UiBridge(), a, a);
  document.body.appendChild(panel.el);
  return { panel, arrangement, patterns };
}
