import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Photo } from '../apps/web/src/domain.ts';

const userId = '50000000-0000-4000-8000-000000000001';
const albums = [
  { id: '50000000-0000-4000-8000-000000000002', title: '영상 검증 여행', createdAt: 2 },
  { id: '50000000-0000-4000-8000-000000000003', title: '다음 여행', createdAt: 1 },
];
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
// Transport-only MP4 fixture. Codec playback uses a separately generated WebM.
const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D6D703432', 'hex');
const imageFile = { name: 'camera.png', mimeType: 'image/png', buffer: pixel };
const input = (page: Page) => page.getByLabel('사진 파일 선택', { exact: true });
const preparing = (page: Page) => page.getByRole('status', { name: '사진 준비 중', exact: true });

async function openShared(page: Page) {
  const model = {
    photos: [] as Photo[],
    uploads: [] as Array<{ name: string; albumId: string; type: string; bytes: Buffer }>,
    originals: [] as string[], thumbnails: [] as string[],
    bytes: new Map<string, Buffer>(),
  };
  await page.route('**/auth/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/token')
    ? { access_token: 'synthetic-video-token', expires_in: 600, user_id: userId }
    : { challenge: 'synthetic-video-challenge' } }));
  await page.route('**/op/phogaem-*/v1*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const operation = url.pathname.split('/')[2];
    if (operation === 'phogaem-albums') await route.fulfill({ json: { userId, albums } });
    else if (operation === 'phogaem-album-get') {
      const album = albums.find(value => value.id === url.searchParams.get('albumId'))!;
      await route.fulfill({ json: {
        album, members: [{ id: userId, name: '나', color: '#c5d6c4' }],
        photos: model.photos.filter(value => value.albumId === album.id),
      } });
    } else if (operation === 'phogaem-similar-get') await route.fulfill({ json: { groups: [], pending: 0, failed: 0, analyzed: 0 } });
    else if (operation === 'phogaem-photo-upload') {
      const name = url.searchParams.get('name')!;
      const albumId = url.searchParams.get('albumId')!;
      const type = request.headers()['content-type'];
      const bytes = request.postDataBuffer()!;
      model.uploads.push({ name, albumId, type, bytes });
      const id = `50000000-0000-4000-8001-${String(model.uploads.length).padStart(12, '0')}`;
      const photo: Photo = {
        id, name, albumId, type, size: bytes.length, hash: 'synthetic-video-hash', createdAt: model.uploads.length,
        contributors: [userId], requestedBy: [], receivedBy: [], importCount: 1,
      };
      model.photos.push(photo); model.bytes.set(id, bytes);
      await route.fulfill({ json: { added: true, photo } });
    } else if (operation === 'phogaem-photo-get') {
      const id = url.searchParams.get('photoId')!;
      model.originals.push(id);
      await route.fulfill({ contentType: model.photos.find(value => value.id === id)!.type, body: model.bytes.get(id)! });
    } else if (operation === 'phogaem-thumbnail-get') {
      model.thumbnails.push(url.searchParams.get('photoId')!);
      await route.fulfill({ contentType: 'image/png', body: pixel });
    } else if (operation === 'phogaem-download-state') {
      const body = request.postDataJSON() as { photoIds: string[]; state: string };
      for (const photo of model.photos.filter(value => body.photoIds.includes(value.id))) {
        if (body.state === 'requested') photo.requestedBy = [userId];
        else if (body.state === 'received') photo.receivedBy = [userId];
        else { photo.requestedBy = []; photo.receivedBy = []; }
      }
      await route.fulfill({ json: { ok: true } });
    } else if (operation === 'phogaem-push-status') await route.fulfill({ json: { enabled: false, publicKey: '' } });
    else throw new Error(`Unexpected synthetic operation: ${operation}`);
  });
  await page.goto('./');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await page.getByRole('button', { name: albums[0].title, exact: false }).click();
  await expect(page.getByRole('heading', { name: albums[0].title, exact: true })).toBeVisible();
  return model;
}

async function stubPicker(page: Page) {
  await page.evaluate(() => {
    const starts: Array<{ visible: boolean; text: string }> = [];
    Object.assign(window, { syntheticPickerStarts: starts });
    const nativeClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file') { nativeClick.call(this); return; }
      const status = document.querySelector<HTMLElement>('[role="status"][aria-label="사진 준비 중"]');
      starts.push({ visible: !!status && status.getBoundingClientRect().height > 0, text: status?.textContent ?? '' });
    };
  });
}

