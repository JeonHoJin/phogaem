import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { createHash } from 'node:crypto';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const albumId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000003';
const album = { id: albumId, title: '업로드 검증 여행', createdAt: 1 };
const members = [{ id: userId, name: '나', color: '#c5d6c4' }];
const file = (name: string) => ({ name, mimeType: 'image/png', buffer: pixel });
const photo = (name: string, index: number) => ({
  id: `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`, name,
  type: 'image/png', size: pixel.length, hash: createHash('sha256').update(pixel).digest('hex'), createdAt: index,
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
      const bytes = route.request().postDataBuffer() ?? pixel;
      const uploaded = { ...photo(name, model.photos.length + 1), size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') };
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
    } else if (operation === 'phogaem-push-status') await route.fulfill({ json: { enabled: false, publicKey: null } });
    else throw new Error(`Unexpected synthetic operation: ${operation}`);
  });
  await page.goto('./');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '기기 계정으로 계속', exact: true }).click();
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
    await queue.getByRole('button', { name: '대기열', exact: true }).click();
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
    const completed = page.getByRole('status', { name: '업로드 완료', exact: true });
    await expect(completed.getByLabel('완료 파일', { exact: true })).toHaveText('2/2');
    await expect(completed.getByLabel('완료 용량', { exact: true })).toHaveText(`${pixel.length * 2} B / ${pixel.length * 2} B`);
    await completed.getByRole('button', { name: '업로드 상태 닫기', exact: true }).click();
    await expect(completed).toHaveCount(0);
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

