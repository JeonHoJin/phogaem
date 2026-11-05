import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const cards = (page: Page) => page.locator('article.photo-card');

async function open(page: Page) {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: '보관함', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  await expect(page.getByRole('heading', { name: '기기 보관함', exact: true })).toBeVisible();
}

async function seed(page: Page) {
  await open(page);
  await page.getByRole('button', { name: '샘플', exact: true }).click();
  await expect(cards(page)).toHaveCount(12);
}

async function upload(page: Page, name = 'original.png', buffer = pixel, mimeType = 'image/png') {
  await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('사진 파일 선택').setInputFiles({ name, mimeType, buffer });
  await expect(page.getByRole('progressbar', { name: '업로드' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: '작업 실패' })).toHaveCount(0);
}

test('empty album makes no external requests and creates no server identity', async ({ page }) => {
  const external: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.hostname !== '127.0.0.1') external.push(url.href);
  });
  await open(page);
  await expect(page.getByRole('heading', { name: '기기 보관함', exact: true })).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['phogaem:/phogaem/:preferences']);
  expect(external).toEqual([]);
});

test('sample filtering combines conditions and persists member and filters on reload', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: '중복' }).click();
  await expect(cards(page)).toHaveCount(3);
  await page.getByRole('button', { name: '내 사진 제외', exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '필터 초기화' })).toBeVisible();
  await page.getByLabel('미리보기 사용자').selectOption('jun');
  await expect(cards(page)).toHaveCount(3);
  await page.reload();
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  await expect(cards(page)).toHaveCount(3);
  await expect(page.getByLabel('미리보기 사용자')).toHaveValue('jun');
  await expect(page.getByRole('button', { name: '내 사진 제외', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '전체', exact: true }).click();
  await expect(cards(page)).toHaveCount(12);
});

test('same bytes with a new name merge, changed bytes with the same name stay distinct', async ({ page }) => {
  await open(page);
  await upload(page);
  await expect(cards(page)).toHaveCount(1);
  await upload(page, 'renamed.png');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first().getByLabel('중복 2')).toBeVisible();
  await upload(page, 'original.png', Buffer.concat([pixel, Buffer.from('extra metadata')]));
  await expect(cards(page)).toHaveCount(2);
  await page.reload();
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  await expect(cards(page)).toHaveCount(2);
});

test('concurrent IndexedDB imports store one original and preserve both contributors', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async ({ modulePath, bytes }) => {
    const storage = await import(modulePath) as typeof import('../apps/web/src/storage.ts');
    const file = () => new File([new Uint8Array(bytes)], 'concurrent.png', { type: 'image/png' });
    await Promise.all([storage.importPhotos([file()], 'me'), storage.importPhotos([file()], 'mina')]);
    return (await storage.loadPhotos()).map(photo => ({ contributors: photo.contributors, count: photo.importCount }));
  }, { modulePath: '/phogaem/src/storage.ts', bytes: Array.from(pixel) });
  expect(result).toHaveLength(1);
  expect(result[0]?.contributors.sort()).toEqual(['me', 'mina']);
  expect(result[0]?.count).toBe(2);
  const unrequested = await page.evaluate(async (modulePath) => {
    const storage = await import(modulePath) as typeof import('../apps/web/src/storage.ts');
    const all = await storage.loadPhotos();
    return (await storage.setDownloadState([all[0]!.id], 'jun', 'received'))[0]!.receivedBy;
  }, '/phogaem/src/storage.ts');
  expect(unrequested).not.toContain('jun');
  await page.reload();
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
});

test('mixed invalid upload is rejected atomically and HEIC keeps its original with fallback', async ({ page }) => {
  await open(page);
  await page.getByLabel('사진 파일 선택').setInputFiles([
    { name: 'valid.png', mimeType: 'image/png', buffer: pixel },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') },
  ]);
  await expect(page.getByRole('group', { name: '작업 실패' })).toBeVisible();
  await expect(page.getByRole('button', { name: '다시 선택' })).toBeEnabled();
  await expect(cards(page)).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  await upload(page, 'camera.HEIC', Buffer.from('synthetic unsupported HEIC'), 'image/heic');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).getByLabel('미리보기 없음')).toBeVisible();
  await page.getByRole('button', { name: 'camera.HEIC 크게 보기' }).click();
  await expect(page.getByRole('dialog').getByLabel('미리보기 없음')).toBeVisible();
  await expect(page.getByRole('button', { name: '이 사진 다운로드' })).toBeEnabled();
});

