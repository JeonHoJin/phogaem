import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const albumId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000003';
const album = { id: albumId, title: '업로드 검증 여행', createdAt: 1 };
const members = [{ id: userId, name: '나', color: '#c5d6c4' }];
const file = (name: string) => ({ name, mimeType: 'image/png', buffer: pixel });
const photo = (name: string, index: number) => ({
  id: `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`, name,
  type: 'image/png', size: pixel.length, hash: `synthetic-${index}`, createdAt: index,
  contributors: [userId], requestedBy: [], receivedBy: [], importCount: 1,
});
function gate() {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  return { held, release };
}

async function openShared(page: Page, initialCount = 0) {
  const model = {
    photos: Array.from({ length: initialCount }, (_, index) => photo(`existing-${index}.png`, index)),
    uploads: [] as string[],
    upload: async (route: Route, name: string) => {
      const uploaded = photo(name, model.photos.length + 1);
      model.photos.push(uploaded);
      await route.fulfill({ json: { added: true, photo: uploaded } });
    },
    metadata: async () => {},
  };
  await page.route('**/auth/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/token')
    ? { access_token: 'synthetic-token', expires_in: 600, user_id: userId }
    : { challenge: 'synthetic-challenge' } }));
  await page.route('**/op/phogaem-*/v1*', async route => {
    const url = new URL(route.request().url());
    const operation = url.pathname.split('/')[2];
    if (operation === 'phogaem-albums') await route.fulfill({ json: { userId, albums: [album] } });
    else if (operation === 'phogaem-album-get') {
      await model.metadata();
      await route.fulfill({ json: { album, members, photos: model.photos } });
    } else if (operation === 'phogaem-similar-get') await route.fulfill({ json: { groups: [], pending: 0, failed: 0, analyzed: 0 } });
    else if (operation === 'phogaem-thumbnail-get' || operation === 'phogaem-photo-get') await route.fulfill({ contentType: 'image/png', body: pixel });
    else if (operation === 'phogaem-photo-upload') {
      const name = url.searchParams.get('name')!;
      model.uploads.push(name);
      await model.upload(route, name);
    } else throw new Error(`Unexpected synthetic operation: ${operation}`);
  });
  await page.goto('./');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await page.getByRole('button', { name: album.title, exact: false }).click();
  await expect(page.getByRole('heading', { name: album.title, exact: true })).toBeVisible();
  return model;
}

test('file selection paints preparation feedback before enumerating the FileList', async ({ page }) => {
  await page.addInitScript(() => {
    const observations: Array<{ visible: boolean; frame: boolean; count: string | null }> = [];
    Object.assign(window, { uploadFileReads: observations });
    let armed = false;
    let frame = false;
    document.addEventListener('change', event => {
      if (event.target instanceof HTMLInputElement && event.target.type === 'file') armed = true;
    }, true);
    new MutationObserver(() => {
      if (document.querySelector('[role="status"][aria-label="사진 준비 중"]')) requestAnimationFrame(() => { frame = true; });
    }).observe(document, { subtree: true, childList: true, attributes: true });
    const record = () => {
      if (!armed) return;
      const status = document.querySelector<HTMLElement>('[role="status"][aria-label="사진 준비 중"]');
      observations.push({ visible: !!status && status.getBoundingClientRect().height > 0, frame, count: status?.textContent ?? null });
    };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')!;
    Object.defineProperty(HTMLInputElement.prototype, 'files', { ...descriptor, get() {
      const files = descriptor.get!.call(this) as FileList | null;
      if (!files) return files;
      return new Proxy(files, { get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) record();
        if (key === Symbol.iterator) return function* () { for (const entry of target) { record(); yield entry; } };
        if (key === 'item') return (index: number) => { record(); return target.item(index); };
        return Reflect.get(target, key, target);
      } });
    } });
  });
  const model = await openShared(page);
  const pending = gate();
  model.upload = async route => { await pending.held; await route.fulfill({ status: 503, json: { error: 'synthetic failure' } }); };
  try {
    await page.getByLabel('사진 파일 선택').setInputFiles([file('first.png'), file('second.png')]);
    await expect(page.getByRole('status', { name: '사진 업로드 중', exact: true })).toContainText('0/2');
    const reads = await page.evaluate(() => (window as unknown as { uploadFileReads: Array<{ visible: boolean; frame: boolean; count: string }> }).uploadFileReads);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every(read => read.visible && read.frame && read.count.includes('0/2'))).toBe(true);
    await expect(page.locator('p:visible, [title]')).toHaveCount(0);
  } finally { pending.release(); }
});

