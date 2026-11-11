import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64url, ServerError } from '../apps/web/src/server/client.ts';
import { server } from '../apps/web/src/server/index.ts';
import { ApprovalRequired } from '../apps/web/src/server/api.ts';
import {
  currentPushSubscription, enableAlbumPush, fetchPushMessage, getAlbumPushStatus,
  pushSupported, subscribeAlbumPush, unsubscribeAlbumPush, PushEndpointConflict,
} from '../apps/web/src/server/push.ts';

const album = '10000000-0000-4000-8000-000000000001';
const endpoint = 'https://web.push.apple.com/synthetic-device';
const publicBytes = new Uint8Array(65); publicBytes.fill(7); publicBytes[0] = 4;
const publicKey = base64url(publicBytes);
const auth = base64url(new Uint8Array(16).fill(8));

function subscription(address = endpoint): PushSubscription {
  return { endpoint: address, toJSON: () => ({ endpoint: address, expirationTime: null, keys: { p256dh: publicKey, auth } }) } as unknown as PushSubscription;
}

async function withOperation(run: (calls: Array<{ name: string; body: unknown }>) => Promise<void>, respond: (name: string, body: unknown) => Response = name => Response.json(
  name.endsWith('-status') ? { enabled: false, publicKey } : { enabled: !name.endsWith('-unsubscribe') },
)) {
  const old = server.op;
  const calls: Array<{ name: string; body: unknown }> = [];
  server.op = async (name, init = {}) => {
    assert.equal(init.version, 'v1'); assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { 'content-type': 'application/json' });
    assert.equal(init.query, undefined, 'push capabilities must never enter query strings');
    const body: unknown = JSON.parse(String(init.body)); calls.push({ name, body });
    return respond(name, body);
  };
  try { await run(calls); } finally { server.op = old; }
}

