import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * DEX//SCULPT Character DNA V2 — complete character authoring journey.
 * Real browser, real pointer input, real render-pixel evidence.
 *
 * NOTE on third-party assets: this run uses the deterministic procedural rigged
 * humanoid. A third-party licensed Quaternius character (male, rigged, ~393 KB)
 * is available to the maintainer but its per-file license/provenance cannot be
 * verified from within this environment without fabricating proof, so this test
 * records REAL_ASSET_VALIDATION_PENDING and does not fabricate licensing claims.
 */

const ART = path.join(process.cwd(), 'e2e-artifacts');
fs.mkdirSync(ART, { recursive: true });

const evidence: Record<string, unknown> = {
  asset: 'procedural-humanoid (deterministic fixture)',
  thirdPartyAssetStatus: 'REAL_ASSET_VALIDATION_PENDING',
  captures: {},
  diffs: {},
  regions: {},
  screenshots: []
};

async function shot(page: Page, name: string): Promise<void> {
  const file = path.join(ART, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  (evidence.screenshots as string[]).push(`${name}.png`);
}

function savePngDataUrl(dataUrl: string, name: string): void {
  fs.writeFileSync(path.join(ART, `${name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
}

/** Max per-vertex displacement vs immutable source positions inside a Y band. */
async function regionDisp(page: Page, yMin: number, yMax: number): Promise<number> {
  return page.evaluate(
    ([lo, hi]) => {
      const app = (window as unknown as { __DEX_SCULPT__: never }).__DEX_SCULPT__;
      const s = app as unknown as {
        session: {
          sculptTargets: Array<{
            geometry: { getAttribute(n: string): { array: Float32Array } };
            snapshot: { sourcePos: Float32Array; renderVertexCount: number };
          }>;
        };
      };
      const t = s.session.sculptTargets[0];
      const pos = t.geometry.getAttribute('position').array;
      const src = t.snapshot.sourcePos;
      let maxD = 0;
      for (let r = 0; r < t.snapshot.renderVertexCount; r++) {
        const y = src[r * 3 + 1];
        if (y < lo || y > hi) continue;
        const d = Math.hypot(pos[r * 3] - src[r * 3], pos[r * 3 + 1] - src[r * 3 + 1], pos[r * 3 + 2] - src[r * 3 + 2]);
        if (d > maxD) maxD = d;
      }
      return maxD;
    },
    [yMin, yMax]
  );
}

/** Project a character-local point to page screen coords via the live camera. */
async function screenPointOf(page: Page, p: [number, number, number]): Promise<{ x: number; y: number }> {
  return page.evaluate((pt) => {
    const app = (window as unknown as {
      __DEX_SCULPT__: {
        viewport: {
          camera: {
            updateMatrixWorld(force?: boolean): void;
            matrixWorld: unknown;
            matrixWorldInverse: { elements: number[]; copy(m: unknown): { invert(): unknown } };
            projectionMatrix: { elements: number[] };
          };
          renderer: { domElement: { getBoundingClientRect(): DOMRect } };
        };
      };
    }).__DEX_SCULPT__;
    const cam = app.viewport.camera;
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const vm = cam.matrixWorldInverse.elements;
    const pm = cam.projectionMatrix.elements;
    const [x, y, z] = pt;
    const vx = vm[0] * x + vm[4] * y + vm[8] * z + vm[12];
    const vy = vm[1] * x + vm[5] * y + vm[9] * z + vm[13];
    const vz = vm[2] * x + vm[6] * y + vm[10] * z + vm[14];
    const cx = pm[0] * vx + pm[4] * vy + pm[8] * vz + pm[12];
    const cy = pm[1] * vx + pm[5] * vy + pm[9] * vz + pm[13];
    const cw = pm[3] * vx + pm[7] * vy + pm[11] * vz + pm[15];
    const rect = app.viewport.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.x + ((cx / cw + 1) / 2) * rect.width,
      y: rect.y + ((1 - cy / cw) / 2) * rect.height
    };
  }, p);
}

/** Real pointer stroke through the real SculptTool at a projected 3D point. */
async function strokeAt(page: Page, p3: [number, number, number]): Promise<void> {
  const s = await screenPointOf(page, p3);
  await page.mouse.move(s.x - 10, s.y);
  await page.mouse.down();
  await page.mouse.move(s.x + 10, s.y - 6, { steps: 8 });
  await page.mouse.move(s.x, s.y + 6, { steps: 6 });
  await page.mouse.up();
}

async function captureCanonical(page: Page, name: string): Promise<string> {
  const dataUrl = await page.evaluate(() => {
    const app = (window as unknown as { __DEX_SCULPT__: { session: { captureCanonicalPng(): string } } }).__DEX_SCULPT__;
    return app.session.captureCanonicalPng();
  });
  savePngDataUrl(dataUrl, name);
  return dataUrl;
}

async function diffPng(page: Page, a: string, b: string): Promise<{ changedRatio: number; maxChannelDelta: number }> {
  return page.evaluate(
    ([da, db]) => {
      const app = (window as unknown as {
        __DEX_SCULPT__: { session: { diffPngDataUrls(x: string, y: string): Promise<{ changedRatio: number; maxChannelDelta: number }> } };
      }).__DEX_SCULPT__;
      return app.session.diffPngDataUrls(da, db);
    },
    [a, b]
  );
}

const JAW_PTS: [number, number, number] = [0, 1.62, 0.1];
const SHOULDER_PTS: [number, number, number] = [0, 1.36, 0.02];
const ALT_PTS: [number, number, number] = [0.12, 1.62, 0.1];
const JAW_BAND: [number, number] = [1.56, 1.76];
const SHOULDER_BAND: [number, number] = [1.24, 1.48];

test.describe('DEX//SCULPT Character DNA V2 — complete authoring journey', () => {
  test('20-step layered character authoring journey with render-pixel evidence', async ({ page }) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    // ---------- STEP 1: Load a humanoid character ----------
    await page.goto('/');
    await page.waitForFunction(() => {
      const app = (window as unknown as { __DEX_SCULPT__?: { session: { root: unknown; sculptTargets: unknown[] } } }).__DEX_SCULPT__;
      return !!app?.session?.root && app.session.sculptTargets.length > 0;
    });
    await expect(page.locator('.status-pill')).toContainText('Rigged · 20 bones · 4 morphs · 3 clips');
    await page.getByRole('button', { name: 'Front', exact: true }).click();
    await page.waitForTimeout(150);
    await shot(page, 'step01-loaded-humanoid');

    await page.locator('.tab-btn[data-tab="layers"]').click();
    await expect(page.locator('.inspector-body')).toContainText('Sculpt Layers');

    // ---------- STEP 2: Create a layer named Jaw ----------
    await page.getByTestId('btn-add-layer').click();
    const jawRow = page.locator('.layer-row.active');
    await jawRow.locator('input[type="text"]').fill('Jaw');
    await jawRow.locator('input[type="text"]').dispatchEvent('change');
    await expect(page.locator('.layer-row.active').locator('input[type="text"]')).toHaveValue('Jaw');
    await shot(page, 'step02-layer-jaw-created');

    // ---------- STEP 3: Sculpt geometry in Jaw ----------
    await strokeAt(page, JAW_PTS);
    const jawDisp = await regionDisp(page, JAW_BAND[0], JAW_BAND[1]);
    expect(jawDisp).toBeGreaterThan(0.002);
    const captureJawOnly = await captureCanonical(page, 'step03-jaw-sculpted');
    await shot(page, 'step03-jaw-sculpted-ui');

    // ---------- STEP 4: Create Shoulders layer, sculpt shoulders ----------
    await page.getByTestId('btn-add-layer').click();
    const shoulderRow = page.locator('.layer-row.active');
    await shoulderRow.locator('input[type="text"]').fill('Shoulders');
    await shoulderRow.locator('input[type="text"]').dispatchEvent('change');
    await expect(page.locator('.layer-row.active').locator('input[type="text"]')).toHaveValue('Shoulders');
    await strokeAt(page, SHOULDER_PTS);
    expect(await regionDisp(page, JAW_BAND[0], JAW_BAND[1])).toBeGreaterThan(0.002);
    expect(await regionDisp(page, SHOULDER_BAND[0], SHOULDER_BAND[1])).toBeGreaterThan(0.002);
    const captureBoth = await captureCanonical(page, 'step04-both-layers');
    await shot(page, 'step04-both-layers-ui');

    // PIXEL EVIDENCE: both-layer render differs from jaw-only render (real geometry changed).
    const diffJawVsBoth = await diffPng(page, captureJawOnly, captureBoth);
    expect(diffJawVsBoth.changedRatio).toBeGreaterThan(0.0005);
    expect(diffJawVsBoth.maxChannelDelta).toBeGreaterThan(8);
    evidence.diffs = { jawOnly_vs_both: diffJawVsBoth };

    // ---------- STEP 5: Hide Jaw layer ----------
    const jawLayerId = await page.evaluate(() => {
      const app = (window as unknown as { __DEX_SCULPT__: { session: { activeVariant: { layers: Array<{ id: string; name: string }> } } } }).__DEX_SCULPT__;
      return app.session.activeVariant.layers.find((l) => l.name === 'Jaw')!.id;
    });
    await page.getByTestId(`btn-layer-visible/${jawLayerId}`).click();
    // INDEPENDENT verification: geometry, not just UI state.
    expect(await regionDisp(page, JAW_BAND[0], JAW_BAND[1])).toBeLessThan(1e-6);
    expect(await regionDisp(page, SHOULDER_BAND[0], SHOULDER_BAND[1])).toBeGreaterThan(0.002);
    const captureJawHidden = await captureCanonical(page, 'step05-jaw-hidden');
    await shot(page, 'step05-jaw-hidden-ui');

    // PIXEL EVIDENCE: hiding the layer visibly changes the rendered pixels.
    const diffHidden = await diffPng(page, captureBoth, captureJawHidden);
    expect(diffHidden.changedRatio).toBeGreaterThan(0.0005);
    (evidence.diffs as Record<string, unknown>).both_vs_jawHidden = diffHidden;

    // ---------- STEP 6: Show Jaw layer again ----------
    await page.getByTestId(`btn-layer-visible/${jawLayerId}`).click();
    expect(await regionDisp(page, JAW_BAND[0], JAW_BAND[1])).toBeGreaterThan(0.002);
    expect(await regionDisp(page, SHOULDER_BAND[0], SHOULDER_BAND[1])).toBeGreaterThan(0.002);
    const captureReshown = await captureCanonical(page, 'step06-jaw-reshown');

    // PIXEL EVIDENCE: show restores EXACTLY (deterministic recomposition, edits never lost).
    const diffReshownVsBoth = await diffPng(page, captureBoth, captureReshown);
    expect(diffReshownVsBoth.changedRatio).toBeLessThan(0.0005);
    (evidence.diffs as Record<string, unknown>).reshown_vs_both = diffReshownVsBoth;

    // ---------- STEP 7: Independent verification of layer hide/show ----------
    // (done inline in steps 5-6 via geometry bands + canonical render pixel diffs; log it)
    (evidence.regions as Record<string, number>) = {
      jawSculpted: jawDisp,
      jawHidden: await regionDisp(page, JAW_BAND[0], JAW_BAND[1]),
      shouldersAfterShow: await regionDisp(page, SHOULDER_BAND[0], SHOULDER_BAND[1])
    };

    // ---------- STEP 8: Undo the Shoulders sculpt (topbar Undo, exact LIFO) ----------
    // History top: [..., Sculpt Shoulders, Hide Jaw, Show Jaw].
    await page.getByTestId('btn-layer-undo').click(); // undo Show Jaw
    await page.waitForTimeout(120);
    expect(await regionDisp(page, JAW_BAND[0], JAW_BAND[1])).toBeLessThan(1e-6);
    expect(await regionDisp(page, SHOULDER_BAND[0], SHOULDER_BAND[1])).toBeGreaterThan(0.002);
    await page.getByTestId('btn-layer-undo').click(); // undo Hide Jaw
    await page.waitForTimeout(120);
    expect(await regionDisp(page, JAW_BAND[0], JAW_BAND[1])).toBeGreaterThan(0.002);
    await page.getByTestId('btn-layer-undo').click(); // undo Sculpt Shoulders
    await page.waitForTimeout(120);
    expect(await regionDisp(page, SHOULDER_BAND[0], SHOULDER_BAND[1])).toBeLessThan(1e-6);
    expect(await regionDisp(page, JAW_BAND[0], JAW_BAND[1])).toBeGreaterThan(0.002);

    // ---------- STEP 9: Redo ----------
    for (let i = 0; i < 3; i++) {
      await page.getByTestId('btn-layer-redo').click();
      await page.waitForTimeout(120);
    }
    expect(await regionDisp(page, SHOULDER_BAND[0], SHOULDER_BAND[1])).toBeGreaterThan(0.002);
    expect(await regionDisp(page, JAW_BAND[0], JAW_BAND[1])).toBeGreaterThan(0.002);

    // ---------- STEP 10: Create a new variant "Hero" ----------
    await page.locator('.tab-btn[data-tab="variants"]').click();
    await expect(page.locator('.inspector-body')).toContainText('Character Variants');
    // Rename the default variant first for a clean journey.
    const variantNames = page.locator('.variant-row input[type="text"]');
    await variantNames.first().fill('Hero');
    await variantNames.first().dispatchEvent('change');
    await page.getByTestId('btn-new-variant').click();
    const rows = page.locator('.variant-row input[type="text"]');
    await rows.nth(1).fill('Clean Base');
    await rows.nth(1).dispatchEvent('change');
    await shot(page, 'step10-variants-panel');

    // ---------- STEP 11: Duplicate Hero into "Hero Alt" ----------
    const heroId = await page.evaluate(() => {
      const app = (window as unknown as { __DEX_SCULPT__: { session: { dna: { activeId: string; variants: Array<{ id: string; name: string }> } } } }).__DEX_SCULPT__;
      return app.session.dna.variants.find((v) => v.name === 'Hero')!.id;
    });
    await page.getByTestId(`btn-variant-duplicate/${heroId}`).click();
    const altRowId = await page.evaluate(() => {
      const app = (window as unknown as { __DEX_SCULPT__: { session: { dna: { variants: Array<{ id: string; name: string }> } } } }).__DEX_SCULPT__;
      return app.session.dna.variants.find((v) => v.name === 'Hero copy')!.id;
    });
    await page.getByTestId(`variant-name/${altRowId}`).fill('Hero Alt');
    await page.getByTestId(`variant-name/${altRowId}`).dispatchEvent('change');
    await shot(page, 'step11-variant-duplicated');

    // ---------- STEP 12: Modify Hero Alt (layer + morph + material) ----------
    const altId = await page.evaluate(() => {
      const app = (window as unknown as { __DEX_SCULPT__: { session: { dna: { variants: Array<{ id: string; name: string }> } } } }).__DEX_SCULPT__;
      return app.session.dna.variants.find((v) => v.name === 'Hero Alt')!.id;
    });
    await page.getByTestId(`btn-variant-switch/${altId}`).click();
    await page.locator('.tab-btn[data-tab="layers"]').click();
    await page.getByTestId('btn-add-layer').click();
    const altLayer = page.locator('.layer-row.active');
    await altLayer.locator('input[type="text"]').fill('Alt Mark');
    await altLayer.locator('input[type="text"]').dispatchEvent('change');
    await strokeAt(page, ALT_PTS);
    await page.locator('.tab-btn[data-tab="shape"]').click();
    const jawMorph = page.locator('input[data-morph="Jaw_Width"]');
    await jawMorph.fill('0.5');
    await jawMorph.dispatchEvent('input');
    await jawMorph.dispatchEvent('change');
    await page.locator('.tab-btn[data-tab="materials"]').click();
    await page.locator('input[type="color"]').first().fill('#ff2200');
    await page.locator('input[type="color"]').first().dispatchEvent('change');
    await shot(page, 'step12-hero-alt-modified');

    const altState = await page.evaluate(() => {
      const app = (window as unknown as {
        __DEX_SCULPT__: {
          session: {
            activeVariant: { name: string; layers: Array<{ name: string }>; morphWeights: Record<string, number>; materialOverrides: Record<string, unknown> };
            materials: Array<{ material: { color: { getHexString(): string } } }>;
          };
        };
      }).__DEX_SCULPT__;
      return {
        variant: app.session.activeVariant.name,
        layers: app.session.activeVariant.layers.map((l) => l.name),
        morph: app.session.activeVariant.morphWeights['Jaw_Width'] ?? 0,
        matKeys: Object.keys(app.session.activeVariant.materialOverrides),
        color: app.session.materials[0].material.color.getHexString()
      };
    });
    expect(altState.variant).toBe('Hero Alt');
    expect(altState.layers).toEqual(['Jaw', 'Shoulders', 'Alt Mark']);
    expect(altState.morph).toBeCloseTo(0.5, 3);
    expect(altState.matKeys.length).toBeGreaterThan(0);
    const captureAlt = await captureCanonical(page, 'step12-hero-alt');

    // ---------- STEP 13: Switch back to Hero: appearance fully restored ----------
    await page.locator('.tab-btn[data-tab="variants"]').click();
    await page.getByTestId(`btn-variant-switch/${heroId}`).click();
    const heroState = await page.evaluate(() => {
      const app = (window as unknown as {
        __DEX_SCULPT__: {
          session: {
            activeVariant: { name: string; layers: Array<{ name: string }>; morphWeights: Record<string, number> };
            materials: Array<{ material: { color: { getHexString(): string } } }>;
            morphs: Array<{ name: string; value: number }>;
          };
        };
      }).__DEX_SCULPT__;
      return {
        variant: app.session.activeVariant.name,
        layers: app.session.activeVariant.layers.map((l) => l.name),
        morphValue: app.session.morphs.find((m) => m.name === 'Jaw_Width')!.value,
        color: app.session.materials[0].material.color.getHexString()
      };
    });
    expect(heroState.variant).toBe('Hero');
    expect(heroState.layers).toEqual(['Jaw', 'Shoulders']);
    expect(heroState.morphValue).toBe(0);
    expect(heroState.color).not.toBe(altState.color);
    const captureHero = await captureCanonical(page, 'step13-hero-restored');

    // PIXEL EVIDENCE: variant switching changes rendered pixels (layers/morphs/materials differ).
    const diffVariants = await diffPng(page, captureHero, captureAlt);
    expect(diffVariants.changedRatio).toBeGreaterThan(0.001);
    (evidence.diffs as Record<string, unknown>).hero_vs_heroAlt = diffVariants;

    // ---------- STEP 14: Switch to Hero Alt: modifications live only there ----------
    await page.getByTestId(`btn-variant-switch/${altId}`).click();
    expect(await regionDisp(page, 1.56, 1.76)).toBeGreaterThan(0.002); // jaw + alt mark
    const captureAltBack = await captureCanonical(page, 'step14-hero-alt-back');
    const diffAltStable = await diffPng(page, captureAlt, captureAltBack);
    expect(diffAltStable.changedRatio).toBeLessThan(0.0005); // switching is lossless

    // ---------- STEP 15: A/B comparison with identical framing ----------
    await page.locator('.tab-btn[data-tab="variants"]').click();
    await page.getByTestId('select-compare-a').selectOption(heroId);
    await page.getByTestId('select-compare-b').selectOption(altId);
    await page.getByTestId('btn-compare-ab').click();
    await expect(page.locator('.modal-card')).toBeVisible();
    await expect(page.locator('[data-testid="compare-img-a"]')).toBeVisible();
    await expect(page.locator('[data-testid="compare-img-b"]')).toBeVisible();
    const statText = await page.locator('[data-testid="compare-stat"]').textContent();
    expect(statText).toContain('Rendered-pixel difference');
    const pct = parseFloat(statText!.match(/([\d.]+)% of pixels changed/)![1]);
    expect(pct).toBeGreaterThan(0.1);
    await shot(page, 'step15-ab-compare-modal');
    await page.keyboard.press('Escape');

    // ---------- STEP 16: Save the recipe (real download, schema V2 verified) ----------
    const [recipeDl] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.topbar-more summary').click().then(() => page.getByTestId('btn-save-recipe').click())
    ]);
    expect(recipeDl.suggestedFilename()).toContain('.dexsculpt.json');
    const recipePath = await recipeDl.path();
    const recipeJson = JSON.parse(fs.readFileSync(recipePath!, 'utf8'));
    expect(recipeJson.schemaVersion).toBe('dexsculpt.recipe.v2');
    expect(recipeJson.dna.variants.map((v: { name: string }) => v.name).sort()).toEqual(
      ['Clean Base', 'Hero', 'Hero Alt'].sort()
    );
    expect(recipeJson.dna.variants.find((v: { name: string }) => v.name === 'Hero Alt').layers.map((l: { name: string }) => l.name)).toEqual([
      'Jaw',
      'Shoulders',
      'Alt Mark'
    ]);
    fs.copyFileSync(recipePath!, path.join(ART, 'journey-recipe-v2.dexsculpt.json'));
    await shot(page, 'step16-recipe-saved');

    // ---------- STEP 17: Autosave completes (IndexedDB, debounced) ----------
    await page.waitForTimeout(1500);
    await page.locator('.tab-btn[data-tab="variants"]').click();
    await expect(page.locator('[data-testid="status-autosave"]')).toContainText('Saved');
    await expect(page.locator('[data-testid="status-recover"]')).toContainText('Full');

    // ---------- STEP 18: Reload the browser; everything restores ----------
    await page.reload();
    await page.waitForFunction(() => {
      const app = (window as unknown as { __DEX_SCULPT__?: { session: { root: unknown; dna: { variants: Array<{ name: string }> } | null } } }).__DEX_SCULPT__;
      return !!app?.session?.root && !!app.session.dna && app.session.dna.variants.some((v) => v.name === 'Hero Alt');
    });
    const restored = await page.evaluate(() => {
      const app = (window as unknown as {
        __DEX_SCULPT__: {
          session: {
            dna: { activeId: string; variants: Array<{ id: string; name: string; layers: Array<{ name: string }>; morphWeights: Record<string, number> }> };
            getStatus(): { boneCount: number; morphCount: number; clipCount: number };
          };
        };
      }).__DEX_SCULPT__;
      const active = app.session.dna.variants.find((v) => v.id === app.session.dna.activeId)!;
      return {
        activeName: active.name,
        layers: active.layers.map((l) => l.name),
        morph: active.morphWeights['Jaw_Width'] ?? 0,
        status: app.session.getStatus()
      };
    });
    expect(restored.activeName).toBe('Hero Alt'); // active variant restored
    expect(restored.layers).toEqual(['Jaw', 'Shoulders', 'Alt Mark']);
    expect(restored.morph).toBeCloseTo(0.5, 3);
    expect(restored.status.boneCount).toBe(20);
    expect(restored.status.morphCount).toBe(4);
    expect(restored.status.clipCount).toBe(3);
    expect(await regionDisp(page, JAW_BAND[0], JAW_BAND[1])).toBeGreaterThan(0.002);
    expect(await regionDisp(page, SHOULDER_BAND[0], SHOULDER_BAND[1])).toBeGreaterThan(0.002);
    const captureAfterReload = await captureCanonical(page, 'step18-after-reload');
    // PIXEL EVIDENCE: restored state renders identically to the pre-reload state.
    const diffReload = await diffPng(page, captureAltBack, captureAfterReload);
    expect(diffReload.changedRatio).toBeLessThan(0.0005);
    (evidence.diffs as Record<string, unknown>).beforeReload_vs_afterReload = diffReload;
    await shot(page, 'step18-restored-after-reload');

    // ---------- STEP 19: Export GLB + independent reimport validation ----------
    const [glbDl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-export-glb').click()
    ]);
    expect(glbDl.suggestedFilename()).toContain('.glb');
    const glbPath = await glbDl.path();
    expect(fs.statSync(glbPath!).size).toBeGreaterThan(10_000);
    fs.copyFileSync(glbPath!, path.join(ART, 'journey-export.glb'));
    await expect(page.locator('.modal-card')).toContainText('VERIFIED PASS');
    await shot(page, 'step19-export-modal');

    // INDEPENDENT validation of the exported bytes (structural GLB auditor + rig-preservation diff).
    const reports = await page.evaluate(() => {
      const app = (window as unknown as {
        __DEX_SCULPT__: {
          session: {
            lastExportResult: {
              validation: {
                validGlb2: boolean; byteLength: number; nodeCount: number; meshCount: number;
                materialCount: number; textureCount: number; skinCount: number; animationCount: number;
                totalVertices: number; totalTriangles: number; errors: string[]; warnings: string[];
                primitives: Array<{
                  meshName: string; vertexCount: number; indexCount: number;
                  hasPosition: boolean; hasNormal: boolean; hasUV: boolean; hasJoints: boolean;
                  hasWeights: boolean; weightsNormalized: boolean; morphTargetCount: number;
                }>;
              };
            } | null;
            lastExportDiff: {
              passed: boolean; failures: string[];
              boneCountEqual: boolean; boneNamesEqual: boolean; boneHierarchyEqual: boolean; inverseBindMatricesMaxDiff: number;
              jointsExactMatch: boolean; weightsMaxDiff: number; uvMaxDiff: number;
              morphTargetsEqual: boolean; morphDeltasMaxDiff: number;
              animationCountEqual: boolean; animationNamesEqual: boolean;
              materialCountEqual: boolean; vertexCountEqual: boolean; triangleCountEqual: boolean;
              sculptMaxPositionDelta: number;
            } | null;
          };
        };
      }).__DEX_SCULPT__;
      return { validation: app.session.lastExportResult!.validation, diff: app.session.lastExportDiff! };
    });
    expect(reports.validation.validGlb2).toBe(true);
    expect(reports.validation.skinCount).toBe(1);
    expect(reports.validation.animationCount).toBe(3);
    expect(reports.validation.primitives[0].morphTargetCount).toBe(4);
    expect(reports.validation.primitives[0].hasJoints).toBe(true);
    expect(reports.validation.primitives[0].hasWeights).toBe(true);
    expect(reports.validation.primitives[0].hasUV).toBe(true);
    // Independent reimport comparison: skeleton, morphs, animations and attributes all survive.
    expect(reports.diff.passed).toBe(true);
    expect(reports.diff.failures).toEqual([]);
    expect(reports.diff.boneCountEqual).toBe(true);
    expect(reports.diff.boneNamesEqual).toBe(true);
    expect(reports.diff.boneHierarchyEqual).toBe(true);
    expect(reports.diff.inverseBindMatricesMaxDiff).toBeLessThan(1e-6);
    expect(reports.diff.jointsExactMatch).toBe(true);
    expect(reports.diff.weightsMaxDiff).toBe(0);
    expect(reports.diff.uvMaxDiff).toBe(0);
    expect(reports.diff.morphTargetsEqual).toBe(true);
    expect(reports.diff.morphDeltasMaxDiff).toBe(0);
    expect(reports.diff.animationCountEqual).toBe(true);
    expect(reports.diff.animationNamesEqual).toBe(true);
    expect(reports.diff.materialCountEqual).toBe(true);
    expect(reports.diff.vertexCountEqual).toBe(true);
    expect(reports.diff.triangleCountEqual).toBe(true);
    expect(reports.diff.sculptMaxPositionDelta).toBeGreaterThan(0); // sculpt geometry survived the round-trip
    // Keep committed evidence bounded: the full validator includes large typed arrays
    // (positions, joints, weights, UVs, morph data), which are already recoverable by
    // rerunning this workflow and need not be duplicated into the JSON artifact.
    (evidence as Record<string, unknown>).glbRoundTrip = {
      validation: {
        validGlb2: reports.validation.validGlb2,
        byteLength: reports.validation.byteLength,
        nodeCount: reports.validation.nodeCount,
        meshCount: reports.validation.meshCount,
        materialCount: reports.validation.materialCount,
        textureCount: reports.validation.textureCount,
        skinCount: reports.validation.skinCount,
        animationCount: reports.validation.animationCount,
        totalVertices: reports.validation.totalVertices,
        totalTriangles: reports.validation.totalTriangles,
        primitives: reports.validation.primitives.map(p => ({
          meshName: p.meshName,
          vertexCount: p.vertexCount,
          indexCount: p.indexCount,
          hasPosition: p.hasPosition,
          hasNormal: p.hasNormal,
          hasUV: p.hasUV,
          hasJoints: p.hasJoints,
          hasWeights: p.hasWeights,
          weightsNormalized: p.weightsNormalized,
          morphTargetCount: p.morphTargetCount
        })),
        errors: reports.validation.errors,
        warnings: reports.validation.warnings
      },
      rigPreservation: reports.diff
    };

    // Re-import the exported GLB into the studio (real verify flow).
    await page.getByTestId('btn-verify-reimport').click();
    await page.waitForFunction(() => {
      const st = (window as unknown as { __DEX_SCULPT__: { session: { getStatus(): { sourceFileName: string; boneCount: number } } } }).__DEX_SCULPT__.session.getStatus();
      return st.sourceFileName.includes('_reimported.glb') && st.boneCount === 20;
    });
    const reimportedStatus = await page.evaluate(() => {
      const app = (window as unknown as { __DEX_SCULPT__: { session: { getStatus(): { isRigged: boolean; boneCount: number; morphCount: number; clipCount: number } } } }).__DEX_SCULPT__;
      return app.session.getStatus();
    });
    expect(reimportedStatus.isRigged).toBe(true);
    expect(reimportedStatus.boneCount).toBe(20);
    expect(reimportedStatus.morphCount).toBe(4);
    expect(reimportedStatus.clipCount).toBe(3);

    // ---------- STEP 20: Play an animation on the reimported model ----------
    await page.keyboard.press('Escape');
    await page.locator('.tab-btn[data-tab="rig"]').click();
    await page.getByTestId('select-animation-clip').selectOption('Walk_Cycle');
    await page.getByTestId('btn-anim-play').click();
    await page.waitForTimeout(400);
    await page.getByTestId('btn-anim-play').click();
    const animTime = await page.evaluate(() => (window as unknown as { __DEX_SCULPT__: { session: { currentTime: number } } }).__DEX_SCULPT__.session.currentTime);
    expect(animTime).toBeGreaterThan(0.05);
    await shot(page, 'step20-animation-playing');

    const evidenceJson = JSON.stringify(evidence, null, 2);
    expect(Buffer.byteLength(evidenceJson)).toBeLessThan(64 * 1024);
    fs.writeFileSync(path.join(ART, 'pixel-evidence.json'), evidenceJson);
    expect(errors).toEqual([]);
  });

  test('negative: malformed recipe and corrupted GLB leave the loaded character intact', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await page.waitForFunction(() => {
      const app = (window as unknown as { __DEX_SCULPT__?: { session: { root: unknown } } }).__DEX_SCULPT__;
      return !!app?.session?.root;
    });

    // Malformed recipe (valid shape, impossible vertex indices) -> rejected, character intact.
    const badRecipe = {
      schemaVersion: 'dexsculpt.recipe.v1',
      editorVersion: '0.1.0',
      projectId: 'bad-1',
      title: 'Bad Recipe',
      createdAt: '',
      updatedAt: '',
      source: {
        kind: 'procedural-sample',
        assetId: null,
        displayName: 'Bad',
        fileName: 'dex_foundry_humanoid.glb',
        sha256: 'a'.repeat(64),
        skeletonFamily: 'unknown',
        licenseId: 'MIT',
        requiresSourceRelink: false
      },
      sculptDeltas: [{ meshName: 'DexFoundry_Humanoid', vertexCount: 4000, indices: [999999], deltas: [1, 2, 3] }],
      morphWeights: {},
      materialOverrides: {},
      attachments: []
    };
    const badPath = path.join(ART, 'bad-recipe.json');
    fs.writeFileSync(badPath, JSON.stringify(badRecipe));
    await page.locator('input[accept*="json"]').setInputFiles(badPath);
    await page.waitForTimeout(600);
    // Character survived untouched.
    const statusAfterBadRecipe = await page.evaluate(() => {
      const app = (window as unknown as { __DEX_SCULPT__: { session: { getStatus(): { boneCount: number; modifiedVertices: number } } } }).__DEX_SCULPT__;
      return app.session.getStatus();
    });
    expect(statusAfterBadRecipe.boneCount).toBe(20);

    // Corrupted GLB -> rejected, character intact.
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'corrupted.glb',
      mimeType: 'model/gltf-binary',
      buffer: Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 37) % 251))
    });
    await page.waitForTimeout(600);
    const statusAfterBadGlb = await page.evaluate(() => {
      const app = (window as unknown as { __DEX_SCULPT__: { session: { getStatus(): { boneCount: number } } } }).__DEX_SCULPT__;
      return app.session.getStatus();
    });
    expect(statusAfterBadGlb.boneCount).toBe(20);
    await expect(page.locator('.status-pill')).toContainText('Rigged · 20 bones · 4 morphs · 3 clips');
    await shot(page, 'negative-character-intact');
  });
});