async function openPicker(page: Page) {
  await page.getByRole('button', { name: '올리기', exact: true }).first().click();
  await expect(preparing(page)).toBeVisible();
}

async function syntheticWebm(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#485e35'; context.fillRect(0, 0, 8, 8);
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    const stopped = new Promise<Blob>(resolve => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });
    recorder.start();
    // Record one synthetic canvas frame; this timer creates media, not a UI wait.
    window.setTimeout(() => recorder.stop(), 150);
    const blob = await stopped;
    stream.getTracks().forEach(track => track.stop());
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return Buffer.from(bytes);
}

test.use({ viewport: { width: 390, height: 844 } });

test('preparation is visible before the native picker opens and survives delayed photo delivery', async ({ page }) => {
  const model = await openShared(page);
  await stubPicker(page);
  await openPicker(page);
  const starts = await page.evaluate(() => (window as unknown as { syntheticPickerStarts: Array<{ visible: boolean; text: string }> }).syntheticPickerStarts);
  expect(starts).toEqual([{ visible: true, text: '' }]);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(preparing(page)).toBeVisible();
  expect(model.uploads).toEqual([]);
  await input(page).setInputFiles(imageFile);
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(preparing(page)).toHaveCount(0);
  expect(model.uploads.map(value => value.name)).toEqual(['camera.png']);
});

test('native picker cancellation clears preparation and allows a fresh selection', async ({ page }) => {
  await openShared(page);
  await stubPicker(page);
  await openPicker(page);
  await input(page).dispatchEvent('cancel');
  await expect(preparing(page)).toHaveCount(0);
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await openPicker(page);
  await input(page).setInputFiles(imageFile);
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await expect(preparing(page)).toHaveCount(0);
});

test('dismissed preparation rejects late files until the user opens a fresh picker', async ({ page }) => {
  const model = await openShared(page);
  await stubPicker(page);
  await openPicker(page);
  await page.getByRole('button', { name: '선택 취소', exact: true }).click();
  await expect(preparing(page)).toHaveCount(0);
  await input(page).setInputFiles(imageFile);
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  expect(model.uploads).toEqual([]);
  await openPicker(page);
  await input(page).setInputFiles(imageFile);
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  expect(model.uploads.map(value => value.name)).toEqual(['camera.png']);
});

test('a delayed selection from the old album cannot upload into another album', async ({ page }) => {
  const model = await openShared(page);
  await stubPicker(page);
  await openPicker(page);
  await page.getByRole('button', { name: '보관함 목록', exact: true }).click();
  await page.getByRole('button', { name: albums[1].title, exact: false }).click();
  await expect(page.getByRole('heading', { name: albums[1].title, exact: true })).toBeVisible();
  await input(page).setInputFiles(imageFile);
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(preparing(page)).toHaveCount(0);
  await expect(page.locator('article.photo-card')).toHaveCount(0);
  expect(model.uploads).toEqual([]);
});

test('late events from an old picker cannot cancel or replace a new album selection', async ({ page }) => {
  const model = await openShared(page);
  await stubPicker(page);
  await openPicker(page);
  await input(page).evaluate(element => { Object.assign(window, { stalePickerInput: element }); });
  await page.getByRole('button', { name: '보관함 목록', exact: true }).click();
  await page.getByRole('button', { name: albums[1].title, exact: false }).click();
  await expect(page.getByRole('heading', { name: albums[1].title, exact: true })).toBeVisible();
  await openPicker(page);
  await page.evaluate(() => {
    const stale = (window as unknown as { stalePickerInput: HTMLInputElement }).stalePickerInput;
    const current = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (stale === current || stale.isConnected) throw new Error('The old picker input was not replaced');
    const files = new DataTransfer();
    files.items.add(new File([new Uint8Array([1, 2, 3])], 'old.mp4', { type: 'video/mp4' }));
    stale.files = files.files;
    stale.dispatchEvent(new Event('change', { bubbles: true }));
    stale.dispatchEvent(new Event('cancel', { bubbles: true }));
  });
  await expect(preparing(page)).toBeVisible();
  expect(model.uploads).toEqual([]);
  await input(page).setInputFiles({ name: 'current.mp4', mimeType: 'video/mp4', buffer: mp4 });
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(preparing(page)).toHaveCount(0);
  expect(model.uploads.map(value => ({ name: value.name, albumId: value.albumId }))).toEqual([
    { name: 'current.mp4', albumId: albums[1].id },
  ]);
});

