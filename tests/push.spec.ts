import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

const albumA = '10000000-0000-4000-8000-000000000001';
const albumB = '10000000-0000-4000-8000-000000000002';
const userA = '10000000-0000-4000-8000-000000000003';
const userB = '10000000-0000-4000-8000-000000000004';
const noticeId = '10000000-0000-4000-8000-000000000005';
const publicKey = Buffer.from([4, ...Array<number>(64).fill(1)]).toString('base64url');
const endpoint = 'https://web.push.apple.com/synthetic-browser';

type PushWindow = Window & { pushMock: { permissionCalls: number; activated: boolean; subscriptions: number; deferred: boolean; resolvePermission?: (value: NotificationPermission) => void } };
async function mockPermission(page: Page, denied = false, deferred = false) {
  await page.addInitScript(({ endpoint, publicKey, denied, deferred }) => {
    const state = { permissionCalls: 0, activated: false, subscriptions: 0, deferred, resolvePermission: undefined as ((value: NotificationPermission) => void) | undefined };
    (window as unknown as PushWindow).pushMock = state;
    const FakeNotification = class {
      static permission = 'default';
      static requestPermission() {
        state.permissionCalls += 1; state.activated = navigator.userActivation.isActive;
        if (deferred) return new Promise<NotificationPermission>(resolve => { state.resolvePermission = resolve; });
        return Promise.resolve(denied ? 'denied' : 'granted');
      }
    };
    Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification });
    let subscription: object | null = null;
    const registration = {
      scope: location.origin + '/phogaem/', active: {},
      pushManager: {
        getSubscription: async () => subscription,
        subscribe: async () => {
          state.subscriptions += 1;
          subscription = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: publicKey, auth: 'AQEBAQEBAQEBAQEBAQEBAQ' } }), unsubscribe: async () => { throw new Error('An album toggle must never unsubscribe the browser'); } };
          return subscription;
        },
      },
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      getRegistration: async () => registration, register: async () => registration, ready: Promise.resolve(registration),
    } });
  }, { endpoint, publicKey, denied, deferred });
}

async function mockBackend(context: BrowserContext) {
  const model = { enabled: new Set<string>(), subscribes: [] as string[], tokens: [] as string[], initialX: '', messageStatus: 200, messageCalls: 0, networkFailure: false };
  await context.route('**/auth/**', async route => {
    if (new URL(route.request().url()).pathname === '/auth/challenge') return route.fulfill({ json: { challenge: 'synthetic-challenge', expires_in: 120 } });
    const body = route.request().postDataJSON() as { public_key: { x: string } };
    if (!model.initialX) model.initialX = body.public_key.x;
    const user = body.public_key.x === model.initialX ? userA : userB;
    model.tokens.push(user);
    return route.fulfill({ json: { access_token: `token-${user}`, expires_in: 600, user_id: user } });
  });
  await context.route('**/op/phogaem-*/v1*', async route => {
    const url = new URL(route.request().url()); const op = url.pathname.split('/')[2];
    const payload = route.request().method() === 'POST' ? route.request().postDataJSON() as Record<string, unknown> : {};
    if (op === 'phogaem-albums') return route.fulfill({ json: { userId: userA, albums: [{ id: albumA, title: '알림 여행 1', createdAt: 1 }, { id: albumB, title: '알림 여행 2', createdAt: 1 }] } });
    if (op === 'phogaem-album-get') {
      const id = url.searchParams.get('albumId');
      return route.fulfill({ json: { album: { id, title: id === albumA ? '알림 여행 1' : '알림 여행 2', createdAt: 1 }, members: [{ id: userA, nickname: '나', name: '나', color: '#ccc' }], photos: [] } });
    }
    if (op === 'phogaem-similar-get') return route.fulfill({ json: { groups: [], pending: 0, failed: 0, analyzed: 0 } });
    if (op === 'phogaem-push-status') return route.fulfill({ json: { enabled: model.enabled.has(String(payload.albumId)), publicKey } });
    if (op === 'phogaem-push-subscribe') { model.subscribes.push(String(payload.albumId)); model.enabled.add(String(payload.albumId)); return route.fulfill({ json: { enabled: true } }); }
    if (op === 'phogaem-push-unsubscribe') { expect(payload.endpoint).toBe(endpoint); model.enabled.delete(String(payload.albumId)); return route.fulfill({ json: { enabled: false } }); }
    if (op === 'phogaem-push-message') {
      model.messageCalls += 1;
      if (model.networkFailure) return route.abort('internetdisconnected');
      const status = route.request().headers().authorization === `Bearer token-${userA}` ? model.messageStatus : 403;
      return route.fulfill({ status, json: status === 200 ? { id: payload.id, albumId: albumA, title: '비공개 여행', body: '친구님이 사진 24장을 추가했어요' } : { error: 'not found' } });
    }
    throw new Error(`Unexpected synthetic operation ${op}`);
  });
  return model;
}
async function openAlbum(page: Page) {
  await page.goto('./');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await page.getByRole('button', { name: '알림 여행 1', exact: false }).click();
}

