import { chromium } from '@playwright/test';

/**
 * Diagnostic smoke run: boots the app in headless Chromium, drives one real
 * stroke, checks undo/redo byte-exactness, exports + re-imports, and prints the
 * panel/catalog state. `npm run test:e2e` is the assertion suite; this script is
 * the evidence log you can paste into a report.
 *
 * Environment:
 *   URL                          target dev server (default http://127.0.0.1:5190/)
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE  Chromium binary
 *   PLAYWRIGHT_CHROMIUM_ARGS     space-separated Chromium flags
 *   LD_LIBRARY_PATH              stub NSS + SwiftShader directories when needed
 */

const target = process.env.URL ?? 'http://127.0.0.1:5190/';
const args = (process.env.PLAYWRIGHT_CHROMIUM_ARGS ?? '')
  .split(' ')
  .filter(Boolean);

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  args: args.length ? args : undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

const log = (...args) => console.log(...args);

await page.goto(target, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DEXSCULPT, null, { timeout: 30000 });
await page.waitForFunction(() => window.__DEXSCULPT.ready?.() === true, null, { timeout: 120000 });
await page.waitForTimeout(1500);

const state = await page.evaluate(() => window.__DEXSCULPT.state());
log('STATE', JSON.stringify(state, null, 2));
const character = await page.evaluate(() => window.__DEXSCULPT.character());
log('CHARACTER', JSON.stringify(character, null, 2));
log('CHIPS', await page.textContent('#characterChips'));
log('INSPECTOR_TAB', await page.getAttribute('#inspectorTabs [aria-selected="true"]', 'data-tab'));

// --- appearance panel: morph slider present?
const morphCount = await page.locator('[data-morph]').count();
log('MORPH_SLIDERS', morphCount);
const materialCount = await page.locator('[data-material]').count();
log('MATERIAL_INPUTS', materialCount);

// --- sculpt mode + real stroke through pointer events
await page.evaluate(() => window.__DEXSCULPT.setMode('sculpt'));
await page.waitForTimeout(400);
const screen = await page.evaluate(() => window.__DEXSCULPT.screenPoint());
log('SCREEN_POINT', JSON.stringify(screen));
log('PICK', JSON.stringify(await page.evaluate((p) => window.__DEXSCULPT.pickAt(p.x, p.y), screen)));

const before = await page.evaluate(() => window.__DEXSCULPT.sculptStats());
const strokeOk = await page.evaluate(() => window.__DEXSCULPT.strokeScreen(28, 6));
await page.waitForTimeout(500);
const after = await page.evaluate(() => window.__DEXSCULPT.sculptStats());
log('STROKE_STARTED', strokeOk);
log('AFTER_STROKE', JSON.stringify({
  deltaChanged: before.deltaHash !== after.deltaHash,
  skinUnchanged: before.skinHash?.joints === after.skinHash?.joints && before.skinHash?.weights === after.skinHash?.weights,
  baseUnchanged: before.baseHash === after.baseHash,
  movedVertices: after.movedVertices,
  maxDelta: after.maxDelta,
  history: (await page.evaluate(() => window.__DEXSCULPT.state())).history,
}));

// --- undo / redo
await page.evaluate(() => window.__DEXSCULPT.undo());
await page.waitForTimeout(300);
const undone = await page.evaluate(() => window.__DEXSCULPT.sculptStats());
log('UNDO_RESTORES', undone.deltaHash === before.deltaHash, 'history', (await page.evaluate(() => window.__DEXSCULPT.state())).history);
await page.evaluate(() => window.__DEXSCULPT.redo());
await page.waitForTimeout(300);
const redone = await page.evaluate(() => window.__DEXSCULPT.sculptStats());
log('REDO_REAPPLIES', redone.deltaHash === after.deltaHash);

// --- inspect the brushed area visually
if (process.env.SCREENSHOTS) {
  await page.screenshot({ path: 'tools/headless-browser/out/smoke-sculpt.png', animations: 'disabled', timeout: 90000 });
}

// --- probe + export
await page.evaluate(() => window.__DEXSCULPT.runProbe());
log('PROBE', JSON.stringify(await page.evaluate(() => window.__DEXSCULPT.probe())));
const exported = await page.evaluate(async () => {
  const result = await window.__DEXSCULPT.exportAndVerify();
  if (!result) return null;
  return {
    bytes: result.bytes,
    structuralOk: result.structuralOk,
    reimportOk: result.reimportOk,
    checks: result.checks.filter((c) => c.status !== 'pass'),
    reimportChecks: result.reimportChecks.filter((c) => c.status !== 'pass'),
    probes: result.probes,
    morphProbe: result.morphProbe,
  };
});
log('EXPORT', JSON.stringify(exported, null, 2));

// --- panels render in every tab
for (const tab of ['appearance', 'rig', 'animate', 'attach', 'project']) {
  await page.evaluate((t) => window.__DEXSCULPT.setTab(t), tab);
  await page.waitForTimeout(250);
  const html = await page.innerHTML('#inspectorBody');
  log('TAB', tab, 'length', html.length, 'empty-note', html.includes('empty-note'));
}
if (process.env.SCREENSHOTS) {
  await page.screenshot({ path: 'tools/headless-browser/out/smoke-project.png', animations: 'disabled', timeout: 90000 });
}

// --- library renders and catalog loaded
log('CATALOG', await page.evaluate(() => {
  const catalog = window.__DEXSCULPT.catalog();
  return catalog ? { assets: catalog.assets.length, sources: catalog.sources.length, families: catalog.families.length } : null;
}));
log('RAIL_ROWS', await page.locator('#libraryBody .asset').count());

log('ERRORS', JSON.stringify(errors, null, 2));
await browser.close();