test('parallel completion updates feedback immediately and keeps N/N visible until metadata finishes', async ({ page }) => {
  const model = await openShared(page);
  const first = gate();
  const second = gate();
  const metadata = gate();
  let finalRead = false;
  const commit = model.upload;
  model.upload = async (route, name) => { await (name === 'first.png' ? first : second).held; await commit(route, name); };
  model.metadata = async () => { finalRead = true; await metadata.held; };
  try {
    await page.getByLabel('사진 파일 선택').setInputFiles([file('first.png'), file('second.png')]);
    await expect.poll(() => model.uploads.length).toBe(2);
    await expect(page.getByRole('status', { name: '사진 업로드 중', exact: true })).toContainText('0/2');
    second.release();
    await expect(page.getByRole('status', { name: '사진 업로드 중', exact: true })).toContainText('1/2');
    await expect(page.locator('article.photo-card')).toHaveCount(1);
    const queue = page.getByRole('region', { name: '업로드 파일', exact: true });
    await expect(queue).toContainText('first.png');
    await expect(queue).not.toContainText('second.png');
    expect(finalRead).toBe(false);
    first.release();
    await expect.poll(() => finalRead).toBe(true);
    await expect(page.getByRole('status', { name: '사진 목록 갱신 중', exact: true })).toContainText('2/2');
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'true');
    metadata.release();
    await expect(page.getByRole('status', { name: /사진 (준비|업로드|목록 갱신) 중/ })).toHaveCount(0);
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('article.photo-card')).toHaveCount(2);
  } finally { first.release(); second.release(); metadata.release(); }
});

test('upload feedback stays inside the viewport when selected from a scrolled gallery', async ({ page }) => {
  const model = await openShared(page, 60);
  const pending = gate();
  model.upload = async route => { await pending.held; await route.fulfill({ status: 503, json: { error: 'synthetic failure' } }); };
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  try {
    await page.getByLabel('사진 파일 선택').setInputFiles(file('scrolled.png'));
    const status = page.getByRole('status', { name: '사진 업로드 중', exact: true });
    await expect(status).toContainText('0/1');
    await expect(status).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  } finally { pending.release(); }
});

test('selection still completes when animation frames stop firing', async ({ page }) => {
  const model = await openShared(page);
  // Background tabs can suspend RAF entirely. Keep real timers and networking so
  // this proves the preparation yield has a fallback instead of stalling forever.
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await page.getByLabel('사진 파일 선택').setInputFiles(file('background.png'));
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('status', { name: /사진 (준비|업로드|목록 갱신) 중/ })).toHaveCount(0);
  expect(model.uploads).toEqual(['background.png']);
});

test('a large busy queue is bounded and every uncommitted file becomes removable after failure', async ({ page }) => {
  const model = await openShared(page);
  const pending = gate();
  model.upload = async route => { await pending.held; await route.fulfill({ status: 503, json: { error: 'synthetic failure' } }); };
  try {
    await page.getByLabel('사진 파일 선택').setInputFiles(Array.from({ length: 40 }, (_, index) => file(`batch-${index}.png`)));
    const queue = page.getByRole('region', { name: '업로드 파일', exact: true });
    await expect(page.getByRole('status', { name: '사진 업로드 중', exact: true })).toContainText('0/40');
    await expect(queue.locator('.queue-item')).toHaveCount(32);
    await expect(queue.getByLabel('나머지 파일', { exact: true })).toHaveText('+8');
    pending.release();
    await expect(page.getByRole('group', { name: '작업 실패', exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: /사진 (준비|업로드|목록 갱신) 중/ })).toHaveCount(0);
    await expect(queue.locator('.queue-item')).toHaveCount(40);
    await expect(queue.getByRole('button', { name: 'batch-39.png 대기열에서 제거', exact: true })).toBeVisible();
    await expect(page.locator('article.photo-card')).toHaveCount(0);
    expect(model.uploads.length).toBeLessThanOrEqual(2);
  } finally { pending.release(); }
});

test('invalid mixed selection clears preparation and rejects the whole batch before any write', async ({ page }) => {
  const model = await openShared(page);
  await page.getByLabel('사진 파일 선택').setInputFiles([file('valid.png'), { name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') }]);
  await expect(page.getByRole('group', { name: '작업 실패', exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: /사진 (준비|업로드|목록 갱신) 중/ })).toHaveCount(0);
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  expect(model.uploads).toEqual([]);
  await expect(page.getByRole('button', { name: 'invalid.txt 대기열에서 제거', exact: true })).toBeVisible();
});

test('upload approval denial clears feedback immediately and late in-flight success cannot restore protected photos', async ({ page }) => {
  const model = await openShared(page, 1);
  const late = gate();
  const denied = gate();
  const commit = model.upload;
  model.upload = async (route, name) => {
    if (name === 'late.png') { await late.held; await commit(route, name); }
    else { await denied.held; await route.fulfill({ status: 403, json: { error: 'approval required' } }); }
  };
  try {
    await page.getByLabel('사진 파일 선택').setInputFiles([file('late.png'), file('denied.png')]);
    await expect.poll(() => model.uploads.length).toBe(2);
    denied.release();
    await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: /사진 (준비|업로드|목록 갱신) 중/ })).toHaveCount(0);
    await expect(page.locator('article.photo-card')).toHaveCount(0);
    await expect(page.getByRole('region', { name: '업로드 파일', exact: true })).toHaveCount(0);
    late.release();
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
    await expect(page.locator('article.photo-card')).toHaveCount(0);
    await expect(page.getByRole('status', { name: /사진 (준비|업로드|목록 갱신) 중/ })).toHaveCount(0);
  } finally { late.release(); denied.release(); }
});
