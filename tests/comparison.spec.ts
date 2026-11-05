import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import type { RemotePhoto, SimilarGroup } from '../apps/web/src/server/api.ts';

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
    groups: [] as SimilarGroup[], representativeStatus: 200, nickname: undefined as string | null | undefined,
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
        members: [{ id: userId, name: model.nickname ?? '나', color: '#c5d6c4', ...(model.nickname !== undefined ? { nickname: model.nickname } : {}) }, { id: friendId, name: '친구', color: '#d8c6b5' }], photos,
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
    } else if (operation === 'phogaem-member-name-set') {
      model.nickname = (request.postDataJSON() as { nickname: string }).nickname;
      await route.fulfill({ json: { ok: true } });
    } else if (operation === 'phogaem-representative-set') {
      if (model.representativeStatus !== 200) {
        await route.fulfill({ status: model.representativeStatus, json: { error: model.representativeStatus === 403 ? 'approval required' : 'synthetic unavailable' } });
      } else {
        const { groupId, photoId } = request.postDataJSON() as { groupId: string; photoId: string };
        model.groups = model.groups.map(group => group.id === groupId ? { ...group, representativeId: photoId } : group);
        await route.fulfill({ json: { ok: true } });
      }
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
  await expect.poll(() => model.similarCalls).toBe(1);
  await expect(page.locator('article.photo-card')).toHaveCount(count);
  return model;
}

function groupAll(model: Awaited<ReturnType<typeof openShared>>) {
  model.groups = [{ id: 'c'.repeat(64), photoIds: model.photos.map(photo => photo.id) }];
}

