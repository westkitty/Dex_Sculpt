import { defineConfig, devices } from '@playwright/test';

/**
 * DEX//SCULPT browser suite.
 *
 * The suite drives the real app served by Vite. If `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
 * points at a Chromium build (as in CI sandboxes without download access), that
 * binary is used; otherwise Playwright's own installed browser is used.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:5190',
    viewport: { width: 1280, height: 800 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    launchOptions: {
      executablePath,
      args: process.env.PLAYWRIGHT_CHROMIUM_ARGS?.split(' ').filter(Boolean) ?? [],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5190',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
