import { vi } from 'vitest';

/**
 * Load a real `public/worklets/<name>.js` under Node: stub the globals of the
 * AudioWorkletGlobalScope (`sampleRate`, `AudioWorkletProcessor`,
 * `registerProcessor`, plus any `globals` a worklet reads, such as
 * `currentFrame`), import the file, and resolve the processor class it
 * registered. Call from `beforeAll`.
 *
 * Each suite types the result with its own `ProcessorLike`: what a test touches
 * differs per worklet, and the harness has no reason to know.
 */
export async function loadWorklet<P>(
  name: string,
  { sampleRate, globals = {} }: { sampleRate: number; globals?: Record<string, unknown> },
): Promise<P> {
  let registered: unknown;
  vi.stubGlobal('sampleRate', sampleRate);
  for (const [k, v] of Object.entries(globals)) vi.stubGlobal(k, v);
  vi.stubGlobal('AudioWorkletProcessor', class {
    port = { onmessage: null, postMessage: vi.fn() };
  });
  vi.stubGlobal('registerProcessor', (_name: string, cls: unknown) => {
    registered = cls;
  });
  await import(`../public/worklets/${name}.js`);
  if (!registered) throw new Error(`${name}.js registered no processor`);
  return registered as P;
}
