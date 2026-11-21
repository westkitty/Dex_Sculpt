import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// These checks supplement, not replace, the established sculpt/GLB round-trip journeys.
const records = JSON.parse(
  readFileSync(new URL('../src/data/humanoidCatalog.json', import.meta.url), 'utf8')
).records as Array<{ asset_id: string; processed_glb_sha256: string | null }>;

test('studio remains usable at all four required viewport widths', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport-canvas')).toBeVisible();

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId('btn-export-glb')).toBeVisible();

    const dims = await page.evaluate(() => {
      const actions = document.querySelector<HTMLElement>('.topbar-actions')!;
      const exportBtn = document.querySelector<HTMLElement>('[data-testid="btn-export-glb"]')!;
      return {
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        toolbarOverflow: actions.scrollWidth > actions.clientWidth + 1,
        buttonHeight: exportBtn.getBoundingClientRect().height
      };
    });
    expect(dims.documentOverflow, `document overflow at ${width}px`).toBe(false);
    expect(dims.toolbarOverflow, `toolbar overflow at ${width}px`).toBe(false);
    expect(dims.buttonHeight).toBeGreaterThanOrEqual(44);

    const leftRail = page.locator('.left-rail');
    const rightRail = page.locator('.right-inspector');
    if (width <= 1080) {
      await expect(leftRail).toHaveAttribute('inert', '');
      await expect(rightRail).toHaveAttribute('inert', '');
      await page.getByRole('button', { name: 'Tools', exact: true }).click();
      await expect(leftRail).not.toHaveAttribute('inert', '');
      await expect(rightRail).toHaveAttribute('inert', '');
      await page.getByRole('button', { name: 'Tools', exact: true }).click();
      await expect(leftRail).toHaveAttribute('inert', '');
    } else {
      await expect(leftRail).not.toHaveAttribute('inert', '');
      await expect(rightRail).not.toHaveAttribute('inert', '');
    }
  }
});

test('morph slider remains mounted, commits undo history, and dialogs restore focus', async ({ page }) => {
  await page.goto('/');
  const morph = page.locator('input[data-morph="Broaden_Shoulders"]');
  await expect(morph).toBeVisible();
  const before = await morph.inputValue();
  await morph.fill('0.62');
  await morph.dispatchEvent('input');
  await morph.dispatchEvent('change');

  await expect(morph).toBeAttached();
  await expect(morph).toHaveValue('0.62');
  await page.locator('.topbar').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('input[data-morph="Broaden_Shoulders"]')).toHaveValue(before);

  await page.locator('.topbar-more summary').click();
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.topbar-more summary')).toBeFocused();
});

test('A/B comparison only enables for different variants', async ({ page }) => {
  await page.goto('/');
  await page.locator('.tab-btn[data-tab="variants"]').click();
  const compare = page.getByTestId('btn-compare-ab');
  await expect(compare).toBeDisabled();
  await page.getByTestId('btn-new-variant').click();
  await expect(compare).toBeEnabled();
  const a = await page.getByTestId('select-compare-a').inputValue();
  await page.getByTestId('select-compare-b').selectOption(a);
  await expect(compare).toBeDisabled();
});

test('catalog association never replaces the loaded GLB identity with mismatched metadata', async ({ page }) => {
  await page.goto('/');
  const before = await page.evaluate(() => {
    const s = (window as any).__DEX_SCULPT__.session;
    return { sha: s.sourceSha256, linked: s.linkedAssetId, license: s.licenseId, provenance: s.provenanceUrl };
  });
  const candidate = records.find(r => r.processed_glb_sha256 && r.processed_glb_sha256.toLowerCase() !== before.sha.toLowerCase());
  expect(candidate, 'at least one different catalogued source').toBeTruthy();

  const after = await page.evaluate((id: string) => {
    const s = (window as any).__DEX_SCULPT__.session;
    const accepted = s.associateCatalogRecord(id);
    return { accepted: accepted !== null, linked: s.linkedAssetId, license: s.licenseId, provenance: s.provenanceUrl };
  }, candidate!.asset_id);
  expect(after.accepted).toBe(false);
  expect(after.linked).toBe(before.linked);
  expect(after.license).toBe(before.license);
  expect(after.provenance).toBe(before.provenance);
});

test('gallery loads genuine model renders, keeps metadata fallback, and remains responsive', async ({ page }) => {
  await page.goto('/gallery.html');
  await expect(page.locator('#grid .model-card').first()).toBeVisible();
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('#publicCount')).toHaveText('161');
  await expect(page.locator('#availability')).toHaveValue('preview');
  await expect(page.locator('#grid')).not.toHaveClass(/list-only/);

  const front = page.locator('#grid .model-card img').first();
  await expect(front).toBeVisible();
  await expect(front).toHaveAttribute('alt', /Front-view render|Thumbnail of/);
  const src = await front.getAttribute('src');
  expect(src, 'real image URL is present').toBeTruthy();
  const imageResponse = await page.request.get(new URL(src!, page.url()).toString());
  expect(imageResponse.ok()).toBe(true);
  expect(imageResponse.headers()['content-type']).toMatch(/image\/png/);

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const overflowInfo = await page.evaluate(() => ({
      overflowing: document.documentElement.scrollWidth > innerWidth,
      culprits: [...document.querySelectorAll<HTMLElement>('body *')]
        .filter(el => el.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 8)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          className: String(el.className).slice(0, 80),
          right: Math.round(el.getBoundingClientRect().right)
        }))
    }));
    expect(overflowInfo.overflowing,
      `gallery overflow at ${width}px: ${JSON.stringify(overflowInfo.culprits)}`
    ).toBe(false);
  }

  // A newly illustrated Rocketbox model loads its actual stored positive-Z QA render.
  await page.locator('#availability').selectOption('all');
  await page.locator('#source').selectOption('microsoft-rocketbox');
  await expect(page.locator('#grid')).not.toHaveClass(/list-only/);
  const rocket = page.locator('#grid .model-card[data-asset-id="rocketbox/adults/female_adult_01"] img');
  await expect(rocket).toBeVisible();
  const rocketUrl = await rocket.getAttribute('src');
  expect(rocketUrl).toContain('microsoft-rocketbox__female_adult_01__posZ.png');
  const rocketResponse = await page.request.get(new URL(rocketUrl!, page.url()).toString());
  expect(rocketResponse.ok()).toBe(true);
  expect(rocketResponse.headers()['content-type']).toMatch(/image\/png/);

  // A metadata-only collection must still work without pretending to show real models.
  await page.locator('#source').selectOption('kaykit-adventurers');
  await expect(page.locator('#grid .model-card').first()).toBeVisible();
  await expect(page.locator('#grid')).toHaveClass(/list-only/);
  await expect(page.locator('#grid .model-card img')).toHaveCount(0);

  await page.locator('#clear').click();
  await expect(page.locator('#grid')).not.toHaveClass(/list-only/);

  await page.locator('#query').fill('no-model-will-match-this-gauntlet-query');
  await expect(page.locator('#empty')).toBeVisible();
  await page.locator('#clear').click();
  await page.locator('.model-card').first().click();
  await expect(page.locator('#detailDialog')).toBeVisible();
  await expect(page.locator('#studioLink')).toHaveText('Find in Studio Catalogue');
  const close = page.locator('#closeDialog');
  expect(await close.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await close.click();
  await expect(page.locator('#detailDialog')).not.toBeVisible();
});
