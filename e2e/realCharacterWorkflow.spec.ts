import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

const ASSET = path.resolve('tests/fixtures/downloads/CesiumMan.glb');
const ART = path.join(process.cwd(), 'e2e-artifacts');
fs.mkdirSync(ART, { recursive: true });

async function capture(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__DEX_SCULPT__.session.captureCanonicalPng());
}

async function screenPoint(page: Page, local: [number, number, number]): Promise<{ x: number; y: number }> {
  return page.evaluate((p) => {
    const app = (window as any).__DEX_SCULPT__;
    const target = app.session.sculptTargets[0];
    target.object.updateMatrixWorld(true);
    const e = target.object.matrixWorld.elements;
    const [x, y, z] = p;
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const cam = app.viewport.camera;
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const v = cam.matrixWorldInverse.elements, m = cam.projectionMatrix.elements;
    const vx = v[0] * wx + v[4] * wy + v[8] * wz + v[12];
    const vy = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
    const vz = v[2] * wx + v[6] * wy + v[10] * wz + v[14];
    const cx = m[0] * vx + m[4] * vy + m[8] * vz + m[12];
    const cy = m[1] * vx + m[5] * vy + m[9] * vz + m[13];
    const cw = m[3] * vx + m[7] * vy + m[11] * vz + m[15];
    const rect = app.viewport.renderer.domElement.getBoundingClientRect();
    return { x: rect.x + ((cx / cw + 1) / 2) * rect.width, y: rect.y + ((1 - cy / cw) / 2) * rect.height };
  }, local);
}

async function sculptPoint(page: Page, point: [number, number, number]): Promise<void> {
  const p = await screenPoint(page, point);
  await page.mouse.move(p.x - 8, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 10, p.y - 5, { steps: 6 });
  await page.mouse.move(p.x, p.y + 5, { steps: 4 });
  await page.mouse.up();
}

async function surfacePoint(page: Page, fraction: number): Promise<{ point: [number, number, number]; extent: number }> {
  return page.evaluate((f) => {
    const t = (window as any).__DEX_SCULPT__.session.sculptTargets[0];
    const p = t.geometry.getAttribute('position');
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.count; i++) for (let a = 0; a < 3; a++) {
      const v = p.getComponent(i, a); min[a] = Math.min(min[a], v); max[a] = Math.max(max[a], v);
    }
    const sizes = max.map((v, a) => v - min[a]);
    const axis = sizes.indexOf(Math.max(...sizes));
    const extent = sizes[axis];
    const wanted = min[axis] + extent * f;
    const transverse = [0, 1, 2].filter(a => a !== axis);
    const mid = min.map((v, a) => (v + max[a]) / 2);
    let nearest = Infinity;
    for (let i = 0; i < p.count; i++) nearest = Math.min(nearest, Math.abs(p.getComponent(i, axis) - wanted));
    const band = Math.max(nearest + extent * 0.025, extent * 0.03);
    let best = -Infinity, point: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < p.count; i++) {
      const offset = Math.abs(p.getComponent(i, axis) - wanted);
      if (offset > band) continue;
      const radial = Math.hypot(p.getComponent(i, transverse[0]) - mid[transverse[0]], p.getComponent(i, transverse[1]) - mid[transverse[1]]);
      const score = radial - offset * 4;
      if (score > best) { best = score; point = [p.getX(i), p.getY(i), p.getZ(i)]; }
    }
    return { point, extent };
  }, fraction);
}

async function regionDelta(page: Page, center: [number, number, number], radius: number): Promise<number> {
  return page.evaluate(([c, r]) => {
    const t = (window as any).__DEX_SCULPT__.session.sculptTargets[0];
    const p = t.geometry.getAttribute('position').array as Float32Array;
    const src = t.snapshot.sourcePos as Float32Array;
    let maxD = 0;
    for (let i = 0; i < p.length / 3; i++) {
      const x = src[i * 3] - c[0], y = src[i * 3 + 1] - c[1], z = src[i * 3 + 2] - c[2];
      if (Math.hypot(x, y, z) > r) continue;
      maxD = Math.max(maxD, Math.hypot(p[i * 3] - src[i * 3], p[i * 3 + 1] - src[i * 3 + 1], p[i * 3 + 2] - src[i * 3 + 2]));
    }
    return maxD;
  }, [center, radius] as const);
}