test('bell asks permission only on click and each album keeps its own preference', async ({ page, context }) => {
  await mockPermission(page); const model = await mockBackend(context); await openAlbum(page);
  await expect(page.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as PushWindow).pushMock.permissionCalls)).toBe(0);
  await page.getByRole('button', { name: '알림 켜기' }).click();
  await expect(page.getByRole('button', { name: '알림 끄기' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as unknown as PushWindow).pushMock.activated)).toBe(true);
  await page.getByRole('combobox', { name: '공유보관함 선택' }).selectOption(albumB);
  await expect(page.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
  await page.getByRole('button', { name: '알림 켜기' }).click();
  await expect(page.getByRole('button', { name: '알림 끄기' })).toBeVisible();
  await page.getByRole('combobox', { name: '공유보관함 선택' }).selectOption(albumA);
  await page.getByRole('button', { name: '알림 끄기' }).click();
  await expect(page.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
  expect(model.enabled.has(albumA)).toBe(false); expect(model.enabled.has(albumB)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as PushWindow).pushMock.subscriptions)).toBe(1);
  expect(await page.locator('p:visible,[title]').count()).toBe(0);
});

test('stale permission dialogs cannot register the album being left', async ({ page, context }) => {
  await mockPermission(page, false, true); const model = await mockBackend(context); await openAlbum(page);
  await page.getByRole('button', { name: '알림 켜기' }).click();
  await page.getByRole('combobox', { name: '공유보관함 선택' }).selectOption(albumB);
  await page.evaluate(() => (window as unknown as PushWindow).pushMock.resolvePermission?.('granted'));
  await expect(page.getByRole('heading', { name: '알림 여행 2' })).toBeVisible();
  expect(model.subscribes).toEqual([]);
});

test('denied permission creates no subscription and uses no visible guidance', async ({ page, context }) => {
  await mockPermission(page, true); const model = await mockBackend(context); await openAlbum(page);
  await page.getByRole('button', { name: '알림 켜기' }).click();
  await expect(page.getByRole('button', { name: '알림 켜기' })).toBeEnabled();
  expect(model.subscribes).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as PushWindow).pushMock.subscriptions)).toBe(0);
  expect(await page.locator('p:visible,[title]').count()).toBe(0);
});

test('notification deep links open the authorized album after ordinary account resume', async ({ page, context }) => {
  await mockPermission(page); await mockBackend(context);
  await page.goto(`./#album=${albumB}`);
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await expect(page.getByRole('heading', { name: '알림 여행 2' })).toBeVisible();
});

test('real built worker always displays a generic fallback and never upgrades a switched account', async ({ page, context }) => {
  await context.grantPermissions(['notifications']); const model = await mockBackend(context);
  const cdp = await context.newCDPSession(page); let registrationId = '';
  cdp.on('ServiceWorker.workerRegistrationUpdated', event => {
    for (const registration of event.registrations) if (registration.scopeURL.endsWith('/phogaem/')) registrationId = registration.registrationId;
  });
  await cdp.send('ServiceWorker.enable');
  await openAlbum(page);
  await page.evaluate(async () => { await navigator.serviceWorker.register('/phogaem/sw.js', { type: 'module', scope: '/phogaem/' }); await navigator.serviceWorker.ready; });
  await expect.poll(() => registrationId).not.toBe('');
  const worker = context.serviceWorkers()[0]!;
  const notices = () => worker.evaluate(async () => (await (self as unknown as ServiceWorkerGlobalScope).registration.getNotifications()).map(n => ({ title: n.title, body: n.body, tag: n.tag })));
  const send = async (id: string) => cdp.send('ServiceWorker.deliverPushMessage', { origin: 'http://127.0.0.1:5176', registrationId, data: JSON.stringify({ id, albumId: albumA, recipientId: userA }) });
  await send(noticeId);
  await expect.poll(async () => (await notices()).some(n => n.title === '비공개 여행')).toBe(true);
  await page.evaluate(async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('phogaem-keys:/phogaem/', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('device', 'readwrite'); tx.objectStore('device').put(keys, 'default'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  });
  await send('10000000-0000-4000-8000-000000000006');
  await expect.poll(async () => (await notices()).map(n => n.title)).toEqual(['포갬']);
  await expect.poll(() => model.tokens.includes(userB)).toBe(true);
  expect((await notices())[0]!.body).toBe('새 사진');
  model.networkFailure = true;
  const previousCalls = model.messageCalls;
  await send('10000000-0000-4000-8000-000000000007');
  await expect.poll(() => model.messageCalls).toBeGreaterThanOrEqual(previousCalls + 2);
  await expect.poll(async () => (await notices()).map(n => n.title)).toEqual(['포갬']);
  expect((await notices())[0]!.tag).toBe(`phogaem:${albumA}`);
});