async function openComparison(page: Page, model: Awaited<ReturnType<typeof openShared>>) {
  groupAll(model);
  await page.getByRole('button', { name: '비교', exact: true }).click();
  await page.getByRole('button', { name: '비교 후보 1 열기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '사진 비교', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('comparison uses thumbnails until explicit enlargement and selection preserves explicit download receipt', async ({ page }) => {
  const model = await openShared(page);
  groupAll(model);
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
  expect(model.similarCalls).toBe(3);
  expect(model.mutations).toEqual([]);
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
});

for (const trigger of ['비교', '중복']) test(`a delayed ${trigger} result cannot restore shared content after opening the local library`, async ({ page }) => {
  const model = await openShared(page);
  let release = () => {};
  model.gate = new Promise<void>(resolve => { release = resolve; });
  try {
    if (trigger === '중복') await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.getByRole('button', { name: trigger, exact: true }).click();
    await expect.poll(() => model.similarCalls).toBe(2);
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
  groupAll(model);
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
  const compare = await openComparison(page, model);
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
  const compare = await openComparison(page, model);
  await compare.getByRole('button', { name: 'photo-1.png 비교 선택', exact: true }).click();
  await compare.getByRole('button', { name: '다음 비교 사진', exact: true }).click();
  await expect(compare.getByRole('button', { name: /비교 선택$/ })).toHaveCount(2);
  for (const photo of model.photos.slice(3)) await expect(compare.getByRole('img', { name: photo.name, exact: true })).toBeVisible();
  await compare.getByRole('button', { name: '이전 비교 사진', exact: true }).click();
  await expect(compare.getByRole('button', { name: 'photo-1.png 비교 선택', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(compare.getByLabel('선택한 사진 수', { exact: true })).toHaveText('1');
  expect(model.originals).toEqual([]);
});

test('duplicates filter includes similar candidates and exact imports without opening comparison', async ({ page }) => {
  const model = await openShared(page, 4);
  model.groups = [{ id: 'c'.repeat(64), photoIds: model.photos.slice(0, 2).map(photo => photo.id) }];
  model.photos[2]!.importCount = 2;
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(3);
  await page.getByRole('button', { name: '중복', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(2);
  await expect(page.getByRole('region', { name: '비교 후보', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '중복', exact: true })).toContainText('2');
  await page.getByRole('button', { name: '내 사진', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: '전체', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(3);
  expect(model.similarCalls).toBe(2);
  expect(model.originals).toEqual([]);
  expect(model.mutations).toEqual([]);
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
});

test('duplicate candidates retry failures and approval denial clears protected content', async ({ page }) => {
  const model = await openShared(page);
  groupAll(model);
  model.similarStatus = 503;
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.getByRole('button', { name: '중복', exact: true }).click();
  const failure = page.getByRole('group', { name: '중복 후보 불러오기 실패', exact: true });
  await expect(failure).toBeVisible();
  expect(model.similarCalls).toBe(2);
  model.similarStatus = 200;
  await failure.getByRole('button', { name: '재시도', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  model.similarStatus = 403;
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
  await expect(page.locator('article.photo-card')).toHaveCount(0);
  expect(model.mutations).toEqual([]);
});

test('duplicates refresh automatically when pending image analysis finishes', async ({ page }) => {
  const model = await openShared(page);
  for (const photo of model.photos) photo.processing = { ...ready, vision: { state: 'pending', attempts: 0 } };
  model.groups = [];
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByRole('img', { name: 'photo-1.png 사진 분석 대기', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '중복', exact: true }).click();
  await expect.poll(() => model.similarCalls).toBe(2);
  await expect(page.locator('article.photo-card')).toHaveCount(0);
  for (const photo of model.photos) photo.processing = ready;
  model.groups = [{ id: 'c'.repeat(64), photoIds: model.photos.map(photo => photo.id) }];
  await expect(page.locator('article.photo-card')).toHaveCount(1, { timeout: 8000 });
  expect(model.similarCalls).toBe(3);
  expect(model.originals).toEqual([]);
  expect(model.mutations).toEqual([]);
});

test('an invitation in an open approved app joins directly and resets unrelated photo filters', async ({ page }) => {
  const model = await openShared(page);
  await page.getByRole('button', { name: '내 사진', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  let joins = 0;
  await page.route('**/op/phogaem-invite-join/v1', async route => {
    joins += 1;
    expect(route.request().postDataJSON()).toEqual({ token: 'i'.repeat(43) });
    await route.fulfill({ json: { album: { id: albumId, title: '비교 검증 여행', createdAt: 1 } } });
  });
  await page.goto(`./#invite=${'i'.repeat(43)}`);
  await expect(page.getByRole('dialog', { name: '공유보관함 관리' })).toHaveCount(0);
  await expect(page.locator('article.photo-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '전체', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(joins).toBe(1); expect(new URL(page.url()).hash).toBe('');
  expect(model.mutations).toEqual([]);
});

for (const status of [404, 403, 503]) test(`invitation failure ${status} preserves recovery and approval boundaries`, async ({ page }) => {
  await openShared(page);
  let calls = 0;
  await page.route('**/op/phogaem-invite-join/v1', async route => {
    calls += 1;
    await route.fulfill({ status, json: { error: status === 403 ? 'approval required' : 'synthetic unavailable' } });
  });
  await page.goto(`./#invite=${'i'.repeat(43)}`);
  if (status === 403) {
    await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
    await expect(page.locator('article.photo-card')).toHaveCount(0);
  } else {
    await expect(page.getByRole('img', { name: status === 404 ? '사용할 수 없는 초대' : '초대 참여 실패', exact: true })).toBeVisible();
    await expect(page.getByLabel('초대 링크', { exact: true })).toBeVisible();
    await expect(page.getByLabel('보관함 이름', { exact: true })).toHaveCount(0);
    await page.getByRole('dialog', { name: '공유보관함 관리' }).getByRole('button', { name: status === 404 ? '참여' : '재시도', exact: true }).click();
    await expect.poll(() => calls).toBe(2);
  }
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
  await page.getByRole('button', { name: '공유보관함 관리 닫기', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '공유보관함 관리' })).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('');
});

function zipEntries(bytes: Buffer): Array<{ name: string; bytes: Buffer }> {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let directory = bytes.readUInt32LE(end + 16);
  return Array.from({ length: count }, () => {
    expect(bytes.readUInt32LE(directory)).toBe(0x02014b50);
    const size = bytes.readUInt32LE(directory + 24);
    const nameLength = bytes.readUInt16LE(directory + 28);
    const offset = bytes.readUInt32LE(directory + 42);
    const name = bytes.subarray(directory + 46, directory + 46 + nameLength).toString('utf8');
    const payload = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    directory += 46 + nameLength + bytes.readUInt16LE(directory + 30) + bytes.readUInt16LE(directory + 32);
    return { name, bytes: bytes.subarray(payload, payload + size) };
  });
}

test('stack cover persists across reload and select-all archives only the cover plus separate photos', async ({ page }) => {
  const model = await openShared(page, 4);
  model.groups = [{ id: 'c'.repeat(64), photoIds: model.photos.slice(0, 2).map(photo => photo.id) }];
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(3);
  await expect(page.locator('article.photo-card.photo-stack')).toHaveCount(1);
  await mkdir('.local/stack-verification', { recursive: true });
  await page.screenshot({ path: '.local/stack-verification/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.local/stack-verification/mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'photo-1.png 크게 보기', exact: true }).click();
  const compare = page.getByRole('dialog', { name: '사진 비교', exact: true });
  await expect(compare).toBeVisible();
  await compare.getByRole('button', { name: 'photo-2.png 대표사진', exact: true }).click();
  await expect(compare.getByRole('button', { name: 'photo-2.png 대표사진', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await compare.getByRole('button', { name: '비교 닫기', exact: true }).click();
  await expect(page.locator('article.photo-card').getByRole('button', { name: 'photo-2.png 크게 보기', exact: true })).toBeVisible();
  expect(model.mutations).toEqual([{ operation: 'phogaem-representative-set', body: { albumId, groupId: 'c'.repeat(64), photoId: photoId(1) } }]);
  await page.reload();
  await page.getByRole('button', { name: '비교 검증 여행', exact: false }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(3);
  await expect(page.locator('article.photo-card').getByRole('button', { name: 'photo-2.png 크게 보기', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: '현재 사진 전체 선택', exact: true }).check();
  await page.getByRole('button', { name: '선택 다운로드', exact: true }).click();
  const downloads = page.getByRole('dialog', { name: '선택 사진 다운로드', exact: true });
  await expect(downloads.getByRole('button', { name: /원본 다운로드$/ })).toHaveCount(3);
  await expect(downloads.getByRole('button', { name: 'photo-1.png 원본 다운로드', exact: true })).toHaveCount(0);
  const event = page.waitForEvent('download');
  await downloads.getByRole('button', { name: /^일괄 다운로드/ }).click();
  const downloaded = await event;
  const entries = zipEntries(await readFile((await downloaded.path())!));
  expect(entries.map(entry => entry.name)).toEqual(['photo-2.png', 'photo-3.png', 'photo-4.png']);
  for (const [index, entry] of entries.entries()) expect(entry.bytes).toEqual(originalBytes(photoId(index + 1)));
  expect(model.originals).toEqual([photoId(1), photoId(2), photoId(3)]);
  await expect.poll(() => model.mutations.filter(mutation => mutation.operation === 'phogaem-download-state').length).toBe(1);
  const receipts = model.mutations.filter(mutation => mutation.operation === 'phogaem-download-state');
  expect(receipts).toEqual([{ operation: 'phogaem-download-state', body: { albumId, photoIds: [photoId(1), photoId(2), photoId(3)], state: 'requested' } }]);
  expect(model.photos.every(photo => photo.receivedBy.length === 0)).toBe(true);
});

test('representative change approval denial clears both the stack and comparison dialog', async ({ page }) => {
  const model = await openShared(page);
  groupAll(model);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'photo-1.png 크게 보기', exact: true }).click();
  const compare = page.getByRole('dialog', { name: '사진 비교', exact: true });
  model.representativeStatus = 403;
  await compare.getByRole('button', { name: 'photo-2.png 대표사진', exact: true }).click();
  await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
  await expect(compare).toHaveCount(0);
  await expect(page.locator('article.photo-card')).toHaveCount(0);
  expect(model.originals).toEqual([]);
});


test('a filtered stack opens every member and a representative failure retries inside comparison', async ({ page }) => {
  const model = await openShared(page);
  groupAll(model);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: '내 사진', exact: true }).click();
  await page.getByRole('button', { name: 'photo-1.png 크게 보기', exact: true }).click();
  const compare = page.getByRole('dialog', { name: '사진 비교', exact: true });
  await expect(compare.getByRole('img', { name: 'photo-1.png', exact: true })).toBeVisible();
  await expect(compare.getByRole('img', { name: 'photo-2.png', exact: true })).toBeVisible();
  await compare.getByRole('button', { name: 'photo-2.png 크게 보기', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: '사진 크게 보기', exact: true });
  await expect(viewer.getByRole('img', { name: 'photo-2.png', exact: true })).toBeVisible();
  expect(model.originals).toEqual([photoId(1)]);
  await viewer.getByRole('button', { name: '뷰어 닫기', exact: true }).click();
  await expect(compare).toBeVisible();
  model.representativeStatus = 503;
  await compare.getByRole('button', { name: 'photo-2.png 대표사진', exact: true }).click();
  const failure = compare.getByRole('group', { name: '대표사진 변경 실패', exact: true });
  await expect(failure).toBeVisible();
  await expect(compare.getByRole('button', { name: 'photo-1.png 대표사진', exact: true })).toHaveAttribute('aria-pressed', 'true');
  model.representativeStatus = 200;
  await failure.getByRole('button', { name: '재시도', exact: true }).click();
  await expect(compare.getByRole('button', { name: 'photo-2.png 대표사진', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(failure).toHaveCount(0);
  expect(model.originals).toEqual([photoId(1)]);
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
});


test('an unnamed member sets a nickname before continuing and retains it after reload', async ({ page }) => {
  const model = await openShared(page);
  model.nickname = null;
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  const nickname = page.getByRole('dialog', { name: '닉네임 설정', exact: true });
  await expect(nickname).toBeVisible();
  await expect(nickname.getByRole('button', { name: '완료', exact: true })).toBeDisabled();
  await nickname.getByLabel('닉네임', { exact: true }).fill('여행 별명');
  await mkdir('.local/stack-verification', { recursive: true });
  await page.screenshot({ path: '.local/stack-verification/nickname.png' });
  await nickname.getByRole('button', { name: '완료', exact: true }).click();
  await expect(nickname).toHaveCount(0);
  await expect(page.locator('.photo-meta').first()).toContainText('여행 별명');
  expect(model.mutations).toEqual([{ operation: 'phogaem-member-name-set', body: { albumId, nickname: '여행 별명' } }]);
  await page.reload();
  await page.getByRole('button', { name: '비교 검증 여행', exact: false }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(2);
  await expect(nickname).toHaveCount(0);
  await expect(page.locator('.photo-meta').first()).toContainText('여행 별명');
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
});

test('a delayed candidate poll cannot undo a newly saved representative', async ({ page }) => {
  const model = await openShared(page);
  groupAll(model);
  for (const photo of model.photos) photo.processing = { ...ready, vision: { state: 'pending', attempts: 0 } };
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'photo-1.png 크게 보기', exact: true }).click();
  const compare = page.getByRole('dialog', { name: '사진 비교', exact: true });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const stale = structuredClone(model.groups);
  await page.route('**/op/phogaem-similar-get/v1*', async route => {
    started = true; await held;
    await route.fulfill({ json: { groups: stale, pending: 0, failed: 0, analyzed: 2 } });
  });
  try {
    for (const photo of model.photos) photo.processing = ready;
    await expect.poll(() => started, { timeout: 8000 }).toBe(true);
    await compare.getByRole('button', { name: 'photo-2.png 대표사진', exact: true }).click();
    await expect(compare.getByRole('button', { name: 'photo-2.png 대표사진', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const response = page.waitForResponse(value => value.url().includes('/op/phogaem-similar-get/'));
    release(); await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(compare.getByRole('button', { name: 'photo-2.png 대표사진', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await compare.getByRole('button', { name: '비교 닫기', exact: true }).click();
    await expect(page.locator('article.photo-card').getByRole('button', { name: 'photo-2.png 크게 보기', exact: true })).toBeVisible();
  } finally { release(); }
});

test('download rechecks the shared cover and fetches only a new representative chosen by another member', async ({ page }) => {
  const model = await openShared(page);
  groupAll(model);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'photo-1.png 선택', exact: true }).click();
  await page.getByRole('button', { name: '선택 다운로드', exact: true }).click();
  const downloads = page.getByRole('dialog', { name: '선택 사진 다운로드', exact: true });
  await expect(downloads.getByRole('button', { name: 'photo-1.png 원본 다운로드', exact: true })).toBeVisible();
  model.groups = model.groups.map(group => ({ ...group, representativeId: photoId(1) }));
  const event = page.waitForEvent('download');
  await downloads.getByRole('button', { name: 'photo-1.png 원본 다운로드', exact: true }).click();
  const download = await event;
  expect(download.suggestedFilename()).toBe('photo-2.png');
  expect(await readFile((await download.path())!)).toEqual(originalBytes(photoId(1)));
  expect(model.originals).toEqual([photoId(1)]);
  await expect.poll(() => model.mutations.filter(mutation => mutation.operation === 'phogaem-download-state').length).toBe(1);
  expect(model.mutations).toEqual([{ operation: 'phogaem-download-state', body: { albumId, photoIds: [photoId(1)], state: 'requested' } }]);
  const remove = downloads.getByRole('button', { name: 'photo-2.png 다운로드 선택 해제', exact: true });
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(downloads.getByRole('button', { name: /원본 다운로드$/ })).toHaveCount(0);
  expect(model.photos.every(photo => photo.receivedBy.length === 0)).toBe(true);
});


test('download preflight blocks originals when its current representative is absent from the album snapshot', async ({ page }) => {
  const model = await openShared(page);
  groupAll(model);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'photo-1.png 선택', exact: true }).click();
  await page.getByRole('button', { name: '선택 다운로드', exact: true }).click();
  const downloads = page.getByRole('dialog', { name: '선택 사진 다운로드', exact: true });
  await expect(downloads.getByRole('button', { name: 'photo-1.png 원본 다운로드', exact: true })).toBeEnabled();
  model.groups = [{ id: 'c'.repeat(64), photoIds: [photoId(0), photoId(2)], representativeId: photoId(2) }];
  let downloaded = false; page.on('download', () => { downloaded = true; });
  await downloads.getByRole('button', { name: 'photo-1.png 원본 다운로드', exact: true }).click();
  await expect(downloads.getByRole('group', { name: '작업 실패', exact: true })).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  expect(model.originals).toEqual([]);
  expect(model.mutations).toEqual([]);
  expect(downloaded).toBe(false);
});
