/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
  root: '.',
  publicDir: 'public',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
  test: {
    // jsdom for the DOM-coupled component tests; pure-logic suites run
    // fine under it too. Tests live outside `src/` so `tsc`/`npm run
    // typecheck` are unaffected (tsconfig include is `src` only).
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
