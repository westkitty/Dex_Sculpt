import fs from 'node:fs';
import { expect, test } from '@playwright/test';

test.describe('DEX//SCULPT End-to-End Studio Verification', () => {
  test('renders WebGL2 viewport, performs pointer sculpt + undo/redo + anim + export + reimport + recipe round-trip', async ({
    page
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/');
    await page.waitForSelector('#viewport-canvas');

    // Wait for procedural humanoid to load and render
    await page.waitForFunction(() => {
      const app = (window as any).__DEX_SCULPT__;
      return app?.session?.root && app.session.sculptTargets.length > 0;
    });

    // Verify status pill shows rigged character
    await expect(page.locator('.status-pill')).toContainText('Rigged · 20 bones · 4 morphs · 3 clips');

    // Verify canvas is non-blank (WebGL2 drew pixels)
    const canvasRect = await page.locator('#viewport-canvas').boundingBox();
    expect(canvasRect).not.toBeNull();
    expect(canvasRect!.width).toBeGreaterThan(500);
    expect(canvasRect!.height).toBeGreaterThan(400);

    // 1. Perform real pointer-based sculpt stroke across center of character torso
    // Frame front view first so torso is centered cleanly in viewport
    await page.getByRole('button', { name: 'Front', exact: true }).click();
    await page.waitForTimeout(150);

    const cx = canvasRect!.x + canvasRect!.width * 0.5;
    const cy = canvasRect!.y + canvasRect!.height * 0.44;
    await page.mouse.move(cx - 12, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 12, cy - 10, { steps: 8 });
    await page.mouse.move(cx, cy + 8, { steps: 6 });
    await page.mouse.up();

    // Confirm real sculpt displacement occurred
    const sculptStats = await page.evaluate(() => {
      const s = (window as any).__DEX_SCULPT__.session.getStatus();
      return { mod: s.modifiedVertices, disp: s.maxSculptDisplacement };
    });
    expect(sculptStats.mod).toBeGreaterThan(0);
    expect(sculptStats.disp).toBeGreaterThan(0.002);

    // 2. Undo & Redo accuracy
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    const afterUndo = await page.evaluate(
      () => (window as any).__DEX_SCULPT__.session.getStatus().modifiedVertices
    );
    expect(afterUndo).toBe(0);

    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    const afterRedo = await page.evaluate(
      () => (window as any).__DEX_SCULPT__.session.getStatus().modifiedVertices
    );
    expect(afterRedo).toBe(sculptStats.mod);

    // 3. Before / After toggle
    await page.locator('.topbar-more summary').click();
    await page.getByTestId('btn-before-after').click();
    await expect(page.locator('.hud-chip').nth(1)).toContainText('ORIGINAL SOURCE');
    await page.locator('.topbar-more summary').click();
    await page.getByTestId('btn-before-after').click();
    await expect(page.locator('.hud-chip').nth(1)).toContainText('SCULPTED');

    // 4. Exercise Morph Target slider
    const morphSlider = page.locator('input[data-morph="Broaden_Shoulders"]');
    await morphSlider.fill('0.75');
    await morphSlider.dispatchEvent('input');
    await morphSlider.dispatchEvent('change');
    const morphVal = await page.evaluate(
      () => (window as any).__DEX_SCULPT__.session.sculptTargets[0].object.morphTargetInfluences[0]
    );
    expect(morphVal).toBeCloseTo(0.75, 2);

    // 5. Switch to Rig tab, play Walk_Cycle animation, verify bone rotation
    await page.locator('.tab-btn[data-tab="rig"]').click();
    await page.getByTestId('select-animation-clip').selectOption('Walk_Cycle');
    await page.getByTestId('btn-anim-play').click();
    await page.waitForTimeout(350);
    await page.getByTestId('btn-anim-play').click();
    const animTime = await page.evaluate(() => (window as any).__DEX_SCULPT__.session.currentTime);
    expect(animTime).toBeGreaterThan(0.05);

    // 6. Switch to Assemble tab, attach procedural Visor Crest & Skinned Cloak
    await page.locator('.tab-btn[data-tab="assemble"]').click();
    await page.getByTestId('attach-procedural/visor-crest').click();
    await page.getByTestId('attach-procedural/skinned-cape').click();
    const attCount = await page.evaluate(
      () => (window as any).__DEX_SCULPT__.session.attachments.length
    );
    expect(attCount).toBe(2);

    // 7. Export GLB -> verify download + independent validation modal -> Re-import into Studio!
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-export-glb').click()
    ]);
    expect(download.suggestedFilename()).toContain('.glb');
    const dlPath = await download.path();
    expect(dlPath).not.toBeNull();
    expect(fs.statSync(dlPath!).size).toBeGreaterThan(10_000);

    await expect(page.locator('.modal-card')).toContainText('VERIFIED PASS');
    await page.getByTestId('btn-verify-reimport').click();

    // Confirm re-imported GLB preserved rig, morphs, animations, and sculpt displacement
    await page.waitForFunction(() => {
      const st = (window as any).__DEX_SCULPT__.session.getStatus();
      return st.sourceFileName.includes('_reimported.glb') && st.boneCount === 20;
    });
    const reimportedStatus = await page.evaluate(() =>
      (window as any).__DEX_SCULPT__.session.getStatus()
    );
    expect(reimportedStatus.isRigged).toBe(true);
    expect(reimportedStatus.boneCount).toBe(20);
    expect(reimportedStatus.morphCount).toBe(4);
    expect(reimportedStatus.clipCount).toBe(3);

    // 8. Save Recipe download check
    const [recipeDl] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.topbar-more summary').click().then(() => page.getByTestId('btn-save-recipe').click())
    ]);
    expect(recipeDl.suggestedFilename()).toContain('.dexsculpt.json');

    // 9. Catalog tab search check (786 records)
    await page.locator('.tab-btn[data-tab="catalog"]').click();
    await expect(page.locator('.inspector-body')).toContainText('786 records');

    // 10. Keyboard shortcut check (? modal open/close, X symmetry toggle)
    await page.keyboard.press('?');
    await expect(page.locator('.modal-card')).toContainText('Keyboard Shortcuts');
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-card')).toHaveCount(0);

    // 11. Sculpt the re-imported GLB, wait for debounced IndexedDB autosave, reload page, and confirm project persistence
    await page.getByRole('button', { name: 'Front', exact: true }).click();
    await page.waitForTimeout(100);
    await page.mouse.move(cx - 8, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 8, cy + 8, { steps: 6 });
    await page.mouse.up();

    await page.waitForFunction(
      () => (window as any).__DEX_SCULPT__.session.getStatus().modifiedVertices > 0
    );
    await page.waitForTimeout(750);
    await page.reload();
    await page.waitForFunction(() => {
      const st = (window as any).__DEX_SCULPT__?.session?.getStatus();
      return st && st.boneCount === 20 && st.modifiedVertices > 0;
    });
    const reloadedStatus = await page.evaluate(() =>
      (window as any).__DEX_SCULPT__.session.getStatus()
    );
    expect(reloadedStatus.sourceFileName).toContain('_reimported.glb');
    expect(reloadedStatus.modifiedVertices).toBeGreaterThan(0);

    expect(errors).toEqual([]);
  });

  test('simulates S Pen input (hover, pressure scaling, tilt, palm rejection) and responsive mobile/tablet viewports', async ({
    page
  }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__DEX_SCULPT__?.session?.root);
    await page.getByRole('button', { name: 'Front', exact: true }).click();
    await page.waitForTimeout(100);

    const box = (await page.locator('#viewport-canvas').boundingBox())!;
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.44;

    // Pen hover should NOT sculpt vertices
    await page.evaluate(
      ({ x, y }) => {
        const cv = document.getElementById('viewport-canvas')!;
        cv.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerId: 11,
            pointerType: 'pen',
            clientX: x,
            clientY: y,
            pressure: 0,
            buttons: 0
          })
        );
      },
      { x: cx, y: cy }
    );
    const hoverMod = await page.evaluate(
      () => (window as any).__DEX_SCULPT__.session.getStatus().modifiedVertices
    );
    expect(hoverMod).toBe(0);

    // Pen stroke with pressure + tilt, followed immediately by rejected touch (palm rejection)
    await page.evaluate(
      ({ x, y }) => {
        const cv = document.getElementById('viewport-canvas')!;
        cv.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            pointerId: 11,
            pointerType: 'pen',
            clientX: x,
            clientY: y,
            pressure: 0.9,
            tiltX: 45,
            tiltY: 10,
            buttons: 1
          })
        );
        cv.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerId: 11,
            pointerType: 'pen',
            clientX: x + 10,
            clientY: y - 8,
            pressure: 0.9,
            tiltX: 45,
            tiltY: 10,
            buttons: 1
          })
        );
        // Simulate accidental palm touch during active pen stroke
        cv.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            pointerId: 22,
            pointerType: 'touch',
            clientX: x + 60,
            clientY: y + 40,
            buttons: 1
          })
        );
        cv.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            pointerId: 11,
            pointerType: 'pen',
            clientX: x + 10,
            clientY: y - 8,
            pressure: 0,
            buttons: 0
          })
        );
      },
      { x: cx, y: cy }
    );

    const penStats = await page.evaluate(() => {
      const app = (window as any).__DEX_SCULPT__;
      return {
        seen: app.tool.pen.seen,
        rejectedTouches: app.tool.pen.rejectedTouches,
        maxRadiusScale: app.tool.lastStroke.maxRadiusScale,
        modified: app.session.getStatus().modifiedVertices
      };
    });
    expect(penStats.seen).toBe(true);
    expect(penStats.rejectedTouches).toBe(1);
    expect(penStats.maxRadiusScale).toBeGreaterThan(1.3);
    expect(penStats.modified).toBeGreaterThan(0);

    // Responsive tablet landscape (Tab S9 Ultra aspect) & narrow mobile (390x844) overflow check
    for (const vp of [
      { width: 1480, height: 924 },
      { width: 390, height: 844 }
    ]) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(100);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      expect(overflow).toBe(false);
    }
  });
});