test('download preserves bytes and request, receipt, reset remain separate', async ({ page }) => {
  await open(page);
  await upload(page);
  await page.getByRole('button', { name: 'original.png 선택', exact: true }).click();
  await page.getByRole('button', { name: '선택 다운로드', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '선택 사진 다운로드' });
  await expect(dialog.getByRole('button', { name: '받았음 확인', exact: true })).toHaveCount(0);
  const downloadEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'original.png 원본 다운로드' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('original.png');
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = await readFile(path!);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(createHash('sha256').update(pixel).digest('hex'));
  await expect(dialog.getByRole('button', { name: '받았음 확인', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await dialog.getByRole('button', { name: '받았음 확인', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '받았음 확인', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: '다운로드 창 닫기' }).click();
  await page.getByRole('button', { name: '받은 사진 제외', exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  await page.getByRole('button', { name: '전체', exact: true }).click();
  await page.getByRole('button', { name: 'original.png 선택', exact: true }).click();
  await page.getByRole('button', { name: '선택 다운로드', exact: true }).click();
  await dialog.getByRole('button', { name: '기록 되돌리기', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '받았음 확인', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '다운로드 창 닫기' }).click();
  await page.getByRole('button', { name: '받은 사진 제외', exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
});

test('viewer arrows, slideshow and Escape retain a keyboard focus path', async ({ page }) => {
  await seed(page);
  const opener = page.getByRole('button', { name: /크게 보기$/ }).first();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '사진 크게 보기' });
  const firstName = await dialog.locator('.viewer-header strong').textContent();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.locator('.viewer-header strong')).not.toHaveText(firstName!);
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.locator('.viewer-header strong')).toHaveText(firstName!);
  await dialog.getByRole('button', { name: '슬라이드쇼 시작' }).click();
  await expect(dialog.getByRole('button', { name: '슬라이드쇼 일시정지' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test('loaded album imports and reads photos without a network connection', async ({ page, context }) => {
  await open(page);
  await context.setOffline(true);
  await upload(page);
  await expect(cards(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'original.png 크게 보기' }).click();
  await expect(page.getByRole('dialog').getByRole('img', { name: 'original.png' })).toBeVisible();
  await context.setOffline(false);
  await page.reload();
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
});

test('viewer fullscreen exits on close and restores the opening control focus', async ({ page }) => {
  await seed(page);
  const opener = page.getByRole('button', { name: /크게 보기$/ }).first();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '사진 크게 보기' });
  await dialog.getByRole('button', { name: '전체 화면', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('viewer') ?? false)).toBe(true);
  await dialog.getByRole('button', { name: '뷰어 닫기' }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(opener).toBeFocused();
});

test('mobile 390px has no horizontal overflow and supports selecting and opening photos', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: / 선택$/ }).first().click();
  await expect(page.getByRole('complementary', { name: '선택한 사진' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/phogaem-mobile.png', fullPage: true });
  await page.getByRole('button', { name: /크게 보기$/ }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '뷰어 닫기' }).click();
});

test('desktop 1920px shows the full album and produces a review screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await seed(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(cards(page).first().getByRole('img')).toBeVisible();
  await page.screenshot({ path: 'test-results/phogaem-desktop.png', fullPage: true });
});

for (const outcome of ['success', 'failure'] as const) {
  test(`entry waits for initial local storage ${outcome} without creating an identity`, async ({ page }) => {
    await seed(page);
    const authRequests: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/auth/')) authRequests.push(request.url());
    });
    await page.addInitScript(() => {
      Reflect.set(window, '__releaseInitialRead', undefined);
      Reflect.set(window, '__initialReadGate', new Promise<void>(resolve => {
        Reflect.set(window, '__releaseInitialRead', resolve);
      }));
    });
    await page.route('**/src/storage.ts*', async route => {
      const response = await route.fetch();
      const body = await response.text();
      const signature = 'export async function loadPhotos() {';
      expect(body).toContain(signature);
      await route.fulfill({ response, body: body.replace(signature,
        `${signature}\nawait window.__initialReadGate;\n${outcome === 'failure' ? 'throw new Error("synthetic unavailable storage");' : ''}`) });
    });
    await page.goto('./#invite=synthetic-invitation');
    await page.reload();
    const manager = page.getByRole('dialog', { name: '공유보관함 관리' });
    await expect(manager.getByRole('button', { name: '시작', exact: true })).toBeDisabled();
    await expect(manager.getByRole('button', { name: '로그인', exact: true })).toBeDisabled();
    expect(authRequests).toEqual([]);
    await page.evaluate(() => Reflect.get(window, '__releaseInitialRead')());
    await expect(manager.getByRole('button', { name: '시작', exact: true })).toBeEnabled();
    if (outcome === 'failure') await expect(manager.getByRole('group', { name: '작업 실패' })).toBeVisible();
    expect(authRequests).toEqual([]);
  });
}

test('local upload rejects MIME disguises and accepts camera files with unspecified MIME', async ({ page }) => {
  await open(page);
  await page.getByLabel('사진 파일 선택').setInputFiles({
    name: 'disguised.jpg', mimeType: 'text/html', buffer: Buffer.from('<script>throw new Error("not a photo")</script>'),
  });
  await expect(page.getByRole('group', { name: '작업 실패' })).toBeVisible();
  await expect(page.getByRole('button', { name: '다시 선택' })).toBeEnabled();
  await expect(cards(page)).toHaveCount(0);
  await upload(page, 'camera.HEIC', Buffer.from('synthetic HEIC original'), '');
  await upload(page, 'camera.png', pixel, 'application/octet-stream');
  await expect(cards(page)).toHaveCount(2);
  await page.reload();
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  await expect(cards(page)).toHaveCount(2);
});

test('entry, empty library and rejected files use actions instead of visible guidance', async ({ page }) => {
  const authRequests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/auth/')) authRequests.push(request.url());
  });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: '보관함', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '시작', exact: true })).toBeVisible();
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
  expect(authRequests).toEqual([]);
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  await expect(page.getByRole('button', { name: '올리기', exact: true }).first()).toBeEnabled();
  await page.getByLabel('사진 파일 선택').setInputFiles({ name: 'bad.html', mimeType: 'text/html', buffer: Buffer.from('<h1>synthetic</h1>') });
  const failure = page.getByRole('group', { name: '작업 실패' });
  await expect(failure).toBeVisible();
  await expect(failure.getByRole('button', { name: '다시 선택', exact: true })).toBeEnabled();
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
  expect(await failure.innerText()).not.toMatch(/지원하는|선택해|실패했|다시 시도해/);
  await expect(page.getByRole('region', { name: '업로드 파일' }).getByRole('button', { name: '올리기', exact: true })).toBeDisabled();
  await expect(failure.getByRole('button', { name: '재시도', exact: true })).toHaveCount(0);
  await upload(page);
  await expect(cards(page)).toHaveCount(1);
  await expect(failure).toHaveCount(0);
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
});

test('selected originals download in one archive without confirming receipt', async ({ page }) => {
  await open(page);
  await upload(page, 'first.png');
  const second = Buffer.concat([pixel, Buffer.from('second synthetic original')]);
  await upload(page, 'second.png', second);
  await expect(cards(page)).toHaveCount(2);
  await page.getByLabel('현재 사진 전체 선택', { exact: true }).check();
  await page.getByRole('button', { name: '선택 다운로드', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '선택 사진 다운로드' });
  const event = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /^일괄 다운로드/ }).click();
  const downloaded = await event;
  expect(downloaded.suggestedFilename()).toMatch(/\.zip$/);
  const archive = await readFile((await downloaded.path())!);
  const originals = new Map<string, Buffer>();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    expect(archive.readUInt16LE(offset + 8)).toBe(0);
    const size = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    originals.set(name, archive.subarray(start, start + size));
    offset = start + size;
  }
  expect(originals.get('first.png')).toEqual(pixel);
  expect(originals.get('second.png')).toEqual(second);
  const receipts = dialog.getByRole('button', { name: '받았음 확인', exact: true });
  await expect(receipts).toHaveCount(2);
  await expect(receipts.nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(receipts.nth(1)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
});
