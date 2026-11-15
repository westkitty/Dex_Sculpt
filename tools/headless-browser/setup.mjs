#!/usr/bin/env node
/**
 * Prepare a headless Chromium that can run the DEX//SCULPT browser suite.
 *
 * Usage:
 *   node tools/headless-browser/setup.mjs
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome node tools/headless-browser/setup.mjs
 *
 * Order of preference:
 *   1. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` — an existing Chromium/Chrome build.
 *   2. Playwright's own download (`npx playwright install chromium`).
 *   3. Fail with instructions, because a suite that silently skips the browser
 *      would be indistinguishable from a suite that passes.
 *
 * The script then launches the browser once and reports the WebGL2 renderer, so
 * a "setup complete" message actually means the suite can run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const args = (process.env.PLAYWRIGHT_CHROMIUM_ARGS ?? '').split(' ').filter(Boolean);

function ensureBrowser() {
  if (explicit) {
    if (!existsSync(explicit)) {
      console.error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE points at ${explicit}, which does not exist.`);
      process.exit(1);
    }
    return explicit;
  }
  console.log('No PLAYWRIGHT_CHROMIUM_EXECUTABLE set; asking Playwright for its bundled Chromium…');
  const result = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(
      '\nChromium could not be downloaded (offline or blocked network).\n' +
        'Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to an existing Chrome/Chromium build and re-run.\n' +
        'On the Arena sandbox image the Chromium package lives at /tmp/chromium and needs\n' +
        'stub NSS libraries plus SwiftShader — see docs/OPERATIONAL_STATE.md, "Headless browser".',
    );
    process.exit(result.status ?? 1);
  }
  return undefined;
}

const executablePath = ensureBrowser();

const browser = await chromium.launch({
  executablePath,
  args: args.length ? args : undefined,
});
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');
const info = await page.evaluate(() => {
  const canvas = document.getElementById('c');
  const gl = canvas.getContext('webgl2');
  if (!gl) return { webgl2: false };
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    webgl2: true,
    vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
  };
});
await browser.close();

console.log(JSON.stringify({ ok: info.webgl2 === true, ...info }, null, 2));
if (!info.webgl2) {
  console.error('This browser build has no WebGL2 context; the studio cannot start. Try --enable-unsafe-swiftshader.');
  process.exit(1);
}
console.log('\nReady. Run: npm run test:e2e');