function maxArrayDiff(a: number[], b: number[]): number {
  if (a.length !== b.length) return Infinity;
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

async function pixelDiff(page: Page, a: string, b: string): Promise<{ changedRatio: number; maxChannelDelta: number }> {
  return page.evaluate(([x, y]) => (window as any).__DEX_SCULPT__.session.diffPngDataUrls(x, y), [a, b]);
}

async function attributeSnapshot(page: Page) {
  return page.evaluate(() => {
    const t = (window as any).__DEX_SCULPT__.session.sculptTargets[0];
    return {
      joints: Array.from(t.geometry.getAttribute('skinIndex').array as ArrayLike<number>),
      weights: Array.from(t.geometry.getAttribute('skinWeight').array as ArrayLike<number>),
      uv: Array.from(t.geometry.getAttribute('uv').array as ArrayLike<number>),
      inverseBindMatrices: Array.from(t.object.skeleton.boneInverses.flatMap((m: any) => Array.from(m.elements))),
      boneNames: t.object.skeleton.bones.map((b: any) => b.name),
      boneParents: t.object.skeleton.bones.map((b: any) => b.parent?.name ?? null),
      hierarchy: (() => { const rows: string[] = []; t.object.traverse((o: any) => rows.push(`${o.type}:${o.name}:${o.parent?.name ?? ''}`)); return rows; })(),
      materials: (Array.isArray(t.object.material) ? t.object.material : [t.object.material]).map((m: any) => ({ name: m.name, type: m.type, color: m.color?.getHexString(), metalness: m.metalness, roughness: m.roughness, opacity: m.opacity, transparent: m.transparent, map: Boolean(m.map), normalMap: Boolean(m.normalMap) })),
      morphAttributes: Object.fromEntries(Object.entries(t.geometry.morphAttributes).map(([k, values]: [string, any]) => [k, values.map((v: any) => ({ name: v.name, count: v.count, itemSize: v.itemSize }))])),
      animationNames: (window as any).__DEX_SCULPT__.session.animations.map((a: any) => a.name)
    };
  });
}

test('real Cesium Man browser authoring, persistence, GLB validation, and animation deformation', async ({ page }) => {
  test.setTimeout(300_000);
  expect(fs.existsSync(ASSET), 'run node scripts/acquire-real-character.mjs before this browser test').toBe(true);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const sourceValidation = JSON.parse(execFileSync('node', ['scripts/validate-real-character.mjs', ASSET], { encoding: 'utf8' }));
  expect(sourceValidation.numErrors).toBe(0);

  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as any).__DEX_SCULPT__?.session?.root));
  const beforeImport = await capture(page);
  await page.getByRole('button', { name: 'Import GLB', exact: true }).click();
  await page.locator('input[type="file"]').first().setInputFiles(ASSET);
  await page.waitForFunction(() => (window as any).__DEX_SCULPT__?.session?.sourceFileName === 'CesiumMan.glb');
  await expect(page.locator('.status-pill')).toContainText('19 bones');
  const initialStatus = await page.evaluate(() => {
    const s = (window as any).__DEX_SCULPT__.session;
    return { file: s.sourceFileName, sha256: s.sourceSha256, boneCount: s.primarySkeleton?.bones.length, clips: s.animations.length,
      meshCount: s.sculptTargets.length, vertices: s.sculptTargets.reduce((n: number, t: any) => n + t.snapshot.renderVertexCount, 0),
      triangles: s.sculptTargets.reduce((n: number, t: any) => n + t.snapshot.triangleCount, 0), morphs: s.morphs.length };
  });
  expect(initialStatus.file).toBe('CesiumMan.glb');
  expect(initialStatus.sha256).toBe(createHash('sha256').update(fs.readFileSync(ASSET)).digest('hex'));
  expect(initialStatus.boneCount).toBe(19);
  expect(initialStatus.clips).toBe(1);
  expect(initialStatus.meshCount).toBe(1);
  expect(initialStatus.vertices).toBeGreaterThan(3000);
  expect(initialStatus.triangles).toBeGreaterThan(4000);
  expect(initialStatus.morphs).toBe(0);
  const sourceAttrs = await attributeSnapshot(page);
  const importedPixels = await capture(page);
  const importDiff = await pixelDiff(page, beforeImport, importedPixels);
  expect(importDiff.changedRatio).toBeGreaterThan(0.01);
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(ART, 'real-character-imported.png'), fullPage: true });

  const head = await surfacePoint(page, 0.76);
  const body = await surfacePoint(page, 0.28);
  const radius = head.extent * 0.12;
  await page.locator('.tab-btn[data-tab="layers"]').click();
  await page.getByTestId('btn-add-layer').click();
  let activeLayer = page.locator('.layer-row.active input[type="text"]');
  await activeLayer.fill('Head Study');
  await activeLayer.dispatchEvent('change');
  await sculptPoint(page, head.point);
  expect(await regionDelta(page, head.point, radius * 1.5)).toBeGreaterThan(1e-5);
  const headId = await page.evaluate(() => (window as any).__DEX_SCULPT__.session.activeLayerId);

  await page.getByTestId('btn-add-layer').click();
  activeLayer = page.locator('.layer-row.active input[type="text"]');
  await activeLayer.fill('Body Study');
  await activeLayer.dispatchEvent('change');
  await sculptPoint(page, body.point);
  expect(await regionDelta(page, body.point, radius * 1.5)).toBeGreaterThan(1e-5);

  await page.getByTestId(`btn-layer-visible/${headId}`).click();
  const hiddenHeadDelta = await regionDelta(page, head.point, radius * 1.5);
  const visibleBodyDelta = await regionDelta(page, body.point, radius * 1.5);
  expect(hiddenHeadDelta).toBeLessThan(1e-6);
  expect(visibleBodyDelta).toBeGreaterThan(1e-5);
  await page.getByTestId(`btn-layer-visible/${headId}`).click();
  const measuredLayerDeltas = { head: await regionDelta(page, head.point, radius * 1.5), body: await regionDelta(page, body.point, radius * 1.5) };
  expect(measuredLayerDeltas.head).toBeGreaterThan(1e-5);
  expect(measuredLayerDeltas.body).toBeGreaterThan(1e-5);
  await page.screenshot({ path: path.join(ART, 'real-character-two-layers.png'), fullPage: true });

  const variantA = await page.evaluate(() => (window as any).__DEX_SCULPT__.session.dna.activeId);
  await page.locator('.tab-btn[data-tab="variants"]').click();
  const variantAName = page.locator('.variant-row input[type="text"]').first();
  await variantAName.fill('Variant A');
  await variantAName.dispatchEvent('change');
  await page.getByTestId(`btn-variant-duplicate/${variantA}`).click();
  const variantB = await page.evaluate(() => (window as any).__DEX_SCULPT__.session.dna.activeId);
  await page.getByTestId(`variant-name/${variantB}`).fill('Variant B');
  await page.getByTestId(`variant-name/${variantB}`).dispatchEvent('change');
  await page.getByTestId(`btn-variant-switch/${variantB}`).click();
  await page.locator('.tab-btn[data-tab="layers"]').click();
  await page.getByTestId('btn-add-layer').click();
  activeLayer = page.locator('.layer-row.active input[type="text"]');
  await activeLayer.fill('Variant B Study');
  await activeLayer.dispatchEvent('change');
  const variantBefore = await page.evaluate(() => Array.from((window as any).__DEX_SCULPT__.session.sculptTargets[0].geometry.getAttribute('position').array as Float32Array));
  await sculptPoint(page, head.point);
  const variantBPositions = await page.evaluate(() => Array.from((window as any).__DEX_SCULPT__.session.sculptTargets[0].geometry.getAttribute('position').array as Float32Array));
  const variantStrokeMaxDelta = Math.max(...variantBPositions.map((v: number, i: number) => Math.abs(v - variantBefore[i])));
  expect(variantStrokeMaxDelta).toBeGreaterThan(1e-5);
  await page.locator('.tab-btn[data-tab="variants"]').click();
  await page.getByTestId(`btn-variant-switch/${variantA}`).click();
  await page.waitForFunction((id) => (window as any).__DEX_SCULPT__.session.dna.activeId === id, variantA);
  const variantAState = await page.evaluate(() => {
    const s = (window as any).__DEX_SCULPT__.session;
    return { name: s.activeVariant.name, layers: s.activeVariant.layers.map((l: any) => l.name), positions: Array.from(s.sculptTargets[0].geometry.getAttribute('position').array as Float32Array) };
  });
  expect(variantAState.name).toBe('Variant A');
  expect(variantAState.layers).toEqual(['Head Study', 'Body Study']);
  expect(variantAState.positions).not.toEqual(variantBPositions);
  await page.getByTestId(`btn-variant-switch/${variantB}`).click();
  await page.waitForFunction((id) => (window as any).__DEX_SCULPT__.session.dna.activeId === id, variantB);

  const [recipeDownload] = await Promise.all([page.waitForEvent('download'), page.getByTestId('btn-save-recipe').click()]);
  const recipePath = await recipeDownload.path();
  const recipe = JSON.parse(fs.readFileSync(recipePath!, 'utf8'));
  expect(recipe.schemaVersion).toBe('dexsculpt.recipe.v2');
  expect(recipe.dna.variants.map((v: any) => v.name).sort()).toEqual(['Variant A', 'Variant B']);
  fs.copyFileSync(recipePath!, path.join(ART, 'real-character-recipe.dexsculpt.json'));
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-testid="status-autosave"]')).toContainText('Saved');
  const beforeReload = await capture(page);
  await page.reload();
  await page.waitForFunction(() => {
    const s = (window as any).__DEX_SCULPT__?.session;
    return s?.sourceFileName === 'CesiumMan.glb' && s?.dna?.variants?.some((v: any) => v.name === 'Variant B');
  });
  const restored = await page.evaluate(() => {
    const s = (window as any).__DEX_SCULPT__.session;
    return { active: s.activeVariant.name, variants: s.dna.variants.map((v: any) => v.name).sort(), layers: s.activeVariant.layers.map((l: any) => l.name) };
  });
  expect(restored.active).toBe('Variant B');
  expect(restored.variants).toEqual(['Variant A', 'Variant B']);
  expect(restored.layers).toEqual(['Head Study', 'Body Study', 'Variant B Study']);
  const afterReload = await capture(page);
  const reloadDiff = await pixelDiff(page, beforeReload, afterReload);
  expect(reloadDiff.changedRatio).toBeLessThan(0.0005);
  await page.screenshot({ path: path.join(ART, 'real-character-restored.png'), fullPage: true });

  const [exportDownload] = await Promise.all([page.waitForEvent('download'), page.getByTestId('btn-export-glb').click()]);
  const exportPath = await exportDownload.path();
  const exportedBytes = fs.readFileSync(exportPath!);
  const exportedArtifact = path.join(ART, 'CesiumMan-edited.glb');
  fs.copyFileSync(exportPath!, exportedArtifact);
  const external = JSON.parse(execFileSync('node', ['scripts/validate-real-character.mjs', exportedArtifact], { encoding: 'utf8' }));
  expect(external.numErrors).toBe(0);
  await expect(page.locator('.modal-card')).toContainText('VERIFIED PASS');
  const internalExport = await page.evaluate(() => {
    const s = (window as any).__DEX_SCULPT__.session;
    return { rig: s.lastExportDiff, result: s.lastExportResult.validation };
  });
  expect(internalExport.rig.passed).toBe(true);
  expect(internalExport.rig.jointsExactMatch).toBe(true);
  expect(internalExport.rig.weightsMaxDiff).toBeLessThan(1e-6);
  expect(internalExport.rig.uvMaxDiff).toBe(0);
  expect(internalExport.rig.inverseBindMatricesMaxDiff).toBeLessThan(1e-6);
  expect(internalExport.rig.boneHierarchyEqual).toBe(true);
  expect(internalExport.rig.morphTargetsEqual).toBe(true);
  expect(internalExport.rig.animationNamesEqual).toBe(true);
  expect(internalExport.rig.materialCountEqual).toBe(true);

  await page.getByTestId('btn-verify-reimport').click();
  await page.waitForFunction(() => (window as any).__DEX_SCULPT__.session.sourceFileName.includes('_reimported.glb'));
  await expect(page.locator('.status-pill')).toContainText('19 bones');
  const preservedAttrs = await attributeSnapshot(page);
  expect(preservedAttrs.joints).toEqual(sourceAttrs.joints);
  expect(maxArrayDiff(preservedAttrs.weights, sourceAttrs.weights)).toBeLessThan(1e-6);
  expect(preservedAttrs.uv).toEqual(sourceAttrs.uv);
  expect(preservedAttrs.boneNames).toEqual(sourceAttrs.boneNames);
  expect(preservedAttrs.boneParents).toEqual(sourceAttrs.boneParents);
  expect(preservedAttrs.hierarchy).toEqual(sourceAttrs.hierarchy);
  expect(preservedAttrs.materials).toEqual(sourceAttrs.materials);
  expect(preservedAttrs.morphAttributes).toEqual(sourceAttrs.morphAttributes);
  expect(preservedAttrs.animationNames).toEqual(sourceAttrs.animationNames);
  await page.locator('.tab-btn[data-tab="rig"]').click();
  const clip = page.getByTestId('select-animation-clip');
  expect(await clip.locator('option').count()).toBe(1);
  const restPixels = `data:image/png;base64,${(await page.locator('#viewport-canvas').screenshot()).toString('base64')}`;
  const restSkinned = await page.evaluate(() => {
    const t = (window as any).__DEX_SCULPT__.session.sculptTargets[0];
    t.object.updateMatrixWorld(true); t.object.skeleton.update();
    const pos = t.geometry.getAttribute('position'); const out: number[][] = [];
    for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 96))) {
      const p = t.object.position.clone().set(pos.getX(i), pos.getY(i), pos.getZ(i));
      t.object.applyBoneTransform(i, p); out.push(p.toArray());
    }
    return out;
  });
  await page.getByTestId('btn-anim-play').click();
  await page.waitForFunction(() => (window as any).__DEX_SCULPT__.session.currentTime > 0.25);
  const animatedSkinned = await page.evaluate(() => {
    const t = (window as any).__DEX_SCULPT__.session.sculptTargets[0];
    t.object.updateMatrixWorld(true); t.object.skeleton.update();
    const pos = t.geometry.getAttribute('position'); const out: number[][] = [];
    for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 96))) {
      const p = t.object.position.clone().set(pos.getX(i), pos.getY(i), pos.getZ(i));
      t.object.applyBoneTransform(i, p); out.push(p.toArray());
    }
    return out;
  });
  let maxSkinnedMotion = 0;
  for (let i = 0; i < restSkinned.length; i++) maxSkinnedMotion = Math.max(maxSkinnedMotion,
    Math.hypot(restSkinned[i][0] - animatedSkinned[i][0], restSkinned[i][1] - animatedSkinned[i][1], restSkinned[i][2] - animatedSkinned[i][2]));
  expect(maxSkinnedMotion).toBeGreaterThan(0.01);
  await page.waitForTimeout(150);
  const animatedPixels = `data:image/png;base64,${(await page.locator('#viewport-canvas').screenshot()).toString('base64')}`;
  const animationDiff = await pixelDiff(page, restPixels, animatedPixels);
  expect(animationDiff.changedRatio).toBeGreaterThan(0.0001);
  fs.writeFileSync(path.join(ART, 'real-character-animation-rest.png'), Buffer.from(restPixels.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(ART, 'real-character-animation-playing.png'), Buffer.from(animatedPixels.split(',')[1], 'base64'));
  await page.screenshot({ path: path.join(ART, 'real-character-animation.png'), fullPage: true });

  const evidence = {
    asset: { name: 'Cesium Man', sourceCommit: 'f0920f5b32d172a30efe3f9257e965918831e6ea',
      sourceUrl: 'https://github.com/KhronosGroup/glTF-Sample-Assets/blob/f0920f5b32d172a30efe3f9257e965918831e6ea/Models/CesiumMan/glTF-Binary/CesiumMan.glb',
      sha256: createHash('sha256').update(fs.readFileSync(ASSET)).digest('hex'), bytes: fs.statSync(ASSET).size,
      author: 'Cesium (2017)', license: 'CC-BY-4.0 for model; Cesium logo/trademark excluded' },
    imported: initialStatus,
    layerDelta: { ...measuredLayerDeltas, hiddenHeadDelta: hiddenHeadDelta, visibleBodyDelta: visibleBodyDelta },
    variants: { names: restored.variants, variantAMaxPositionDifference: maxArrayDiff(variantAState.positions, variantBPositions), variantBStrokeMaxDelta: variantStrokeMaxDelta },
    reloadPixelDiff: reloadDiff,
    externalValidator: {
      source: { errors: sourceValidation.numErrors, warnings: sourceValidation.numWarnings, messages: sourceValidation.messages.map((m: any) => m.code) },
      export: { errors: external.numErrors, warnings: external.numWarnings, infos: external.numInfos, messages: external.messages.map((m: any) => m.code) }
    },
    protectedAttributesAfterReimport: {
      jointIndicesExact: preservedAttrs.joints.every((v: number, i: number) => v === sourceAttrs.joints[i]),
      skinWeightMaxDiff: maxArrayDiff(preservedAttrs.weights, sourceAttrs.weights),
      uvExact: preservedAttrs.uv.every((v: number, i: number) => v === sourceAttrs.uv[i]),
      boneNamesAndHierarchyExact: JSON.stringify([preservedAttrs.boneNames, preservedAttrs.boneParents, preservedAttrs.hierarchy]) === JSON.stringify([sourceAttrs.boneNames, sourceAttrs.boneParents, sourceAttrs.hierarchy]),
      materialPropertiesExact: JSON.stringify(preservedAttrs.materials) === JSON.stringify(sourceAttrs.materials),
      morphAttributesExact: JSON.stringify(preservedAttrs.morphAttributes) === JSON.stringify(sourceAttrs.morphAttributes),
      animationNamesExact: JSON.stringify(preservedAttrs.animationNames) === JSON.stringify(sourceAttrs.animationNames)
    },
    export: { bytes: exportedBytes.byteLength, internalRigPreserved: internalExport.rig.passed, boneHierarchyEqual: internalExport.rig.boneHierarchyEqual,
      animationNamesEqual: internalExport.rig.animationNamesEqual, materialCountEqual: internalExport.rig.materialCountEqual,
      skinWeightMaxDiff: internalExport.rig.weightsMaxDiff, uvMaxDiff: internalExport.rig.uvMaxDiff,
      inverseBindMatricesMaxDiff: internalExport.rig.inverseBindMatricesMaxDiff, sculptMaxPositionDelta: internalExport.rig.sculptMaxPositionDelta },
    reimportedAnimation: { clip: (await clip.locator('option').first().textContent())?.trim(), maxSkinnedVertexMotion: maxSkinnedMotion, pixelDiff: animationDiff }
  };
  const json = JSON.stringify(evidence, null, 2);
  expect(Buffer.byteLength(json)).toBeLessThan(64 * 1024);
  fs.writeFileSync(path.join(ART, 'real-character-evidence.json'), json);
  expect(errors).toEqual([]);
});
