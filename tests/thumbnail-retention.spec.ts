import { test, expect } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
import { mkdir, copyFile } from 'node:fs/promises';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const albumId = '30000000-0000-4000-8000-000000000001';
const userId = '30000000-0000-4000-8000-000000000002';
const photoId = (index: number) => `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const ready = { thumbnail: { state: 'succeeded', attempts: 1 }, vision: { state: 'succeeded', attempts: 1 } };
const cards = (page: Page) => page.locator('article.photo-card');
function gate() {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  return { held, release };
}

async function openShared(page: Page, count = 160, configure?: (model: {
  thumbnail: (route: Route, id: string) => Promise<void>;
}) => void) {
  const model: { thumbnails: string[]; originals: string[]; thumbnail: (route: Route, id: string) => Promise<void> } = {
    thumbnails: [] as string[], originals: [] as string[],
    thumbnail: async route => { await route.fulfill({ contentType: 'image/png', body: pixel }); },
  };
  configure?.(model);
  const photos = Array.from({ length: count }, (_, index) => ({
    id: photoId(index), name: `retention-${index + 1}.png`, type: 'image/png', size: pixel.length,
    hash: String(index + 1).padStart(64, '0'), createdAt: count - index,
    contributors: [userId], requestedBy: [], receivedBy: [], importCount: 1, processing: ready,
  }));
  await page.addInitScript(() => {
    localStorage.setItem('phogaem:/phogaem/:preferences', JSON.stringify({ member: 'me', filters: ['all'], columns: 4 }));
  });
  await page.route('**/auth/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/token')
    ? { access_token: 'synthetic-retention-token', expires_in: 600, user_id: userId }
    : { challenge: 'synthetic-retention-challenge' } }));
  await page.route('**/op/phogaem-*/v1*', async route => {
    const url = new URL(route.request().url());
    const operation = url.pathname.split('/')[2];
    if (operation === 'phogaem-albums') await route.fulfill({ json: { userId, albums: [{ id: albumId, title: '썸네일 검증 여행', createdAt: 1 }] } });
    else if (operation === 'phogaem-album-get') await route.fulfill({ json: {
      album: { id: albumId, title: '썸네일 검증 여행', createdAt: 1 }, members: [{ id: userId, name: '나', color: '#c5d6c4' }], photos,
    } });
    else if (operation === 'phogaem-similar-get') await route.fulfill({ json: { groups: [], pending: 0, failed: 0, analyzed: count } });
    else if (operation === 'phogaem-thumbnail-get') {
      const id = url.searchParams.get('photoId')!;
      model.thumbnails.push(id); await model.thumbnail(route, id);
    } else if (operation === 'phogaem-photo-get') {
      model.originals.push(url.searchParams.get('photoId')!);
      await route.fulfill({ contentType: 'image/png', body: pixel });
    } else throw new Error(`Unexpected synthetic operation: ${operation}`);
  });
  await page.goto('./');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await page.getByRole('button', { name: '썸네일 검증 여행', exact: false }).click();
  await expect(cards(page)).toHaveCount(count);
  await expect(page.locator('.photo-grid')).toHaveAttribute('data-columns', '4');
  return model;
}

async function expectOneSelectionCircle(button: Locator) {
  const appearance = await button.evaluate(element => {
    const before = getComputedStyle(element, '::before');
    const after = getComputedStyle(element, '::after');
    const box = element.getBoundingClientRect();
    // Both pseudo-elements used to paint overlapping white disks at dense grid sizes.
    const painted = (style: CSSStyleDeclaration) => !['none', 'normal'].includes(style.content)
      && style.display !== 'none' && style.visibility !== 'hidden'
      && (style.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(style.borderTopWidth) > 0);
    return { circles: [before, after].filter(painted).length, width: box.width, height: box.height };
  });
  expect(appearance.circles).toBe(1);
  expect(appearance.width).toBeGreaterThanOrEqual(44);
  expect(appearance.height).toBeGreaterThanOrEqual(44);
}

test.use({ viewport: { width: 390, height: 844 } });

test('dense mobile grids paint one selection circle and retain a touch-sized selectable control', async ({ page }, testInfo) => {
  await openShared(page, 8);
  const selection = cards(page).first().getByRole('button', { name: 'retention-1.png 선택', exact: true });
  for (const columns of [4, 5, 6]) {
    await expect(page.getByLabel('한 줄 사진 수')).toHaveText(String(columns));
    await expect(selection).toHaveAttribute('aria-pressed', 'false');
    await expectOneSelectionCircle(selection);
    await selection.click();
    await expect(selection).toHaveAttribute('aria-pressed', 'true');
    await expectOneSelectionCircle(selection);
    await page.screenshot({ path: testInfo.outputPath(`selection-${columns}-columns.png`) });
    await selection.click();
    await expect(selection).toHaveAttribute('aria-pressed', 'false');
    if (columns < 6) await page.getByRole('button', { name: '사진 축소', exact: true }).click();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('nearby offscreen thumbnails preload while distant photos and originals stay lazy', async ({ page }) => {
  const model = await openShared(page);
  const positions = await cards(page).evaluateAll(elements => elements.map((element, index) => ({ index, top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom })));
  const nearby = positions.find(value => value.top > 844 + 250 && value.bottom < 844 + 1100)!;
  expect(nearby).toBeDefined();
  await expect.poll(() => model.thumbnails.includes(photoId(nearby.index)), { timeout: 15_000 }).toBe(true);
  expect((await cards(page).nth(nearby.index).boundingBox())!.y).toBeGreaterThan(844);
  const distant = positions.at(-1)!;
  expect(distant.top).toBeGreaterThan(844 + 1200);
  expect(model.thumbnails).not.toContain(photoId(distant.index));
  await expect(cards(page).last().locator('img')).toHaveCount(0);
  expect(model.originals).toEqual([]);
});

test('scrolling a cold album prioritizes newly visible thumbnails ahead of old offscreen prefetches', async ({ page }) => {
  const firstTransfers = gate();
  try {
    const model = await openShared(page, 160, model => {
      let started = 0;
      model.thumbnail = async route => {
        started += 1;
        if (started <= 2) await firstTransfers.held;
        await route.fulfill({ contentType: 'image/png', body: pixel });
      };
    });
    await expect.poll(() => model.thumbnails.length).toBe(2);
    await page.evaluate(async () => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const visibleIds = await cards(page).evaluateAll(elements => elements.flatMap(element => {
      const box = element.getBoundingClientRect();
      return box.bottom > 0 && box.top < innerHeight ? [element.getAttribute('data-photo-id')!] : [];
    }));
    expect(visibleIds.length).toBeGreaterThan(0);
    expect(visibleIds).not.toContain(model.thumbnails[0]);
    expect(visibleIds).not.toContain(model.thumbnails[1]);
    firstTransfers.release();
    await expect.poll(() => model.thumbnails.length).toBeGreaterThan(2);
    expect(visibleIds).toContain(model.thumbnails[2]);
    expect(model.originals).toEqual([]);
  } finally { firstTransfers.release(); }
});

test('returning to a thumbnail after scrolling well away reuses its bytes without another request', async ({ page }) => {
  const model = await openShared(page);
  const first = cards(page).first();
  await expect(first.locator('img')).toHaveAttribute('src', /^blob:/);
  expect(model.thumbnails.filter(id => id === photoId(0))).toHaveLength(1);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(first.locator('img')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(first.locator('img')).toHaveAttribute('src', /^blob:/);
  expect(model.thumbnails.filter(id => id === photoId(0))).toHaveLength(1);
  expect(model.originals).toEqual([]);
});

test('approval denial hides protected thumbnails and a late response cannot restore them', async ({ page }) => {
  const late = gate();
  const denied = gate();
  let lateFinished = false;
  try {
    const model = await openShared(page, 2, model => {
      model.thumbnail = async (route, id) => {
        if (id === photoId(0)) {
          await late.held;
          await route.fulfill({ contentType: 'image/png', body: pixel });
          lateFinished = true;
        } else {
          await denied.held;
          await route.fulfill({ status: 403, json: { error: 'approval required' } });
        }
      };
    });
    await expect.poll(() => model.thumbnails.length).toBe(2);
    denied.release();
    await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    late.release();
    await expect.poll(() => lateFinished).toBe(true);
    await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    expect(model.originals).toEqual([]);
  } finally { late.release(); denied.release(); }
});


for (const viewport of [{ width: 390, height: 844 }, { width: 1920, height: 1080 }]) {
  test(`media grid has square edge-to-edge cells without filename rows at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openShared(page, 12);
    for (const columns of [2, 4, 6]) {
      while (Number(await page.getByLabel('한 줄 사진 수').textContent()) > columns) await page.getByRole('button', { name: '사진 확대', exact: true }).click();
      while (Number(await page.getByLabel('한 줄 사진 수').textContent()) < columns) await page.getByRole('button', { name: '사진 축소', exact: true }).click();
      const grid = page.locator('.photo-grid');
      const geometry = await grid.evaluate(element => {
        const frames = [...element.querySelectorAll<HTMLElement>('.photo-frame')];
        return {
          grid: { left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right },
          cells: frames.map(frame => {
            const rect = frame.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, radius: getComputedStyle(frame).borderRadius };
          }),
        };
      });
      const first = geometry.cells[0]!;
      expect(Math.abs(first.width - first.height)).toBeLessThan(1);
      expect(geometry.cells[1]!.left - first.right).toBeCloseTo(0, 1);
      expect(geometry.cells[columns]!.top - first.bottom).toBeCloseTo(0, 1);
      expect(first.left).toBeCloseTo(geometry.grid.left, 1);
      expect(geometry.cells[columns - 1]!.right).toBeCloseTo(geometry.grid.right, 1);
      expect(first.radius).toBe('0px');
      const captionsPainted = await grid.locator('.photo-info, .photo-meta').evaluateAll(elements => elements.some(element => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        // Screen-reader text may retain a 1px layout box while being fully clipped.
        if (style.position === 'absolute' && style.clip.replace(/\s/g, '') === 'rect(0px,0px,0px,0px)') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }));
      expect(captionsPainted).toBe(false);
      // Filename remains the accessible selection/open identity, not a visible caption.
      await expect(cards(page).first().getByRole('button', { name: 'retention-1.png 선택', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (viewport.width === 390) {
        expect(geometry.grid.left).toBeCloseTo(0, 1);
        expect(geometry.grid.right).toBeCloseTo(viewport.width, 1);
      }
    }
    const screenshot = testInfo.outputPath(`dense-grid-${viewport.width}.png`);
    await page.screenshot({ path: screenshot });
    await mkdir('.local/dense-grid-verification', { recursive: true });
    await copyFile(screenshot, `.local/dense-grid-verification/dense-grid-${viewport.width}.png`);
  });
}