test('a large queue stays collapsed and paginated through failure with every pending file reachable', async ({ page }) => {
  const model = await openShared(page);
  const pending = gate();
  model.upload = async route => { await pending.held; await route.fulfill({ status: 503, json: { error: 'synthetic failure' } }); };
  try {
    await page.getByLabel('사진 파일 선택').setInputFiles(Array.from({ length: 40 }, (_, index) => file(`batch-${index}.png`)));
    const queue = page.getByRole('region', { name: '업로드 파일', exact: true });
    await expect(page.getByRole('status', { name: '사진 업로드 중', exact: true })).toContainText('0/40');
    const toggle = queue.getByRole('button', { name: '대기열', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(queue.locator('.queue-item')).toHaveCount(0);
    await toggle.click();
    await expect(queue.locator('.queue-item')).toHaveCount(32);
    await expect(queue.getByRole('navigation', { name: '대기열 페이지', exact: true })).toContainText('1/2');
    pending.release();
    await expect(page.getByRole('group', { name: '작업 실패', exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: /사진 (준비|업로드|목록 갱신) 중/ })).toHaveCount(0);
    await expect(queue.locator('.queue-item')).toHaveCount(32);
    await queue.getByRole('button', { name: '다음 파일', exact: true }).click();
    await expect(queue.locator('.queue-item')).toHaveCount(8);
    const remove = queue.getByRole('button', { name: 'batch-39.png 대기열에서 제거', exact: true });
    await expect(remove).toBeVisible();
    await remove.click();
    await expect(remove).toHaveCount(0);
    await expect(queue.getByRole('button', { name: '대기열', exact: true })).toContainText('39');
    await expect(page.getByRole('status', { name: '업로드 중단', exact: true }).getByLabel('완료 파일', { exact: true })).toHaveText('0/39');
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
  await page.getByRole('region', { name: '업로드 파일', exact: true }).getByRole('button', { name: '대기열', exact: true }).click();
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
    await expect(page.locator('.batch-status')).toHaveCount(0);
    late.release();
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
    await expect(page.locator('article.photo-card')).toHaveCount(0);
    await expect(page.getByRole('status', { name: /사진 (준비|업로드|목록 갱신) 중/ })).toHaveCount(0);
  } finally { late.release(); denied.release(); }
});


test('four hundred files pause after out-of-order in-flight commits and resume only the remainder', async ({ page }) => {
  const model = await openShared(page);
  const first = gate(); const second = gate(); const resumed = gate();
  const commit = model.upload;
  model.upload = async (route, name) => {
    await (name === 'bulk-0.png' ? first : name === 'bulk-1.png' ? second : resumed).held;
    await commit(route, name);
  };
  try {
    await page.getByLabel('사진 파일 선택').setInputFiles(Array.from({ length: 400 }, (_, index) => file(`bulk-${index}.png`)));
    await expect.poll(() => model.uploads.length).toBe(2);
    const uploading = page.getByRole('status', { name: '사진 업로드 중', exact: true });
    await expect(uploading.getByLabel('완료 파일', { exact: true })).toHaveText('0/400');
    const pause = uploading.getByRole('button', { name: '업로드 일시정지', exact: true });
    await pause.click();
    await expect(pause).toBeDisabled();
    second.release();
    await expect(uploading.getByLabel('완료 파일', { exact: true })).toHaveText('1/400');
    await expect(page.locator('article.photo-card')).toHaveCount(1);
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'true');
    first.release();
    const paused = page.getByRole('status', { name: '업로드 일시정지', exact: true });
    await expect(paused.getByLabel('완료 파일', { exact: true })).toHaveText('2/400');
    await expect(paused.getByLabel('완료 용량', { exact: true })).toContainText(`${pixel.length * 2} B /`);
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
    expect(model.uploads).toEqual(['bulk-0.png', 'bulk-1.png']);
    await expect(page.locator('article.photo-card')).toHaveCount(2);
    await paused.getByRole('button', { name: '업로드 계속', exact: true }).click();
    await expect.poll(() => model.uploads.length).toBe(4);
    expect(model.uploads.slice(2)).toEqual(['bulk-2.png', 'bulk-3.png']);
    await uploading.getByRole('button', { name: '업로드 일시정지', exact: true }).click();
    resumed.release();
    await expect(paused.getByLabel('완료 파일', { exact: true })).toHaveText('4/400');
    await expect(paused.getByLabel('완료 용량', { exact: true })).toContainText(`${pixel.length * 4} B /`);
    await expect(page.locator('article.photo-card')).toHaveCount(4);
    expect(model.uploads).toHaveLength(4);
    await page.getByRole('button', { name: '대기열 비우기', exact: true }).click();
    await expect(page.getByRole('region', { name: '업로드 파일', exact: true })).toHaveCount(0);
    await expect(page.locator('.batch-status')).toHaveCount(0);
    await expect(page.locator('article.photo-card')).toHaveCount(4);
  } finally { first.release(); second.release(); resumed.release(); }
});

test('mobile bulk queue remains bounded and its fixed controls show committed bytes without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const model = await openShared(page);
  const pending = gate();
  const commit = model.upload;
  model.upload = async (route, name) => { await pending.held; await commit(route, name); };
  try {
    await page.getByLabel('사진 파일 선택').setInputFiles(Array.from({ length: 400 }, (_, index) => file(`mobile-${index}-${'long-'.repeat(20)}.png`)));
    await expect.poll(() => model.uploads.length).toBe(2);
    const queue = page.getByRole('region', { name: '업로드 파일', exact: true });
    await expect(queue.locator('.queue-item')).toHaveCount(0);
    await queue.getByRole('button', { name: '대기열', exact: true }).click();
    await expect(queue.locator('.queue-item')).toHaveCount(32);
    expect(await queue.locator('.queue-files').evaluate(element => element.clientHeight)).toBeLessThanOrEqual(280);
    const status = page.getByRole('status', { name: '사진 업로드 중', exact: true });
    await expect(status).toBeInViewport({ ratio: 1 });
    const pause = status.getByRole('button', { name: '업로드 일시정지', exact: true });
    const box = await pause.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('p:visible, [title]')).toHaveCount(0);
    await pause.click(); pending.release();
    const paused = page.getByRole('status', { name: '업로드 일시정지', exact: true });
    await expect(paused.getByLabel('완료 파일', { exact: true })).toHaveText('2/400');
    await expect(paused.getByLabel('완료 용량', { exact: true })).toContainText(`${pixel.length * 2} B /`);
    await queue.getByRole('button', { name: '다음 파일', exact: true }).click();
    await expect(queue.getByRole('navigation', { name: '대기열 페이지', exact: true })).toContainText('2/13');
    const remove = queue.locator('.queue-item').last().getByRole('button', { name: /대기열에서 제거/ });
    await remove.click();
    await expect(paused.getByLabel('완료 파일', { exact: true })).toHaveText('2/399');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.local/bulk-upload-mobile.png', fullPage: true });
    await page.getByRole('button', { name: '대기열 비우기', exact: true }).click();
  } finally { pending.release(); }
});


