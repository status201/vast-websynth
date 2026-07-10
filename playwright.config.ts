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
  // Each test boots the full app (AudioContext + worklets) in its own Chromium
  // against the on-demand-transforming Vite dev server, so each parallel worker
  // is CPU-heavy. The default (cores/2) starves slower boxes — boots then blow
  // the test timeout. Default to a conservative 2 workers locally (3 in CI,
  // which is a controlled runner); override for your machine with
  // `E2E_WORKERS=1 npm run e2e` (lightest) up to as many as it can sustain.
  workers: Number(process.env.E2E_WORKERS) || (process.env.CI ? 3 : 2),
  // Generous budgets so a slow-but-progressing boot under load isn't killed
  // (the failures these absorb are starvation, not hangs — they pass unloaded).
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    navigationTimeout: 45_000,
    actionTimeout: 15_000,
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
            // WebRTC WiFi-sync loopback (webrtc-sync.spec): expose raw 127.0.0.1
            // host candidates instead of unresolvable mDNS .local names, so two
            // pages in one context can connect with empty iceServers.
            '--disable-features=WebRtcHideLocalIpsWithMdns',
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
