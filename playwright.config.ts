import fs from 'node:fs';
import { defineConfig } from '@playwright/test';

function resolveChromeExecutable(): string | undefined {
  const candidates = [
    process.env.DEX_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return undefined;
}

const executablePath = resolveChromeExecutable();

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.DEX_E2E_BASE ?? 'http://127.0.0.1:5192',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      // Require real WebGL2 initialization on CI's software renderer; no WebGL-failure skip.
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage']
    },
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true
  },
  webServer: process.env.DEX_E2E_BASE
    ? undefined
    : {
        command: 'npx vite build --outDir dist-e2e --emptyOutDir --logLevel warn && npx vite preview --outDir dist-e2e --host 127.0.0.1 --port 5192 --strictPort',
        url: 'http://127.0.0.1:5192',
        reuseExistingServer: false,
        timeout: 180_000
      }
});
