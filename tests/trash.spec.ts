import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { RemotePhoto, SimilarGroup } from '../apps/web/src/server/api.ts';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const userId = '60000000-0000-4000-8000-000000000001';
const friendId = '60000000-0000-4000-8000-000000000002';
const albumId = '60000000-0000-4000-8000-000000000003';
const id = (index: number) => `61000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const ready = { thumbnail: { state: 'succeeded' as const, attempts: 1 }, vision: { state: 'succeeded' as const, attempts: 1 } };
type Item = RemotePhoto & { trashedAt?: number; trashedBy?: string };
const items = (page: Page) => page.locator('article.photo-card');
const item = (page: Page, index: number) => page.locator(`article.photo-card[data-photo-id="${id(index)}"]`);
function gate() {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  return { held, release };
}

async function openShared(page: Page, options: { owner?: boolean; grouped?: boolean; pending?: boolean; trashed?: number[] } = {}) {
  const photos: Item[] = Array.from({ length: 4 }, (_, index) => ({
    id: id(index), name: index === 1 ? 'clip.mov' : `trash-${index}.png`,
    type: index === 1 ? 'video/quicktime' : 'image/png', size: pixel.length,
    hash: String(index).padStart(64, '0'), createdAt: 4 - index,
    contributors: [index === 2 ? friendId : userId], requestedBy: [], receivedBy: [], importCount: index === 0 ? 2 : 1,
    processing: index === 1 ? { thumbnail: ready.thumbnail } : ready,
    ...(options.trashed?.includes(index) ? { trashedAt: 100, trashedBy: userId } : {}),
  }));
  if (options.pending) photos[0]!.processing = { thumbnail: { state: 'pending', attempts: 0 }, vision: ready.vision };
  const album = { id: albumId, title: '휴지통 검증 여행', createdAt: 1, ownerId: options.owner === false ? friendId : userId };
  const model = {
    photos, groups: options.grouped ? [{ id: 'a'.repeat(64), photoIds: [id(0), id(3)], representativeId: id(0) }] as SimilarGroup[] : [],
    trashStatus: 200, approvalDenied: false, uploads: 0, trashGate: null as Promise<void> | null,
    activeGate: null as Promise<void> | null, activeReads: 0, heldActiveReads: 0, drainedActiveReads: 0,
    mutations: [] as Array<{ albumId: string; photoIds: string[]; trashed: boolean }>,
    reads: [] as Array<{ operation: string; photoId: string; trashed: boolean }>,
  };
  await page.route('**/auth/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/token')
    ? { access_token: 'synthetic-trash-token', expires_in: 600, user_id: userId }
    : { challenge: 'synthetic-trash-challenge' } }));
  await page.route('**/op/phogaem-*/v1*', async route => {
    const url = new URL(route.request().url());
    const operation = url.pathname.split('/')[2]!;
    if (operation === 'phogaem-albums') return route.fulfill({ json: { userId, albums: [album] } });
    if (operation === 'phogaem-album-get') {
      const trashed = url.searchParams.get('trashed') === 'true';
      const snapshot = structuredClone(photos.filter(photo => !!photo.trashedAt === trashed));
      let held = false;
      if (!trashed) { model.activeReads += 1; if (model.activeGate) { held = true; model.heldActiveReads += 1; await model.activeGate; } }
      await route.fulfill({ json: { album, members: [{ id: userId, name: '나', color: '#c5d6c4' }, { id: friendId, name: '친구', color: '#d8c6b5' }], photos: snapshot } });
      if (held) model.drainedActiveReads += 1;
      return;
    }
    if (operation === 'phogaem-similar-get') {
      const active = new Set(photos.filter(photo => !photo.trashedAt).map(photo => photo.id));
      const groups = model.groups.map(group => ({ ...group, photoIds: group.photoIds.filter(photoId => active.has(photoId)) }))
        .filter(group => group.photoIds.length >= 2).map(group => ({ ...group, representativeId: group.photoIds.includes(group.representativeId ?? '') ? group.representativeId : group.photoIds[0] }));
      return route.fulfill({ json: { groups, pending: 0, failed: 0, analyzed: active.size } });
    }
    if (operation === 'phogaem-trash-set') {
      const body = route.request().postDataJSON() as { albumId: string; photoIds: string[]; trashed: boolean };
      model.mutations.push(body);
      if (model.trashGate) await model.trashGate;
      if (model.trashStatus !== 200) return route.fulfill({ status: model.trashStatus, json: { error: model.approvalDenied ? 'approval required' : 'synthetic trash failure' } });
      const selected = photos.filter(photo => body.photoIds.includes(photo.id));
      if (selected.length !== body.photoIds.length || selected.some(photo => album.ownerId !== userId && !photo.contributors.includes(userId))) {
        return route.fulfill({ status: 403, json: { error: 'forbidden' } });
      }
      for (const photo of selected) {
        if (body.trashed) { photo.trashedAt = 100; photo.trashedBy = userId; }
        else { delete photo.trashedAt; delete photo.trashedBy; }
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (operation === 'phogaem-thumbnail-get' || operation === 'phogaem-photo-get') {
      const photoId = url.searchParams.get('photoId')!;
      const trashed = url.searchParams.get('trashed') === 'true';
      model.reads.push({ operation, photoId, trashed });
      const photo = photos.find(value => value.id === photoId && !!value.trashedAt === trashed);
      if (!photo) return route.fulfill({ status: 404, json: { error: 'not found' } });
      return route.fulfill({ contentType: 'image/png', body: pixel });
    }
    if (operation === 'phogaem-photo-upload') { model.uploads += 1; return route.fulfill({ status: 400, json: { error: 'unexpected bin upload' } }); }
    if (operation === 'phogaem-push-status') return route.fulfill({ json: { enabled: false, publicKey: '' } });
    throw new Error(`Unexpected synthetic trash operation: ${operation}`);
  });
  await page.goto('./');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await page.getByRole('button', { name: album.title, exact: false }).click();
  await expect(items(page)).toHaveCount(options.grouped ? 3 : 4 - (options.trashed?.length ?? 0));
  return model;
}

async function select(page: Page, index: number) {
  await item(page, index).getByRole('button', { name: `${index === 1 ? 'clip.mov' : `trash-${index}.png`} 선택`, exact: true }).click();
}
async function filter(page: Page, name: string) { await page.getByRole('button', { name, exact: true }).click(); }

test('moving photos and videos isolates every active filter and restores only explicitly selected items', async ({ page }) => {
  const model = await openShared(page);
  await select(page, 0); await select(page, 1);
  await page.getByRole('button', { name: '휴지통으로 이동', exact: true }).click();
  await expect(items(page)).toHaveCount(2);
  expect(model.mutations).toEqual([{ albumId, photoIds: [id(0), id(1)], trashed: true }]);
  for (const name of ['내 사진 제외', '내 사진', '중복', '받은 사진 제외', '전체']) {
    await filter(page, name);
    await expect(item(page, 0)).toHaveCount(0); await expect(item(page, 1)).toHaveCount(0);
  }
  await filter(page, '휴지통');
  await expect(items(page)).toHaveCount(2);
  await expect(item(page, 0)).toBeVisible(); await expect(item(page, 1)).toBeVisible();
  await select(page, 0);
  await page.getByRole('button', { name: '선택 복원', exact: true }).click();
  await expect(items(page)).toHaveCount(1);
  await expect(item(page, 1)).toBeVisible();
  await filter(page, '전체');
  await expect(items(page)).toHaveCount(3);
  await expect(item(page, 0)).toBeVisible(); await expect(item(page, 1)).toHaveCount(0);
  expect(model.photos[0]!.trashedAt).toBeUndefined();
  expect(model.photos[1]!.trashedAt).toBe(100);
});

test('trash persists after reload and previews use only the explicit bin path while download and upload stay isolated', async ({ page }) => {
  const model = await openShared(page, { trashed: [0, 1] });
  await page.reload();
  await page.getByRole('button', { name: '휴지통 검증 여행', exact: false }).click();
  await expect(items(page)).toHaveCount(2);
  await filter(page, '휴지통');
  await expect(items(page)).toHaveCount(2);
  await expect.poll(() => model.reads.some(read => read.operation === 'phogaem-thumbnail-get' && read.photoId === id(0) && read.trashed)).toBe(true);
  const upload = page.getByRole('button', { name: '올리기', exact: true });
  if (await upload.count()) await expect(upload).toBeDisabled();
  await page.getByLabel('사진 파일 선택', { exact: true }).setInputFiles({ name: 'not-in-trash.png', mimeType: 'image/png', buffer: pixel });
  expect(model.uploads).toBe(0);
  const compare = page.getByRole('button', { name: '비교', exact: true });
  if (await compare.count()) await expect(compare).toBeDisabled();
  await item(page, 0).getByRole('button', { name: 'trash-0.png 크게 보기', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: '사진 크게 보기', exact: true });
  await expect(viewer.getByRole('img', { name: 'trash-0.png', exact: true })).toBeVisible();
  const download = viewer.getByRole('button', { name: '이 사진 다운로드', exact: true });
  if (await download.count()) await expect(download).toBeDisabled();
  expect(model.reads.filter(read => read.operation === 'phogaem-photo-get')).toEqual([{ operation: 'phogaem-photo-get', photoId: id(0), trashed: true }]);
  await viewer.getByRole('button', { name: '이 사진 복원', exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await expect(items(page)).toHaveCount(1);
  await filter(page, '전체');
  await expect(item(page, 0)).toBeVisible();
});

test('members cannot trash others uploads or mix unauthorized items into a batch', async ({ page }) => {
  const model = await openShared(page, { owner: false });
  await select(page, 2);
  await expect(page.getByRole('button', { name: '휴지통으로 이동', exact: true })).toBeDisabled();
  await select(page, 0);
  await expect(page.getByRole('button', { name: '휴지통으로 이동', exact: true })).toBeDisabled();
  await select(page, 2);
  await expect(page.getByRole('button', { name: '휴지통으로 이동', exact: true })).toBeEnabled();
  expect(model.mutations).toEqual([]);
});

test('an album owner can trash another members upload from the viewer', async ({ page }) => {
  const model = await openShared(page);
  await item(page, 2).getByRole('button', { name: 'trash-2.png 크게 보기', exact: true }).click();
  await page.getByRole('button', { name: '이 사진 휴지통으로 이동', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '사진 크게 보기', exact: true })).toHaveCount(0);
  await expect(item(page, 2)).toHaveCount(0);
  expect(model.mutations).toEqual([{ albumId, photoIds: [id(2)], trashed: true }]);
});

test('a failed trash request keeps selected originals and allows an explicit retry after settling', async ({ page }) => {
  const model = await openShared(page);
  const held = gate(); model.trashGate = held.held; model.trashStatus = 503;
  try {
    await select(page, 0);
    const action = page.getByRole('button', { name: '휴지통으로 이동', exact: true });
    await action.click();
    await expect.poll(() => model.mutations.length).toBe(1);
    await expect(action).toBeDisabled();
    await expect(item(page, 0)).toBeVisible();
    held.release();
    await expect(page.getByRole('group', { name: '작업 실패', exact: true })).toBeVisible();
    await expect(action).toBeEnabled();
    expect(model.photos[0]!.trashedAt).toBeUndefined();
    model.trashStatus = 200; model.trashGate = null;
    await action.click();
    await expect(item(page, 0)).toHaveCount(0);
    expect(model.mutations).toHaveLength(2);
  } finally { held.release(); }
});

test('approval revocation during trashing clears all protected contents without falsely moving items', async ({ page }) => {
  const model = await openShared(page);
  model.trashStatus = 403; model.approvalDenied = true;
  await select(page, 0);
  await page.getByRole('button', { name: '휴지통으로 이동', exact: true }).click();
  await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
  await expect(items(page)).toHaveCount(0);
  expect(model.photos[0]!.trashedAt).toBeUndefined();
});

test('late active processing metadata cannot replace an explicitly opened trash view', async ({ page }) => {
  const model = await openShared(page, { pending: true, trashed: [1] });
  const held = gate(); model.activeGate = held.held;
  try {
    await expect.poll(() => model.heldActiveReads, { timeout: 7000 }).toBe(1);
    await filter(page, '휴지통');
    await expect(items(page)).toHaveCount(1);
    held.release();
    await expect.poll(() => model.drainedActiveReads).toBe(1);
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
    await expect(item(page, 1)).toBeVisible();
    await expect(item(page, 0)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '휴지통', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally { held.release(); }
});

test('trashing a representative never cascades into its other originals and restoration rebuilds the active group', async ({ page }) => {
  const model = await openShared(page, { grouped: true });
  await select(page, 0);
  await page.getByRole('button', { name: '휴지통으로 이동', exact: true }).click();
  await expect(item(page, 0)).toHaveCount(0);
  await expect(item(page, 3)).toBeVisible();
  expect(model.mutations[0]!.photoIds).toEqual([id(0)]);
  expect(model.photos[3]!.trashedAt).toBeUndefined();
  await filter(page, '휴지통'); await expect(items(page)).toHaveCount(1);
  await select(page, 0);
  await page.getByRole('button', { name: '선택 복원', exact: true }).click();
  await filter(page, '전체');
  await expect(item(page, 0)).toBeVisible();
  await expect(item(page, 3)).toHaveCount(0);
  await expect(item(page, 0).getByLabel('중복 2', { exact: true })).toBeVisible();
});

test('mobile batch trash and restore controls remain touch-sized without horizontal overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openShared(page);
  await select(page, 0); await select(page, 1);
  const action = page.getByRole('button', { name: '휴지통으로 이동', exact: true });
  await expect(action).toBeVisible();
  const box = await action.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await action.click();
  await filter(page, '휴지통'); await expect(items(page)).toHaveCount(2);
  await select(page, 0); await select(page, 1);
  const restore = page.getByRole('button', { name: '선택 복원', exact: true });
  await expect(restore).toBeVisible();
  const restoreBox = await restore.boundingBox();
  expect(restoreBox!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-trash.png') });
  await restore.click();
  await expect(items(page)).toHaveCount(0);
  await filter(page, '전체'); await expect(items(page)).toHaveCount(4);
});