test('changing the local preview user clears a failed pending batch and its old resume action', async ({ page }) => {
  const authRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/auth/')) authRequests.push(request.url()); });
  await page.goto('./');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  await expect(page.getByRole('heading', { name: '기기 보관함', exact: true })).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('사진 파일 선택').setInputFiles([file('local.png'), { name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') }]);
  await expect(page.getByRole('status', { name: '업로드 중단', exact: true })).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('region', { name: '업로드 파일', exact: true })).toBeVisible();
  await page.getByLabel('미리보기 사용자', { exact: true }).selectOption('mina');
  await expect(page.getByRole('region', { name: '업로드 파일', exact: true })).toHaveCount(0);
  await expect(page.locator('.batch-status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '남은 파일 다시 올리기', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: '작업 실패', exact: true })).toHaveCount(0);
  await expect(page.locator('article.photo-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '올리기', exact: true })).toBeEnabled();
  expect(authRequests).toEqual([]);
});


test('in-flight uploads allow album browsing and selection but keep mutations and source switches locked', async ({ page }) => {
  const model = await openShared(page, 2);
  const pending = gate();
  const commit = model.upload;
  model.upload = async (route, name) => { await pending.held; await commit(route, name); };
  try {
    await page.getByLabel('사진 파일 선택').setInputFiles(file('uploading.png'));
    await expect.poll(() => model.uploads.length).toBe(1);
    await page.getByRole('button', { name: '내 사진', exact: true }).click();
    await expect(page.getByRole('button', { name: '내 사진', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '전체', exact: true }).click();
    await page.getByRole('button', { name: 'existing-0.png 선택', exact: true }).click();
    await expect(page.getByRole('button', { name: 'existing-0.png 선택', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '선택 다운로드', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '휴지통으로 이동', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '휴지통', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '보관함 목록', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '계정', exact: true })).toBeDisabled();
    const density = page.getByLabel('한 줄 사진 수', { exact: true });
    const before = await density.innerText();
    await page.getByRole('button', { name: '사진 확대', exact: true }).click();
    await expect(density).not.toHaveText(before);
    await page.getByRole('button', { name: 'existing-0.png 크게 보기', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: '사진 크게 보기', exact: true });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('button', { name: '이 사진 다운로드', exact: true })).toBeDisabled();
    await expect(viewer.getByRole('button', { name: '이 사진 휴지통으로 이동', exact: true })).toBeDisabled();
    await viewer.getByRole('button', { name: '뷰어 닫기', exact: true }).click();
    pending.release();
    await expect(page.getByRole('status', { name: '업로드 완료', exact: true })).toBeVisible();
    await expect(page.locator('article.photo-card')).toHaveCount(3);
  } finally { pending.release(); }
});

test('reload recovery skips acknowledged bytes only and uploads a changed file with the same name', async ({ page }) => {
  const model = await openShared(page);
  const pending = gate(); const commit = model.upload;
  model.upload = async (route, name) => {
    if (name === 'pending.png') { await pending.held; await route.fulfill({ status: 503, json: { error: 'synthetic interruption' } }); }
    else await commit(route, name);
  };
  try {
    await page.getByLabel('사진 파일 선택').setInputFiles([file('saved.png'), file('pending.png')]);
    await expect(page.locator('article.photo-card')).toHaveCount(1);
    await expect.poll(() => model.uploads.length).toBe(2);
    pending.release();
    await expect(page.getByRole('status', { name: '업로드 중단', exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: album.title, exact: false }).click();
    await expect(page.getByRole('heading', { name: album.title, exact: true })).toBeVisible();
    const recovery = page.getByRole('region', { name: '중단된 업로드', exact: true });
    await expect(recovery).toContainText('1/2');
    model.upload = commit;
    const chooserPromise = page.waitForEvent('filechooser');
    await recovery.getByRole('button', { name: '다시 선택', exact: true }).click();
    const chooser = await chooserPromise;
    const modified = Buffer.concat([pixel, Buffer.from('changed')]);
    await chooser.setFiles([file('saved.png'), { name: 'saved.png', mimeType: 'image/png', buffer: modified }, file('pending.png')]);
    await expect(page.getByRole('status', { name: '업로드 완료', exact: true })).toContainText('3/3');
    expect(model.uploads).toEqual(['saved.png', 'pending.png', 'saved.png', 'pending.png']);
    expect(model.photos.map(value => value.hash)).toContain(createHash('sha256').update(modified).digest('hex'));
    await expect(recovery).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: album.title, exact: false }).click();
    await expect(page.getByRole('heading', { name: album.title, exact: true })).toBeVisible();
    await expect(recovery).toHaveCount(0);
  } finally { pending.release(); }
});

test('invalid files can be excluded as a batch while valid pending originals remain retryable', async ({ page }) => {
  const model = await openShared(page);
  await page.getByLabel('사진 파일 선택').setInputFiles([file('valid.png'), { name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('bad') }, { name: 'bad.html', mimeType: 'text/html', buffer: Buffer.from('bad') }]);
  const queue = page.getByRole('region', { name: '업로드 파일', exact: true });
  await expect(queue.getByRole('button', { name: '다시 올리기', exact: true })).toBeDisabled();
  await queue.getByRole('button', { name: /^제외/ }).click();
  await expect(queue.getByRole('button', { name: '계속', exact: true })).toBeEnabled();
  await queue.getByRole('button', { name: '계속', exact: true }).click();
  await expect(page.getByRole('status', { name: '업로드 완료', exact: true })).toContainText('1/1');
  expect(model.uploads).toEqual(['valid.png']);
});

test('cross-tab logout during recovery hashing cannot restore photos or start uploads', async ({ page, context }) => {
  const model = await openShared(page, 1);
  await page.evaluate(async ({ userId, albumId, hash, size }) => {
    const path = '/phogaem/src/uploadRecovery.ts';
    const recovery = await import(path) as typeof import('../apps/web/src/uploadRecovery.ts');
    recovery.saveUploadRecovery({ userId, albumId }, { version: 1, plannedCount: 2, completed: [{ hash, size, type: 'image/png', count: 1 }] });
  }, { userId, albumId, hash: createHash('sha256').update(pixel).digest('hex'), size: pixel.length });
  await page.reload();
  await page.getByRole('button', { name: album.title, exact: false }).click();
  await expect(page.getByRole('region', { name: '중단된 업로드', exact: true })).toContainText('1/2');
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    Object.assign(window, { recoveryHashStarted: false, recoveryHashFinished: false, releaseRecoveryHash: release });
    File.prototype.arrayBuffer = async function () {
      Object.assign(window, { recoveryHashStarted: true });
      await held;
      const result = await original.call(this);
      Object.assign(window, { recoveryHashFinished: true });
      return result;
    };
  });
  const sibling = await context.newPage();
  try {
    await sibling.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic logout tab</title>' }));
    await sibling.goto('./');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '다시 선택', exact: true }).click();
    await (await chooserPromise).setFiles([file('existing-0.png')]);
    await page.waitForFunction(() => (window as unknown as { recoveryHashStarted: boolean }).recoveryHashStarted);
    await sibling.evaluate(() => localStorage.setItem('phogaem:/phogaem/:signed-out', 'true'));
    await expect(page.getByRole('region', { name: '로그인', exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as { releaseRecoveryHash: () => void }).releaseRecoveryHash());
    await page.waitForFunction(() => (window as unknown as { recoveryHashFinished: boolean }).recoveryHashFinished);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
    await expect(page.locator('article.photo-card')).toHaveCount(0);
    await expect(page.getByRole('region', { name: '업로드 파일', exact: true })).toHaveCount(0);
    await expect(page.getByRole('status', { name: /사진 (준비|업로드|목록 갱신) 중/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '중단된 업로드', exact: true })).toHaveCount(0);
    expect(model.uploads).toEqual([]);
  } finally {
    await page.evaluate(() => (window as unknown as { releaseRecoveryHash: () => void }).releaseRecoveryHash());
    await sibling.close();
  }
});
