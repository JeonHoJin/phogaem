import { test, expect } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000003';
const pendingKey = 'phogaem:/phogaem/:google-pending';

test('Google redirect completes signed login and returns to the invited album', async ({ page }) => {
  const calls: string[] = [];
  let start: Record<string, string>;
  let proof: Record<string, unknown>;
  await page.route('**/auth/**', async route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === '/auth/google/start') {
      start = route.request().postDataJSON();
      expect(route.request().headers().authorization).toBeUndefined();
      expect(start.mode).toBe('login');
      expect(start.return_url).toBe('http://127.0.0.1:5174/phogaem/');
      await route.fulfill({ json: { authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?synthetic=1', expires_in: 600 } });
    } else if (path === '/auth/google/complete') {
      proof = route.request().postDataJSON();
      expect(proof.code).toBe('c'.repeat(43));
      const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(proof.verifier)))).toString('base64url');
      expect(expected).toBe(start.code_challenge);
      const key = await crypto.subtle.importKey('jwk', proof.public_key as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(String(proof.signature), 'base64url'), new TextEncoder().encode(`mlhops-google-complete-v1:${proof.code}:${proof.verifier}`))).toBe(true);
      await route.fulfill({ json: { access_token: 'synthetic-google-token', expires_in: 600, user_id: userId } });
    } else throw new Error(`Unexpected auth request ${path}`);
  });
  await page.route('https://accounts.google.com/**', route => route.fulfill({ contentType: 'text/html', body: `<script>location.replace('http://127.0.0.1:5174/phogaem/#google_code=${'c'.repeat(43)}&google_state=${start.client_state}')</script>` }));
  await page.route('**/op/phogaem-*/v1*', async route => {
    const operation = new URL(route.request().url()).pathname.split('/')[2];
    expect(route.request().headers().authorization).toBe('Bearer synthetic-google-token');
    if (operation === 'phogaem-albums') await route.fulfill({ json: { userId, albums: [] } });
    else if (operation === 'phogaem-invite-join') {
      expect(route.request().postDataJSON().token).toBe('test-invite');
      await route.fulfill({ json: { album: { id: 'album-trip', title: '구글 여행', createdAt: 1 } } });
    } else if (operation === 'phogaem-album-get') await route.fulfill({ json: { album: { id: 'album-trip', title: '구글 여행', createdAt: 1 }, members: [{ id: userId, nickname: '나', name: '나', color: '#ccc' }], photos: [] } });
    else if (operation === 'phogaem-similar-get') await route.fulfill({ json: { groups: [], pending: 0, failed: 0, analyzed: 0 } });
    else throw new Error(`Unexpected operation ${operation}`);
  });
  await page.goto('./#invite=test-invite');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  expect(calls).toEqual([]);
  await page.getByRole('dialog').getByRole('button', { name: 'Google로 로그인', exact: true }).click();
  await expect(page.getByRole('heading', { name: '구글 여행' })).toBeVisible();
  expect(calls).toEqual(['/auth/google/start', '/auth/google/complete']);
  expect(await page.evaluate(key => sessionStorage.getItem(key), pendingKey)).toBeNull();
  expect(page.url()).not.toContain('google_code');
  expect(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).not.toContain('synthetic-google-token');
});

test('mismatched callback state makes no auth requests and retains the existing device key', async ({ page }) => {
  let requests = 0;
  await page.route('**/auth/**', async route => { requests += 1; await route.abort(); });
  await page.goto('./');
  await page.evaluate(async key => {
    sessionStorage.setItem(key, JSON.stringify({ state: 's'.repeat(43), verifier: 'v'.repeat(43), mode: 'login', deviceFingerprint: null, returnHash: '#invite=trip', createdAt: Date.now() }));
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('phogaem-keys:/phogaem/', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('device');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('device', 'readwrite');
      tx.objectStore('device').put(pair, 'default');
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, pendingKey);
  const before = await page.evaluate(async () => {
    const { indexedDbKeyStore } = await import(String('/phogaem/src/server/index.ts'));
    return crypto.subtle.exportKey('jwk', (await indexedDbKeyStore.get())!.publicKey);
  });
  await page.goto(`./#google_code=${'c'.repeat(43)}&google_state=${'x'.repeat(43)}`);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Google로 로그인' })).toBeVisible();
  expect(requests).toBe(0);
  expect(page.url()).not.toContain('google_code');
  const after = await page.evaluate(async () => {
    const { indexedDbKeyStore } = await import(String('/phogaem/src/server/index.ts'));
    return crypto.subtle.exportKey('jwk', (await indexedDbKeyStore.get())!.publicKey);
  });
  expect(after).toEqual(before);
});

test('cancelled login restores invitation without resuming the previous account', async ({ page }) => {
  const calls: string[] = [];
  await page.route('**/auth/**', async route => { calls.push(route.request().url()); await route.abort(); });
  await page.route('**/op/**', async route => { calls.push(route.request().url()); await route.abort(); });
  await page.goto('./');
  await page.evaluate(async key => {
    const { indexedDbKeyStore } = await import(String('/phogaem/src/server/index.ts'));
    await indexedDbKeyStore.put(await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']));
    localStorage.setItem('phogaem:/phogaem/:resume-shared', '1');
    sessionStorage.setItem(key, JSON.stringify({ state: 's'.repeat(43), verifier: 'v'.repeat(43), mode: 'login', deviceFingerprint: null, returnHash: '#invite=trip', createdAt: Date.now() }));
  }, pendingKey);
  await page.goto(`./?return=cancelled#google_error=cancelled&google_state=${'s'.repeat(43)}`);
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Google로 로그인' })).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  expect(calls).toEqual([]);
  expect(new URL(page.url()).hash).toBe('#invite=trip');
  expect(await page.evaluate(key => sessionStorage.getItem(key), pendingKey)).toBeNull();
});
