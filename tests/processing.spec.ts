import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { PhotoProcessing } from '../apps/web/src/domain.ts';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const albumId = '00000000-0000-4000-8000-000000000001';
const photoId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';

function processing(thumbnail: PhotoProcessing['thumbnail']['state'], vision: NonNullable<PhotoProcessing['vision']>['state']): PhotoProcessing {
  return { thumbnail: { state: thumbnail, attempts: thumbnail === 'pending' ? 0 : 1 }, vision: { state: vision, attempts: vision === 'pending' ? 0 : 1 } };
}

async function openShared(page: Page, initial: PhotoProcessing, media: { name: string; type: string; received?: boolean } = { name: 'synthetic.png', type: 'image/png' }) {
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
        photos: [{ id: photoId, name: media.name, type: media.type, size: pixel.length, hash: 'synthetic-hash', createdAt: 1, contributors: [userId], requestedBy: media.received ? [userId] : [], receivedBy: media.received ? [userId] : [], importCount: 1, processing: model.processing }],
      } });
    } else if (operation === 'phogaem-similar-get') {
      await route.fulfill({ json: { groups: [], pending: model.processing.vision?.state === 'pending' || model.processing.vision?.state === 'running' ? 1 : 0, failed: model.processing.vision?.state === 'failed' ? 1 : 0, analyzed: model.processing.vision?.state === 'succeeded' ? 1 : 0 } });
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
  await expect(page.getByRole('img', { name: 'synthetic.png 사진 분석 완료', exact: true })).toHaveCount(1, { timeout: 7000 });
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
  await page.getByRole('button', { name: 'synthetic.png 처리 상태', exact: true }).click();
  const status = page.getByRole('dialog', { name: '처리 상태', exact: true });
  await expect(status.getByRole('button', { name: 'synthetic.png 썸네일 재시도', exact: true })).toBeVisible();
  await expect(status.getByRole('button', { name: 'synthetic.png 사진 분석 재시도', exact: true })).toBeVisible();
  expect(model.originals).toBe(0);
  expect(model.thumbnails).toBe(0);
  await status.getByRole('button', { name: 'synthetic.png 썸네일 재시도', exact: true }).click();
  await expect(status).toHaveCount(0);
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
    await page.getByRole('button', { name: '보관함 목록', exact: true }).click();
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


test('video thumbnail-only processing polls into a cached grid image without fetching the original', async ({ page }) => {
  const model = await openShared(page, { thumbnail: { state: 'pending', attempts: 0 } }, { name: 'clip.mp4', type: 'video/mp4' });
  await expect(page.getByRole('img', { name: 'clip.mp4 썸네일 대기', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /clip.mp4 사진 분석/ })).toHaveCount(0);
  expect(model.originals).toBe(0); expect(model.thumbnails).toBe(0);
  model.processing = { thumbnail: { state: 'succeeded', attempts: 1 } };
  const image = page.locator('article.photo-card .preview-container img');
  await expect(image).toHaveAttribute('src', /^blob:/, { timeout: 7000 });
  await expect(image).toHaveAttribute('alt', 'clip.mp4');
  expect(model.thumbnails).toBe(1); expect(model.originals).toBe(0);
  expect(model.retries).toEqual([]);
  await expect(page.locator('article.photo-card video')).toHaveCount(0);
  const calls = model.metadataCalls;
  await page.waitForTimeout(4300);
  expect(model.metadataCalls).toBe(calls);
  expect(model.thumbnails).toBe(1);
  await page.getByRole('button', { name: '중복', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(0);
  await page.getByRole('button', { name: '전체', exact: true }).click();
  await expect(image).toHaveAttribute('src', /^blob:/);
  expect(model.thumbnails).toBe(1); expect(model.originals).toBe(0);
});

test('failed video thumbnails offer only thumbnail retry and never substitute a full video', async ({ page }) => {
  const model = await openShared(page, { thumbnail: { state: 'failed', attempts: 1 } }, { name: 'clip.mov', type: 'video/quicktime' });
  await page.getByRole('button', { name: 'clip.mov 처리 상태', exact: true }).click();
  const status = page.getByRole('dialog', { name: '처리 상태', exact: true });
  const retry = status.getByRole('button', { name: 'clip.mov 썸네일 재시도', exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByRole('button', { name: /clip.mov 사진 분석/ })).toHaveCount(0);
  expect(model.originals).toBe(0); expect(model.thumbnails).toBe(0);
  await retry.click();
  await expect(status).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'clip.mov 썸네일 대기', exact: true })).toBeVisible();
  expect(model.retries).toEqual([{ albumId, photoId, kind: 'thumbnail' }]);
  expect(model.processing.vision).toBeUndefined();
  expect(model.originals).toBe(0);
});

test('approval denial while a video thumbnail becomes ready clears protected grid content', async ({ page }) => {
  const model = await openShared(page, { thumbnail: { state: 'pending', attempts: 0 } }, { name: 'clip.webm', type: 'video/webm' });
  await page.route('**/op/phogaem-thumbnail-get/v1*', route => route.fulfill({ status: 403, json: { error: 'approval required' } }));
  model.processing = { thumbnail: { state: 'succeeded', attempts: 1 } };
  await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible({ timeout: 7000 });
  await expect(page.locator('article.photo-card')).toHaveCount(0);
  await expect(page.locator('article.photo-card img, article.photo-card video')).toHaveCount(0);
  expect(model.originals).toBe(0);
});


test('received video badges stay compact at opposite corners in a six-column mobile grid', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const model = await openShared(page, { thumbnail: { state: 'succeeded', attempts: 1 } }, { name: 'received.mp4', type: 'video/mp4', received: true });
  while (Number(await page.getByLabel('한 줄 사진 수').textContent()) < 6) await page.getByRole('button', { name: '사진 축소', exact: true }).click();
  const card = page.locator('article.photo-card');
  await expect(card.locator('.preview-container img')).toHaveAttribute('src', /^blob:/);
  await expect(card.locator('.video-badge')).toBeVisible();
  await expect(card.locator('.photo-badge.received')).toBeVisible();
  const geometry = await card.evaluate(element => {
    const rect = (selector: string) => {
      const value = element.querySelector(selector)!.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width };
    };
    return { frame: rect('.photo-frame'), play: rect('.video-badge'), received: rect('.photo-badge.received') };
  });
  expect(geometry.frame.width).toBeCloseTo(65, 1);
  expect(geometry.play.width).toBeLessThanOrEqual(30);
  expect(geometry.play.left - geometry.frame.left).toBeGreaterThanOrEqual(0);
  expect(geometry.play.left - geometry.frame.left).toBeLessThanOrEqual(6);
  expect(geometry.frame.bottom - geometry.play.bottom).toBeGreaterThanOrEqual(0);
  expect(geometry.frame.bottom - geometry.play.bottom).toBeLessThanOrEqual(6);
  expect(geometry.play.right).toBeLessThan(geometry.received.left);
  expect(geometry.frame.right - geometry.received.right).toBeGreaterThanOrEqual(0);
  expect(geometry.frame.right - geometry.received.right).toBeLessThanOrEqual(6);
  expect(model.thumbnails).toBe(1); expect(model.originals).toBe(0);
});
