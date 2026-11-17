import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_SIGNED_OUT_KEY, isAccountSignedOut, logoutAccount, resumeAccount } from '../apps/web/src/server/accountSession.ts';
import { server } from '../apps/web/src/server/index.ts';
import { ServerClient, ServerError } from '../apps/web/src/server/client.ts';

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

test('logout persists suspension without touching identity storage and explicit resume clears it', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = storage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: saved });
  try {
    resumeAccount();
    assert.equal(isAccountSignedOut(), false);
    logoutAccount();
    assert.equal(saved.getItem(ACCOUNT_SIGNED_OUT_KEY), 'true');
    assert.equal(isAccountSignedOut(), true);
    await assert.rejects(server.token(), (error: unknown) => error instanceof ServerError && error.status === 401);
    // A fresh client sees the persisted marker before any key/network work.
    let reads = 0; let calls = 0;
    const fresh = new ServerClient({ base: 'https://example.test', store: { get: async () => { reads++; return undefined; }, put: async () => {} }, isSignedOut: () => saved.getItem(ACCOUNT_SIGNED_OUT_KEY) === 'true', fetch: async () => { calls++; return Response.json({}); } });
    await assert.rejects(fresh.op('phogaem-albums'));
    assert.equal(reads, 0); assert.equal(calls, 0);
    resumeAccount();
    assert.equal(saved.getItem(ACCOUNT_SIGNED_OUT_KEY), null);
    assert.equal(isAccountSignedOut(), false);
  } finally {
    resumeAccount();
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('logout fails closed in current tab even when marker storage is unavailable', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = storage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { ...saved, setItem: () => { throw new Error('blocked'); } } });
  try {
    assert.throws(logoutAccount, /blocked/);
    assert.equal(isAccountSignedOut(), true);
    await assert.rejects(server.token());
  } finally {
    resumeAccount();
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('suspension drains and rejects an old public login response and blocks subsequent adoption', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0; let writes = 0;
  const client = new ServerClient({ base: 'https://example.test', store: { get: async () => undefined, put: async () => { writes++; } }, fetch: async () => { calls++; await held; return Response.json({ access_token: 'late', user_id: 'old', expires_in: 600 }); } });
  const pending = client.postPublic('/auth/passkey/login');
  client.suspendSession(); release();
  await assert.rejects(pending);
  await assert.rejects(client.adoptAccount({ access_token: 'late', user_id: 'old', expires_in: 600 }));
  await assert.rejects(client.completeGoogleAuth('c'.repeat(43), 'v'.repeat(43)));
  await assert.rejects(client.token());
  assert.equal(client.userId, undefined); assert.equal(calls, 1); assert.equal(writes, 0);
});

test('explicit resume reuses a retained device key after logout', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  let writes = 0; let calls = 0;
  const client = new ServerClient({ base: 'https://example.test', store: { get: async () => keys, put: async () => { writes++; } }, fetch: async input => { calls++; return Response.json(String(input).endsWith('/challenge') ? { challenge: 'synthetic' } : { access_token: 'token', user_id: 'same-account', expires_in: 600 }); } });
  assert.equal(await client.token(), 'token');
  client.suspendSession();
  await assert.rejects(client.token());
  assert.equal(calls, 2);
  client.resumeSession();
  assert.equal(await client.token(), 'token');
  assert.equal(client.userId, 'same-account'); assert.equal(writes, 0); assert.equal(calls, 4);
});

test('a cross-tab logout marker blocks even a cached token and a late operation response', async () => {
  let signedOut = false; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const client = new ServerClient({ base: 'https://example.test', isSignedOut: () => signedOut, store: { get: async () => keys, put: async () => {} }, fetch: async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/auth/challenge') return Response.json({ challenge: 'synthetic' });
    if (path === '/auth/token') return Response.json({ access_token: 'cached', user_id: 'same-account', expires_in: 600 });
    await held; return Response.json({ photos: ['private'] });
  } });
  await client.token();
  const pending = client.op('phogaem-albums');
  await new Promise(resolve => setTimeout(resolve, 0));
  signedOut = true; release();
  await assert.rejects(pending);
  await assert.rejects(client.token());
});