test('identical video uploads stay separate and never load image previews or appear as duplicates', async ({ page }) => {
  const model = await openShared(page);
  // WebKit's current-representation path recognizes the generic image UTI.
  // Actual supported formats and size limits remain enforced after selection.
  await expect(input(page)).toHaveAttribute('accept', 'image/*,video/*');
  await input(page).setInputFiles([
    { name: 'first.mp4', mimeType: 'video/mp4', buffer: mp4 },
    { name: 'second.mp4', mimeType: 'video/mp4', buffer: mp4 },
  ]);
  await expect(page.locator('article.photo-card')).toHaveCount(2);
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  expect(model.uploads.map(value => ({ name: value.name, type: value.type, bytes: value.bytes }))).toEqual([
    { name: 'first.mp4', type: 'video/mp4', bytes: mp4 },
    { name: 'second.mp4', type: 'video/mp4', bytes: mp4 },
  ]);
  expect(model.originals).toEqual([]);
  expect(model.thumbnails).toEqual([]);
  await expect(page.locator('.processing-states')).toHaveCount(0);
  await page.getByRole('button', { name: '중복', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(0);
});

test('video viewer uses native inline controls and downloading preserves every original byte', async ({ page }) => {
  const model = await openShared(page);
  const bytes = await syntheticWebm(page);
  expect(bytes.length).toBeGreaterThan(0);
  await input(page).setInputFiles({ name: 'clip.webm', mimeType: 'video/webm', buffer: bytes });
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  expect(model.originals).toEqual([]);
  await page.getByRole('button', { name: 'clip.webm 크게 보기', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: '사진 크게 보기', exact: true });
  const video = viewer.locator('video');
  await expect(video).toHaveAttribute('src', /^blob:/);
  await expect(video).toHaveAttribute('controls', '');
  await expect(video).toHaveAttribute('playsinline', '');
  await expect(video).toHaveAttribute('preload', 'metadata');
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
  await expect(video).not.toHaveAttribute('autoplay');
  await viewer.getByRole('button', { name: '이 사진 다운로드', exact: true }).click();
  const downloadDialog = page.getByRole('dialog', { name: '선택 사진 다운로드', exact: true });
  const downloadEvent = page.waitForEvent('download');
  await downloadDialog.getByRole('button', { name: 'clip.webm 원본 다운로드', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('clip.webm');
  expect(await readFile((await download.path())!)).toEqual(bytes);
  await expect(page.getByRole('dialog', { name: '선택 사진 다운로드' }).getByRole('img', { name: '다운로드 요청됨', exact: true })).toBeVisible();
});

test('an unsupported video remains downloadable when its browser preview fails', async ({ page }) => {
  await openShared(page);
  await input(page).setInputFiles({ name: 'unsupported.mp4', mimeType: 'video/mp4', buffer: mp4 });
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'unsupported.mp4 크게 보기', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: '사진 크게 보기', exact: true });
  await expect(viewer.getByRole('img', { name: '미리보기 없음', exact: true })).toBeVisible();
  await expect(viewer.getByRole('button', { name: '이 사진 다운로드', exact: true })).toBeEnabled();
  await expect(viewer.locator('p:visible, [title]')).toHaveCount(0);
});

test('an oversized video rejects the entire mixed selection before making any write', async ({ page }) => {
  const model = await openShared(page);
  await input(page).evaluate(element => {
    const files = new DataTransfer();
    files.items.add(new File([new Uint8Array([0, 0, 0, 24])], 'small.mp4', { type: 'video/mp4' }));
    files.items.add(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.mov', { type: 'video/quicktime' }));
    (element as HTMLInputElement).files = files.files;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.getByRole('group', { name: '작업 실패', exact: true })).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('status', { name: /사진 (준비|업로드|목록 갱신) 중/ })).toHaveCount(0);
  expect(model.uploads).toEqual([]);
});
