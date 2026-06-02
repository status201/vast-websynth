import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config — drives the real app in headless Chromium. Tests live in `e2e/`,
 * outside `src/`, so `tsc` / `npm run typecheck` never sees them (tsconfig
 * `include` is `src` only), exactly like the Vitest suite under `tests/`.
 *
 * Server: the Vite dev server (`npm run dev` → :5173). Switching to the
 * production bundle later is a 2-line change — set `command` to
 * `npm run build && npm run preview` and the URLs to `http://localhost:4173`
 * (Vite preview's default; no `preview.port` is configured).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // 1440x900 so isCompact (max-width:1280) and isPhone (max-width:767)
        // are both false — the full faceplate and pattern tabs render expanded.
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            // Future-proofs the mic-record phase; harmless for the smoke test.
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
