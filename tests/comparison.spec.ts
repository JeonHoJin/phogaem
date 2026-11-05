import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import type { RemotePhoto } from '../apps/web/src/server/api.ts';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const albumId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const friendId = '10000000-0000-4000-8000-000000000003';
const ready = { thumbnail: { state: 'succeeded' as const, attempts: 1 }, vision: { state: 'succeeded' as const, attempts: 1 } };
const photoId = (index: number) => `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const originalBytes = (id: string) => Buffer.concat([pixel, Buffer.from(`original:${id}`)]);

async function openShared(page: Page, count = 2) {
  const photos: RemotePhoto[] = Array.from({ length: count }, (_, index) => ({
    id: photoId(index),
    name: `photo-${index + 1}.png`, type: 'image/png', size: originalBytes(photoId(index)).length,
    hash: String(index + 1).padStart(64, '0'), createdAt: count - index,
    contributors: [index === 0 ? userId : friendId], requestedBy: [], receivedBy: [], importCount: 1,
    processing: ready,
  }));
  const model = {
    photos, similarCalls: 0, similarStatus: 200, gate: null as Promise<void> | null,
    originals: [] as string[], thumbnails: [] as string[], mutations: [] as Array<{ operation: string; body: Record<string, unknown> }>,
    groups: [{ id: 'c'.repeat(64), photoIds: photos.map(photo => photo.id) }],
  };
  await page.route('**/auth/**', async route => {
    await route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/token')
      ? { access_token: 'synthetic-comparison-token', expires_in: 600, user_id: userId }
      : { challenge: 'synthetic-comparison-challenge' } });
  });
  await page.route('**/op/phogaem-*/v1*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const operation = url.pathname.split('/')[2]!;
    if (request.method() !== 'GET') model.mutations.push({ operation, body: request.postDataJSON() });
    if (operation === 'phogaem-albums') {
      await route.fulfill({ json: { userId, albums: [{ id: albumId, title: '비교 검증 여행', createdAt: 1 }] } });
    } else if (operation === 'phogaem-album-get') {
      await route.fulfill({ json: {
        album: { id: albumId, title: '비교 검증 여행', createdAt: 1 },
        members: [{ id: userId, name: '나', color: '#c5d6c4' }, { id: friendId, name: '친구', color: '#d8c6b5' }], photos,
      } });
    } else if (operation === 'phogaem-similar-get') {
      model.similarCalls += 1;
      if (model.gate) await model.gate;
      if (model.similarStatus !== 200) {
        await route.fulfill({ status: model.similarStatus, json: { error: model.similarStatus === 403 ? 'approval required' : 'synthetic unavailable' } });
      } else await route.fulfill({ json: { groups: model.groups, pending: 0, failed: 0, analyzed: photos.length } });
    } else if (operation === 'phogaem-thumbnail-get' || operation === 'phogaem-photo-get') {
      const id = url.searchParams.get('photoId')!;
      (operation === 'phogaem-thumbnail-get' ? model.thumbnails : model.originals).push(id);
      await route.fulfill({ contentType: 'image/png', body: operation === 'phogaem-thumbnail-get' ? pixel : originalBytes(id) });
    } else if (operation === 'phogaem-download-state') {
      const body = request.postDataJSON() as { photoIds: string[]; state: string };
      for (const photo of photos.filter(photo => body.photoIds.includes(photo.id))) {
        if (body.state === 'requested') photo.requestedBy = [userId];
        if (body.state === 'received') photo.receivedBy = [userId];
        if (body.state === 'reset') { photo.requestedBy = []; photo.receivedBy = []; }
      }
      await route.fulfill({ json: { ok: true } });
    } else throw new Error(`Unexpected synthetic comparison operation: ${operation}`);
  });
  await page.goto('./');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await page.getByRole('button', { name: '비교 검증 여행', exact: false }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(count);
  return model;
}

async function openComparison(page: Page) {
  await page.getByRole('button', { name: '비교', exact: true }).click();
  await page.getByRole('button', { name: '비교 후보 1 열기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '사진 비교', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('comparison uses thumbnails until explicit enlargement and selection preserves explicit download receipt', async ({ page }) => {
  const model = await openShared(page);
  await page.getByRole('button', { name: '비교', exact: true }).click();
  await expect(page.getByRole('button', { name: '비교 후보 1 열기', exact: true })).toBeVisible();
  expect(model.originals).toEqual([]);
  expect(model.mutations).toEqual([]);
  await page.getByRole('button', { name: '비교 후보 1 열기', exact: true }).click();
  const compare = page.getByRole('dialog', { name: '사진 비교', exact: true });
  await expect(compare.getByRole('img', { name: 'photo-1.png', exact: true })).toBeVisible();
  await expect(compare.getByRole('img', { name: 'photo-2.png', exact: true })).toBeVisible();
  await mkdir('.local/comparison-verification', { recursive: true });
  await page.screenshot({ path: '.local/comparison-verification/desktop.png' });
  expect(model.originals).toEqual([]);
  expect(model.mutations).toEqual([]);
  await compare.getByRole('button', { name: 'photo-1.png 비교 선택', exact: true }).click();
  await expect(compare.getByRole('button', { name: 'photo-1.png 비교 선택', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await compare.getByRole('button', { name: 'photo-1.png 크게 보기', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: '사진 크게 보기', exact: true });
  await expect(viewer.getByRole('img', { name: 'photo-1.png', exact: true })).toBeVisible();
  expect(model.originals).toEqual([model.photos[0]!.id]);
  expect(model.mutations).toEqual([]);
  await viewer.getByRole('button', { name: '뷰어 닫기', exact: true }).click();
  await expect(compare).toBeVisible();
  await expect(compare.getByRole('button', { name: 'photo-1.png 비교 선택', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await compare.getByRole('button', { name: '선택 다운로드', exact: true }).click();
  const downloads = page.getByRole('dialog', { name: '선택 사진 다운로드', exact: true });
  await expect(downloads).toBeVisible();
  await expect(compare).toHaveCount(0);
  expect(model.mutations).toEqual([]);
  await expect(downloads.getByRole('button', { name: '받았음 확인', exact: true })).toHaveCount(0);
  const event = page.waitForEvent('download');
  await downloads.getByRole('button', { name: 'photo-1.png 원본 다운로드', exact: true }).click();
  const download = await event;
  expect(await readFile((await download.path())!)).toEqual(originalBytes(model.photos[0]!.id));
  await expect(downloads.getByRole('button', { name: '받았음 확인', exact: true })).toHaveAttribute('aria-pressed', 'false');
  expect(model.mutations).toEqual([{ operation: 'phogaem-download-state', body: { albumId, photoIds: [model.photos[0]!.id], state: 'requested' } }]);
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
});

test('candidate error recovery and filters keep comparison groups aligned with visible photos', async ({ page }) => {
  const model = await openShared(page, 4);
  model.groups = [
    { id: 'c'.repeat(64), photoIds: model.photos.slice(0, 2).map(photo => photo.id) },
    { id: 'd'.repeat(64), photoIds: [model.photos[2]!.id, '30000000-0000-4000-8000-000000000001'] },
  ];
  model.similarStatus = 503;
  await page.getByRole('button', { name: '비교', exact: true }).click();
  const failure = page.getByRole('group', { name: '비교 후보 불러오기 실패', exact: true });
  await expect(failure).toBeVisible();
  expect(await failure.innerText()).not.toMatch(/실패했|다시 시도해|불러오지|사진을/);
  model.similarStatus = 200;
  await failure.getByRole('button', { name: '재시도', exact: true }).click();
  await expect(page.getByRole('button', { name: '비교 후보 1 열기', exact: true })).toBeVisible();
  // A candidate ID absent from the authorized album cannot create a second comparison group.
  await expect(page.getByRole('button', { name: /비교 후보 \d+ 열기/ })).toHaveCount(1);
  await page.getByRole('button', { name: '내 사진', exact: true }).click();
  await expect(page.getByRole('button', { name: /비교 후보 \d+ 열기/ })).toHaveCount(0);
  await page.getByRole('button', { name: '전체', exact: true }).click();
  await expect(page.getByRole('button', { name: '비교 후보 1 열기', exact: true })).toBeVisible();
  expect(model.similarCalls).toBe(2);
  expect(model.mutations).toEqual([]);
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
});

test('a delayed candidate result cannot restore shared content after opening the local library', async ({ page }) => {
  const model = await openShared(page);
  let release = () => {};
  model.gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.getByRole('button', { name: '비교', exact: true }).click();
    await expect.poll(() => model.similarCalls).toBe(1);
    await page.getByRole('button', { name: '보관함', exact: true }).click();
    await page.getByRole('button', { name: '계정', exact: true }).click();
    await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
    await expect(page.getByRole('heading', { name: '기기 보관함', exact: true })).toBeVisible();
    const response = page.waitForResponse(response => response.url().includes('/op/phogaem-similar-get/'));
    release();
    await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(page.getByRole('heading', { name: '기기 보관함', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '비교 후보', exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '사진 비교', exact: true })).toHaveCount(0);
    await expect(page.locator('article.photo-card')).toHaveCount(0);
    expect(model.originals).toEqual([]);
  } finally { release(); }
});

test('approval denial on candidate refresh clears the protected album and comparison board', async ({ page }) => {
  const model = await openShared(page);
  await page.getByRole('button', { name: '비교', exact: true }).click();
  await expect(page.getByRole('button', { name: '비교 후보 1 열기', exact: true })).toBeVisible();
  model.similarStatus = 403;
  await page.getByRole('button', { name: '후보 새로고침', exact: true }).click();
  await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '비교 후보', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '사진 비교', exact: true })).toHaveCount(0);
  await expect(page.locator('article.photo-card')).toHaveCount(0);
  expect(model.originals).toEqual([]);
  expect(model.mutations).toEqual([]);
});

test('mobile comparison pages bounded thumbnails without overflow or unrequested originals', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const model = await openShared(page, 6);
  const compare = await openComparison(page);
  await expect(compare.getByRole('button', { name: /비교 선택$/ })).toHaveCount(4);
  for (const photo of model.photos.slice(0, 4)) await expect(compare.getByRole('img', { name: photo.name, exact: true })).toBeVisible();
  expect(model.originals).toEqual([]);
  expect(await compare.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await mkdir('.local/comparison-verification', { recursive: true });
  await page.screenshot({ path: '.local/comparison-verification/mobile.png' });
  await compare.getByRole('button', { name: '다음 비교 사진', exact: true }).click();
  await expect(compare.getByRole('button', { name: /비교 선택$/ })).toHaveCount(2);
  for (const photo of model.photos.slice(4)) await expect(compare.getByRole('img', { name: photo.name, exact: true })).toBeVisible();
  expect(model.originals).toEqual([]);
  expect(await compare.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(model.mutations).toEqual([]);
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
});


test('a single trailing candidate keeps a previous photo beside it for comparison', async ({ page }) => {
  const model = await openShared(page, 5);
  const compare = await openComparison(page);
  await compare.getByRole('button', { name: '다음 비교 사진', exact: true }).click();
  await expect(compare.getByRole('button', { name: /비교 선택$/ })).toHaveCount(2);
  for (const photo of model.photos.slice(3)) await expect(compare.getByRole('img', { name: photo.name, exact: true })).toBeVisible();
  await compare.getByRole('button', { name: 'photo-4.png 비교 선택', exact: true }).click();
  await compare.getByRole('button', { name: '이전 비교 사진', exact: true }).click();
  await expect(compare.getByRole('button', { name: 'photo-4.png 비교 선택', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(compare.getByLabel('선택한 사진 수', { exact: true })).toHaveText('1');
  expect(model.originals).toEqual([]);
});