interface FakeBrowser {
  calls: string[];
  registration: ServiceWorkerRegistration;
  permission: Promise<NotificationPermission>;
  current: PushSubscription | null;
  nextEndpoint?: string;
}
async function withBrowser(run: (browser: FakeBrowser) => Promise<void>, options: {
  permission?: Promise<NotificationPermission>; ios?: boolean; standalone?: boolean;
} = {}) {
  const descriptors = new Map(['window', 'navigator', 'location', 'Notification'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const browser = { calls: [], permission: options.permission ?? Promise.resolve('granted'), current: null } as unknown as FakeBrowser;
  browser.registration = {
    active: {}, scope: 'https://jeonhojin.github.io/phogaem/',
    pushManager: {
      getSubscription: async () => { browser.calls.push('get-subscription'); return browser.current; },
      subscribe: async (init: PushSubscriptionOptionsInit) => {
        browser.calls.push('subscribe'); assert.equal(init.userVisibleOnly, true);
        assert.deepEqual(new Uint8Array(init.applicationServerKey as ArrayBuffer), publicBytes);
        browser.current = subscription(browser.nextEndpoint); return browser.current;
      },
    },
  } as unknown as ServiceWorkerRegistration;
  const notification = { permission: 'default', requestPermission: () => { browser.calls.push('permission'); return browser.permission; } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    isSecureContext: true, PushManager: function () {}, Notification: notification,
    matchMedia: () => ({ matches: options.standalone ?? false }),
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    userAgent: options.ios ? 'iPhone' : 'Chrome', platform: options.ios ? 'iPhone' : 'MacIntel', maxTouchPoints: 0,
    serviceWorker: {
      getRegistration: async (scope: string) => { browser.calls.push('get-registration'); assert.equal(scope, browser.registration.scope); return browser.registration; },
      register: async (url: string, init: RegistrationOptions) => {
        browser.calls.push('register'); assert.equal(url, 'https://jeonhojin.github.io/phogaem/sw.js');
        assert.deepEqual(init, { type: 'module', scope: '/phogaem/', updateViaCache: 'none' });
        return browser.registration;
      },
      ready: Promise.resolve(browser.registration),
    },
  } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://jeonhojin.github.io' } });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: notification });
  try { await run(browser); } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test('push status is lazy until requested and carries only the selected album and browser in a POST body', async () => {
  await withOperation(async calls => {
    assert.deepEqual(calls, []);
    assert.deepEqual(await getAlbumPushStatus(album), { enabled: false, publicKey });
    await getAlbumPushStatus(album, endpoint);
    assert.deepEqual(calls, [
      { name: 'phogaem-push-status', body: { albumId: album } },
      { name: 'phogaem-push-status', body: { albumId: album, endpoint } },
    ]);
  });
});

test('invalid push capabilities and malformed responses are rejected without accepting permissive state', async () => {
  await withOperation(async calls => {
    await assert.rejects(getAlbumPushStatus(album, 'https://user:pass@web.push.apple.com/secret'), ServerError);
    await assert.rejects(subscribeAlbumPush(album, { toJSON: () => ({ endpoint, keys: { p256dh: 'bad', auth } }) } as unknown as PushSubscription), ServerError);
    assert.equal(calls.length, 0);
  });
  for (const body of [null, {}, { enabled: 'yes', publicKey }, { enabled: false, publicKey: 'bad' }]) {
    await withOperation(async () => { await assert.rejects(getAlbumPushStatus(album), ServerError); }, () => Response.json(body));
  }
});

test('approval denial retains the exact failure type; foreign-account conflicts remain typed', async () => {
  await withOperation(async () => { await assert.rejects(getAlbumPushStatus(album), ApprovalRequired); }, () => Response.json({ error: 'approval required' }, { status: 403 }));
  await withOperation(async () => {
    await assert.rejects(subscribeAlbumPush(album, subscription()), error => error instanceof ServerError && error.status === 409);
  }, () => Response.json({ error: 'endpoint conflict' }, { status: 409 }));
});

test('permission is requested in the click stack and only the selected album is subscribed', async () => {
  await withBrowser(async browser => withOperation(async calls => {
    const pending = enableAlbumPush(album, publicKey, () => true);
    assert.deepEqual(browser.calls, ['permission'], 'permission must precede any async registration');
    await pending;
    assert.deepEqual(browser.calls, ['permission', 'register', 'get-subscription', 'subscribe']);
    assert.deepEqual(calls, [{ name: 'phogaem-push-subscribe', body: { albumId: album, subscription: { endpoint, keys: { p256dh: publicKey, auth } } } }]);
  }));
});

test('changing album or account while permission is open cannot subscribe the old album', async () => {
  let grant!: (value: NotificationPermission) => void;
  const permission = new Promise<NotificationPermission>(resolve => { grant = resolve; });
  await withBrowser(async browser => withOperation(async calls => {
    let current = true;
    const pending = enableAlbumPush(album, publicKey, () => current);
    current = false; grant('granted');
    await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError');
    assert.deepEqual(browser.calls, ['permission']); assert.deepEqual(calls, []);
  }), { permission });
});

test('denied permission never registers a worker or enables an album', async () => {
  await withBrowser(async browser => withOperation(async calls => {
    await assert.rejects(enableAlbumPush(album, publicKey, () => true));
    assert.deepEqual(browser.calls, ['permission']);
    assert.deepEqual(calls, []);
  }), { permission: Promise.resolve('denied') });
});

test('another album reuses the browser subscription without recreating or removing it', async () => {
  await withBrowser(async browser => withOperation(async calls => {
    browser.current = subscription();
    const enabled = await enableAlbumPush(album, publicKey, () => true);
    assert.equal(enabled, browser.current);
    assert.deepEqual(browser.calls, ['permission', 'register', 'get-subscription']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, 'phogaem-push-subscribe');
  }));
});

test('an explicit enable replaces a former account endpoint only after an ownership conflict', async () => {
  const freshEndpoint = 'https://web.push.apple.com/synthetic-new-account';
  await withBrowser(async browser => withOperation(async calls => {
    const old = subscription();
    old.unsubscribe = async () => { browser.calls.push('unsubscribe'); browser.current = null; return true; };
    browser.current = old; browser.nextEndpoint = freshEndpoint;
    const fresh = await enableAlbumPush(album, publicKey, () => true);
    assert.equal(fresh.endpoint, freshEndpoint);
    assert.deepEqual(browser.calls, ['permission', 'register', 'get-subscription', 'unsubscribe', 'subscribe']);
    assert.deepEqual(calls.map(call => call.body), [
      { albumId: album, subscription: { endpoint, keys: { p256dh: publicKey, auth } } },
      { albumId: album, subscription: { endpoint: freshEndpoint, keys: { p256dh: publicKey, auth } } },
    ]);
  }, (_name, body) => {
    const submitted = body as { subscription: { endpoint: string } };
    return submitted.subscription.endpoint === endpoint
      ? Response.json({ error: 'push endpoint belongs to another account' }, { status: 409 })
      : Response.json({ enabled: true });
  }));
});

test('a stale ownership rejection cannot remove the browser subscription', async () => {
  let current = true;
  await withBrowser(async browser => withOperation(async calls => {
    const old = subscription();
    old.unsubscribe = async () => { browser.calls.push('unsubscribe'); return true; };
    browser.current = old;
    await assert.rejects(enableAlbumPush(album, publicKey, () => current), error => error instanceof DOMException && error.name === 'AbortError');
    assert.deepEqual(browser.calls, ['permission', 'register', 'get-subscription']);
    assert.equal(calls.length, 1);
  }, () => {
    current = false;
    return Response.json({ error: 'push endpoint belongs to another account' }, { status: 409 });
  }));
});

test('device limits, generic conflicts and service failures never rotate subscriptions', async () => {
  for (const failure of [
    { status: 409, error: 'push device limit reached' }, { status: 409, error: 'conflict' },
    { status: 503, error: 'push endpoint belongs to another account' },
  ]) {
    await withBrowser(async browser => withOperation(async calls => {
      const old = subscription();
      old.unsubscribe = async () => { browser.calls.push('unsubscribe'); return true; };
      browser.current = old;
      await assert.rejects(enableAlbumPush(album, publicKey, () => true), ServerError);
      assert.deepEqual(browser.calls, ['permission', 'register', 'get-subscription']);
      assert.equal(calls.length, 1);
    }, () => Response.json({ error: failure.error }, { status: failure.status })));
  }
});

test('endpoint rotation retries once and never reassigns a conflicting replacement', async () => {
  await withBrowser(async browser => withOperation(async calls => {
    const old = subscription();
    old.unsubscribe = async () => { browser.calls.push('unsubscribe'); browser.current = null; return true; };
    browser.current = old; browser.nextEndpoint = 'https://web.push.apple.com/replacement';
    await assert.rejects(enableAlbumPush(album, publicKey, () => true), PushEndpointConflict);
    assert.equal(browser.calls.filter(call => call === 'unsubscribe').length, 1);
    assert.equal(calls.length, 2);
  }, () => Response.json({ error: 'push endpoint belongs to another account' }, { status: 409 })));
});

test('reading settings never asks permission; muting one album never unsubscribes the browser', async () => {
  await withBrowser(async browser => withOperation(async calls => {
    browser.current = subscription();
    assert.equal(await currentPushSubscription(), browser.current);
    await unsubscribeAlbumPush(album, endpoint);
    assert.deepEqual(browser.calls, ['get-registration', 'get-subscription']);
    assert.deepEqual(calls, [{ name: 'phogaem-push-unsubscribe', body: { albumId: album, endpoint } }]);
  }));
});

test('iOS offers push only inside its installed standalone web app', async () => {
  await withBrowser(async () => { assert.equal(pushSupported(), false); }, { ios: true });
  await withBrowser(async () => { assert.equal(pushSupported(), true); }, { ios: true, standalone: true });
});

test('service worker message reads bind the requested ID and reject unbounded or mismatched content', async () => {
  const id = '20000000-0000-4000-8000-000000000001';
  const message = { id, albumId: album, title: '여행', body: '친구님이 사진 3장을 추가했어요' };
  await withOperation(async calls => {
    assert.deepEqual(await fetchPushMessage(id), message);
    assert.deepEqual(calls, [{ name: 'phogaem-push-message', body: { id } }]);
  }, () => Response.json(message));
  for (const invalid of [{ ...message, id: 'different' }, { ...message, body: 'a'.repeat(501) }, { ...message, albumId: '<bad>' }]) {
    await withOperation(async () => { await assert.rejects(fetchPushMessage(id), ServerError); }, () => Response.json(invalid));
  }
});
