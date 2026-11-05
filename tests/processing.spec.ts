import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { PhotoProcessing } from '../apps/web/src/domain.ts';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const albumId = '00000000-0000-4000-8000-000000000001';
const photoId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';

function processing(thumbnail: PhotoProcessing['thumbnail']['state'], vision: PhotoProcessing['vision']['state']): PhotoProcessing {
  return { thumbnail: { state: thumbnail, attempts: thumbnail === 'pending' ? 0 : 1 }, vision: { state: vision, attempts: vision === 'pending' ? 0 : 1 } };
}

async function openShared(page: Page, initial: PhotoProcessing) {
  const model = { processing: initial, denied: false, metadataCalls: 0, originals: 0, thumbnails: 0, retries: [] as unknown[] };
  await page.route('**/auth/**', async route => {
    const token = new URL(route.request().url()).pathname.endsWith('/token');
    await route.fulfill({ json: token ? { access_token: 'synthetic-token', expires_in: 600, user_id: userId } : { challenge: 'synthetic-challenge' } });
  });
  await page.route('**/op/phogaem-*/v1*', async route => {
    const operation = new URL(route.request().url()).pathname.split('/')[2];
    if (model.denied) { await route.fulfill({ status: 403, json: { error: 'approval required' } }); return; }
    if (operation === 'phogaem-albums') {
      await route.fulfill({ json: { userId, albums: [{ id: albumId, title: '처리 검증 여행', createdAt: 1 }] } });
    } else if (operation === 'phogaem-album-get') {
      model.metadataCalls += 1;
      await route.fulfill({ json: {
        album: { id: albumId, title: '처리 검증 여행', createdAt: 1 }, members: [{ id: userId, name: '나', color: '#c5d6c4' }],
        photos: [{ id: photoId, name: 'synthetic.png', type: 'image/png', size: pixel.length, hash: 'synthetic-hash', createdAt: 1, contributors: [userId], requestedBy: [], receivedBy: [], importCount: 1, processing: model.processing }],
      } });
    } else if (operation === 'phogaem-thumbnail-get' || operation === 'phogaem-photo-get') {
      if (operation === 'phogaem-thumbnail-get') model.thumbnails += 1;
      else model.originals += 1;
      await route.fulfill({ contentType: 'image/png', body: pixel });
    } else if (operation === 'phogaem-processing-retry') {
      model.retries.push(route.request().postDataJSON());
      const kind = route.request().postDataJSON().kind as keyof PhotoProcessing;
      model.processing = { ...model.processing, [kind]: { state: 'pending', attempts: 1 } };
      await route.fulfill({ json: { ok: true } });
    } else throw new Error(`Unexpected synthetic operation: ${operation}`);
  });
  await page.goto('./');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await page.getByRole('button', { name: '처리 검증 여행', exact: false }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  return model;
}

test('pending processing polls into thumbnail and analysis completion, then stops polling', async ({ page }) => {
  const model = await openShared(page, processing('pending', 'running'));
  await expect(page.getByRole('img', { name: 'synthetic.png 썸네일 대기', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'synthetic.png 사진 분석 진행 중', exact: true })).toBeVisible();
  expect(model.originals).toBe(0);
  expect(model.thumbnails).toBe(0);
  model.processing = processing('succeeded', 'succeeded');
  await expect(page.getByRole('img', { name: 'synthetic.png 사진 분석 완료', exact: true })).toBeVisible({ timeout: 7000 });
  await expect(page.getByRole('img', { name: 'synthetic.png', exact: true })).toBeVisible();
  expect(model.thumbnails).toBe(1);
  expect(model.originals).toBe(0);
  const calls = model.metadataCalls;
  await page.waitForTimeout(4300);
  expect(model.metadataCalls).toBe(calls);
  expect(await page.locator('p:visible, [title]').count()).toBe(0);
});

test('ready grid uses thumbnail while the large viewer requests the original', async ({ page }) => {
  const model = await openShared(page, processing('succeeded', 'succeeded'));
  await expect(page.getByRole('img', { name: 'synthetic.png', exact: true })).toBeVisible();
  expect(model.thumbnails).toBe(1);
  expect(model.originals).toBe(0);
  await page.getByRole('button', { name: 'synthetic.png 크게 보기' }).click();
  await expect(page.getByRole('dialog').getByRole('img', { name: 'synthetic.png', exact: true })).toBeVisible();
  expect(model.originals).toBe(1);
});

test('failed processing offers explicit per-kind retry without fetching a missing thumbnail', async ({ page }) => {
  const model = await openShared(page, processing('failed', 'failed'));
  await expect(page.getByRole('button', { name: 'synthetic.png 썸네일 재시도', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'synthetic.png 사진 분석 재시도', exact: true })).toBeVisible();
  expect(model.originals).toBe(0);
  expect(model.thumbnails).toBe(0);
  await page.getByRole('button', { name: 'synthetic.png 썸네일 재시도', exact: true }).click();
  await expect(page.getByRole('img', { name: 'synthetic.png 썸네일 대기', exact: true })).toBeVisible();
  expect(model.retries).toEqual([{ albumId, photoId, kind: 'thumbnail' }]);
  expect(await page.locator('p:visible, [title]').count()).toBe(0);
});

test('a processing poll approval denial clears protected photos and stops polling', async ({ page }) => {
  const model = await openShared(page, processing('pending', 'pending'));
  model.denied = true;
  await expect(page.getByRole('region', { name: '계정 승인 대기' })).toBeVisible({ timeout: 7000 });
  await expect(page.locator('article.photo-card')).toHaveCount(0);
  const calls = model.metadataCalls;
  await page.waitForTimeout(4300);
  expect(model.metadataCalls).toBe(calls);
  expect(model.thumbnails).toBe(0);
  expect(model.originals).toBe(0);
});

test('a delayed processing poll cannot restore an album after switching to the local library', async ({ page }) => {
  const model = await openShared(page, processing('pending', 'pending'));
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  let staleCalls = 0;
  await page.route('**/op/phogaem-album-get/v1*', async route => {
    staleCalls += 1;
    started = true;
    await held;
    await route.fulfill({ json: { album: { id: albumId, title: '오래된 응답', createdAt: 1 }, members: [], photos: [] } });
  });
  try {
    await expect.poll(() => started, { timeout: 7000 }).toBe(true);
    await page.getByRole('button', { name: '보관함', exact: true }).click();
    await page.getByRole('button', { name: '계정', exact: true }).click();
    await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
    await expect(page.getByRole('heading', { name: '기기 보관함', exact: true })).toBeVisible();
    release();
    await page.waitForTimeout(4300);
    await expect(page.getByRole('heading', { name: '기기 보관함', exact: true })).toBeVisible();
    await expect(page.locator('article.photo-card')).toHaveCount(0);
    expect(staleCalls).toBe(1);
    expect(model.originals).toBe(0);
  } finally { release(); }
});
