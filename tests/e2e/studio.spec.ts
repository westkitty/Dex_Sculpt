import { test, expect, type Page } from '@playwright/test';

/**
 * End-to-end coverage of the studio in a real browser.
 *
 * These tests drive the shipped application: a real WebGL2 context, the real
 * pointer pipeline (synthetic PointerEvents on the canvas), the real exporter and
 * the real IndexedDB project store. Nothing here calls internal edit paths
 * directly except the audited `window.__DEXSCULPT` debug surface.
 */

type DebugApi = {
  ready(): boolean;
  state(): {
    mode: string;
    tab: string;
    tool: string;
    playing: boolean;
    clip: string | null;
    time: number,
    compare: boolean;
    dirty: boolean;
    projectName: string;
    status: string;
    history: { undo: boolean; redo: boolean; size: number };
    viewport: { fps: number; calls: number; contextLost: boolean; triangles: number };
  };
  character(): {
    bones: number;
    clips: { name: string; duration: number; tracks: number }[];
    morphNames: string[];
    skinnedMeshes: number;
    vertices: number;
    maskCoverage: number;
  } | null;
  sculptStats(): {
    deltaHash: string;
    baseHash: string;
    positionHash: string;
    skinHash: { joints: string; weights: string } | null;
    movedVertices: number;
    maxDelta: number;
    maskCoverage: number;
  } | null;
  screenPoint(): { x: number; y: number; mesh: string } | null;
  strokeScreen(dx?: number, steps?: number): Promise<{ x: number; y: number } | null>;
  pickAt(x: number, y: number): { mesh: string } | null;
  setMode(mode: string): void;
  setTab(tab: string): void;
  setTool(tool: string): void;
  loadExample(id: string): Promise<void>;
  undo(): void;
  redo(): void;
  compare(on: boolean): void;
  playClip(name: string): void;
  togglePlayback(): void;
  setTime(time: number): void;
  runProbe(): void;
  probe(): { moved: number; clip: string; mesh: string } | null;
  morphTargets(): { mesh: string; meshId: string; target: string; weight: number }[];
  setMorphWeight(meshId: string, target: string, value: number): boolean;
  materialOverrides(): { mesh: string; slot: string; colorHex: string; overridden: boolean }[];
  attachExampleProp(): Promise<{ id: string; name: string; bone: string }[] | null>;
  attachments(): { id: string; name: string; bone: string }[];
  saveProject(): Promise<void>;
  listProjects(): Promise<{ id: string; name: string; sculptGroups: number; hasSource: boolean }[]>;
  openProject(id: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  exportAndVerify(): Promise<{
    bytes: number;
    structuralOk: boolean;
    reimportOk: boolean;
    checks: { id: string; status: string }[];
    reimportChecks: { id: string; status: string }[];
    morphProbe: { target: string; movedVertices: number } | null;
  } | null>;
  catalog(): { assets: unknown[]; sources: unknown[]; families: unknown[] } | null;
  screenPointProjection(): { x: number; y: number } | null;
  fingerSculpts(on?: boolean): boolean;
  boneNames(): string[];
  storageMode(): string;
};

declare global {
  interface Window {
    __DEXSCULPT: DebugApi;
  }
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.__DEXSCULPT?.ready?.() === true, null, { timeout: 180_000 });
  await expect(page.locator('#characterChips')).toContainText('bones');
}

test.describe('DEX//SCULPT studio', () => {
  test('loads the fixture, sculpts, undoes, morphs and verifies an export', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await boot(page);
    const character = await page.evaluate(() => window.__DEXSCULPT.character());
    expect(character).not.toBeNull();
    expect(character!.bones).toBe(20);
    expect(character!.skinnedMeshes).toBeGreaterThan(0);
    expect(character!.clips.length).toBe(3);
    expect(character!.morphNames).toContain('Build_Tall');

    // --- sculpt with the real pointer pipeline ----------------------------
    await page.evaluate(() => window.__DEXSCULPT.setMode('sculpt'));
    await expect(page.locator('#toolDock')).toBeVisible();
    const before = await page.evaluate(() => window.__DEXSCULPT.sculptStats());
    const point = await page.evaluate(() => window.__DEXSCULPT.screenPoint());
    expect(point).not.toBeNull();
    const started = await page.evaluate(() => window.__DEXSCULPT.strokeScreen(30, 6));
    expect(started).not.toBeNull();
    await page.waitForFunction((hash) => window.__DEXSCULPT.sculptStats()?.deltaHash !== hash, before!.deltaHash, { timeout: 60_000 });

    const after = await page.evaluate(() => window.__DEXSCULPT.sculptStats());
    expect(after!.movedVertices).toBeGreaterThan(50);
    expect(after!.maxDelta).toBeGreaterThan(0.001);
    expect(after!.baseHash).toBe(before!.baseHash);
    expect(after!.skinHash).toEqual(before!.skinHash);
    expect((await page.evaluate(() => window.__DEXSCULPT.state())).history.size).toBe(1);

    // --- undo / redo ------------------------------------------------------
    await page.locator('#undoBtn').click();
    await page.waitForFunction((hash) => window.__DEXSCULPT.sculptStats()?.deltaHash === hash, before!.deltaHash, { timeout: 30_000 });
    await page.locator('#redoBtn').click();
    await page.waitForFunction((hash) => window.__DEXSCULPT.sculptStats()?.deltaHash === hash, after!.deltaHash, { timeout: 30_000 });

    // --- before / after compare ------------------------------------------
    await page.evaluate(() => window.__DEXSCULPT.compare(true));
    expect(await page.evaluate(() => window.__DEXSCULPT.state().compare)).toBe(true);
    await page.evaluate(() => window.__DEXSCULPT.compare(false));

    // --- morph slider -----------------------------------------------------
    await page.evaluate(() => window.__DEXSCULPT.setTab('appearance'));
    const meshId = await page.evaluate(() => window.__DEXSCULPT.morphTargets()[0].meshId);
    const changed = await page.evaluate((id) => window.__DEXSCULPT.setMorphWeight(id, 'Build_Tall', 0.7), meshId);
    expect(changed).toBe(true);
    const morph = await page.evaluate(() => window.__DEXSCULPT.morphTargets().find((entry) => entry.target === 'Build_Tall'));
    expect(morph!.weight).toBeCloseTo(0.7, 3);

    // --- in-editor skinning probe ----------------------------------------
    await page.evaluate(() => window.__DEXSCULPT.runProbe());
    const probe = await page.evaluate(() => window.__DEXSCULPT.probe());
    expect(probe).not.toBeNull();
    expect(probe!.moved).toBeGreaterThan(0.004);

    // --- every panel renders ---------------------------------------------
    for (const tab of ['appearance', 'rig', 'animate', 'attach', 'project']) {
      await page.evaluate((name) => window.__DEXSCULPT.setTab(name), tab);
      await expect(page.locator('#inspectorBody')).not.toBeEmpty();
    }
    await expect(page.locator('#inspectorBody')).toContainText('Export GLB + verify');

    // --- rig tab highlights bones ----------------------------------------
    await page.evaluate(() => window.__DEXSCULPT.setTab('rig'));
    await expect(page.locator('#inspectorBody .tree-item').first()).toBeVisible();
    const boneCount = await page.evaluate(() => window.__DEXSCULPT.boneNames().length);
    expect(boneCount).toBe(20);

    // --- animation playback ----------------------------------------------
    await page.evaluate(() => {
      window.__DEXSCULPT.setTab('animate');
      window.__DEXSCULPT.playClip('Foundry_Wave');
    });
    await page.evaluate(() => window.__DEXSCULPT.setTime(1.1));
    expect(await page.evaluate(() => window.__DEXSCULPT.state().clip)).toBe('Foundry_Wave');

    // --- export + structural validation + re-import -----------------------
    const exported = await page.evaluate(() => window.__DEXSCULPT.exportAndVerify());
    expect(exported).not.toBeNull();
    expect(exported!.bytes).toBeGreaterThan(500_000);
    expect(exported!.structuralOk).toBe(true);
    expect(exported!.reimportOk).toBe(true);
    expect(exported!.checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(exported!.reimportChecks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(exported!.morphProbe?.movedVertices ?? 0).toBeGreaterThan(0);

    // The report dialog lists the checks and closes again.
    await expect(page.locator('#modalRoot .modal')).toBeVisible();
    await expect(page.locator('#modalRoot')).toContainText('Export verification');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('#modalRoot')).toBeHidden();

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('saves a project and reopens it after a reload', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__DEXSCULPT.setMode('sculpt'));
    const before = await page.evaluate(() => window.__DEXSCULPT.sculptStats());
    await page.evaluate(() => window.__DEXSCULPT.strokeScreen(26, 5));
    await page.waitForFunction((hash) => window.__DEXSCULPT.sculptStats()?.deltaHash !== hash, before!.deltaHash, { timeout: 60_000 });
    await page.evaluate(() => window.__DEXSCULPT.strokeScreen(34, 5));
    const sculpted = await page.evaluate(() => window.__DEXSCULPT.sculptStats());
    expect(sculpted!.movedVertices).toBeGreaterThan(50);

    await page.evaluate(() => window.__DEXSCULPT.saveProject());
    const projects = await page.evaluate(() => window.__DEXSCULPT.listProjects());
    expect(projects.length).toBeGreaterThan(0);
    const project = projects[0];
    expect(project.sculptGroups).toBeGreaterThan(0);

    await page.reload();
    await page.waitForFunction(() => window.__DEXSCULPT?.ready?.() === true, null, { timeout: 180_000 });
    const fresh = await page.evaluate(() => window.__DEXSCULPT.sculptStats());
    expect(fresh!.movedVertices).toBe(0);

    await page.evaluate((id) => window.__DEXSCULPT.openProject(id), project.id);
    await page.waitForFunction(() => (window.__DEXSCULPT.sculptStats()?.movedVertices ?? 0) > 0, null, { timeout: 120_000 });
    const reopened = await page.evaluate(() => window.__DEXSCULPT.sculptStats());
    expect(reopened!.movedVertices).toBeGreaterThan(50);
    // Recipes store deltas as int16 with a per-channel scale, so reopening is
    // deliberately near-lossless rather than byte-identical.
    expect(Math.abs(reopened!.maxDelta - sculpted!.maxDelta)).toBeLessThan(1e-3);
    expect(Math.abs(reopened!.movedVertices - sculpted!.movedVertices)).toBeLessThan(60);

    // Clean up so repeated runs start from an empty store.
    await page.evaluate((id) => window.__DEXSCULPT.deleteProject(id), project.id);
    expect(await page.evaluate(() => window.__DEXSCULPT.listProjects())).toEqual([]);
  });

  test('degrades honestly for an unrigged mesh and attaches a prop', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__DEXSCULPT.loadExample('foundry-bust'));
    await page.waitForFunction(() => window.__DEXSCULPT.state().projectName === 'Foundry Static Bust', null, { timeout: 120_000 });
    const bust = await page.evaluate(() => window.__DEXSCULPT.character());
    expect(bust!.bones).toBe(0);
    expect(bust!.clips.length).toBe(0);

    await page.evaluate(() => window.__DEXSCULPT.setTab('rig'));
    await expect(page.locator('#inspectorBody')).toContainText('No skeleton in this file');
    await page.evaluate(() => window.__DEXSCULPT.setTab('animate'));
    await expect(page.locator('#inspectorBody')).toContainText('No animation clips');

    // Sculpting still works on a static mesh.
    await page.evaluate(() => window.__DEXSCULPT.setMode('sculpt'));
    const before = await page.evaluate(() => window.__DEXSCULPT.sculptStats());
    await page.evaluate(() => window.__DEXSCULPT.strokeScreen(24, 5));
    await page.waitForFunction((hash) => window.__DEXSCULPT.sculptStats()?.deltaHash !== hash, before!.deltaHash, { timeout: 60_000 });

    // Back to the rigged fixture and attach a prop to a bone.
    await page.evaluate(() => window.__DEXSCULPT.loadExample('foundry-humanoid'));
    await page.waitForFunction(() => window.__DEXSCULPT.character()?.bones === 20, null, { timeout: 120_000 });
    const attachments = await page.evaluate(() => window.__DEXSCULPT.attachExampleProp());
    expect(attachments).not.toBeNull();
    expect(attachments!.length).toBe(1);
    await page.evaluate(() => window.__DEXSCULPT.setTab('attach'));
    await expect(page.locator('#inspectorBody')).toContainText(/visor/i);
  });

  test('keeps library records metadata-only and renders the catalog', async ({ page }) => {
    await boot(page);
    const catalog = await page.evaluate(() => window.__DEXSCULPT.catalog());
    expect(catalog).not.toBeNull();
    expect(catalog!.assets.length).toBeGreaterThan(500);
    await page.locator('#librarySearch').fill('Female Adult 01');
    await expect(page.locator('#libraryBody .asset').first()).toContainText('Female Adult 01');
    await expect(page.locator('.rail__note')).toContainText('metadata only');
    await page.locator('#librarySearch').fill('');
    await page.locator('#libraryFilters [data-filter="metadata"]').click();
    await expect(page.locator('#libraryBody .asset').first()).toBeVisible();
    // Catalog rows never load a model on their own; they open a relink dialog.
    await page.locator('#libraryBody .asset').first().click();
    await expect(page.locator('#modalRoot .modal')).toContainText('metadata only');
    await page.keyboard.press('Escape');
    await expect(page.locator('#modalRoot')).toBeHidden();
  });
});
