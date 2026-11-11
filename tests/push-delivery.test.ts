import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverPush } from '../apps/web/src/pushDelivery.ts';
import { incomingPush, albumNotification, notificationAlbum, notificationTarget } from '../apps/web/src/pushPayload.ts';
import type { AlbumNotification, IncomingPush } from '../apps/web/src/pushPayload.ts';
import type { KeyStore } from '../apps/web/src/server/client.ts';

const album = '10000000-0000-4000-8000-000000000001';
const userA = '10000000-0000-4000-8000-000000000002';
const userB = '10000000-0000-4000-8000-000000000003';
const id = '10000000-0000-4000-8000-000000000004';
const data: IncomingPush = { id, albumId: album, recipientId: userA };
const message: AlbumNotification = { id, albumId: album, title: '여행', body: '친구님이 사진 24장을 추가했어요' };
const generate = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);

async function harness() {
  const a = await generate(), b = await generate();
  const xA = (await crypto.subtle.exportKey('jwk', a.publicKey)).x;
  const model = {
    keys: a as CryptoKeyPair | undefined, writes: 0, calls: [] as Array<{ path: string; init: RequestInit }>,
    shown: [] as AlbumNotification[], status: 200, failures: 0,
    onMessage: undefined as (() => void) | undefined, body: message as unknown,
  };
  const store: KeyStore = { get: async () => model.keys, put: async keys => { model.writes += 1; model.keys = keys; } };
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    model.calls.push({ path, init });
    if (path === '/auth/challenge') return Response.json({ challenge: 'synthetic-challenge', expires_in: 120 });
    if (path === '/auth/token') {
      const value = JSON.parse(String(init.body)) as { public_key: JsonWebKey };
      const user = value.public_key.x === xA ? userA : userB;
      return Response.json({ access_token: `token-${user}`, expires_in: 600, user_id: user });
    }
    assert.equal(path, '/op/phogaem-push-message/v1');
    assert.deepEqual(JSON.parse(String(init.body)), { id });
    if (model.failures > 0) { model.failures -= 1; throw new Error('synthetic network failure'); }
    model.onMessage?.();
    if (new Headers(init.headers).get('authorization') !== `Bearer token-${userA}`) return Response.json({ error: 'not found' }, { status: 403 });
    return Response.json(model.body, { status: model.status });
  };
  const deps = {
    base: 'https://push-api.example.test', store, fetch,
    show: async (message: AlbumNotification) => { model.shown.push(message); }, delay: async () => {},
  };
  return { model, deps, a, b };
}

test('push payloads bind recipient and album; clicks remain within the application', () => {
  assert.deepEqual(incomingPush(data), data);
  for (const value of [null, { ...data, id: 'https://evil.test/' }, { ...data, recipientId: undefined }]) assert.equal(incomingPush(value), null);
  assert.deepEqual(albumNotification(message, data), message);
  for (const value of [{ ...message, albumId: userB }, { ...message, title: '\u0000' }, { ...message, body: 'x'.repeat(501) }]) assert.equal(albumNotification(value, data), null);
  assert.equal(notificationTarget(album, 'https://app.example.test', '/phogaem/'), `https://app.example.test/phogaem/#album=${album}`);
  assert.throws(() => notificationTarget(album, 'https://app.example.test', 'https://evil.test/'));
  assert.throws(() => notificationTarget('https://evil.test/', 'https://app.example.test', '/phogaem/'));
  assert.equal(notificationAlbum(`#album=${album}`), album);
  assert.equal(notificationAlbum(`#album=${album}&album=${userA}`), null);
  assert.equal(notificationAlbum(`#album=${album}&invite=token`), null);
});

test('background delivery without an existing device never authenticates or creates an identity', async () => {
  const { model, deps } = await harness();
  model.keys = undefined;
  await deliverPush(data, deps);
  assert.equal(model.calls.length, 0);
  assert.equal(model.writes, 0);
  assert.equal(model.shown.length, 0);
});

test('an approved recipient reauthenticates, displays bounded text without persisting any background identity', async () => {
  const { model, deps } = await harness();
  await deliverPush(data, deps);
  assert.deepEqual(model.shown, [message]);
  assert.equal(model.writes, 0);
  for (const { init } of model.calls) {
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  }
});

test('switching accounts between pushes cannot reuse a cached recipient JWT', async () => {
  const { model, deps, b } = await harness();
  await deliverPush(data, deps);
  model.keys = b;
  await deliverPush(data, deps);
  assert.equal(model.shown.length, 1);
  assert.equal(model.calls.filter(call => call.path === '/auth/challenge').length, 2);
  assert.equal(model.writes, 0);
});

test('key deletion or account replacement while fetching prevents private display', async () => {
  for (const remove of [true, false]) {
    const { model, deps, b } = await harness();
    model.onMessage = () => { model.keys = remove ? undefined : b; };
    await deliverPush(data, deps);
    assert.equal(model.shown.length, 0); assert.equal(model.writes, 0);
  }
});

test('revoked approval, removed membership, missing deliveries and wrong albums produce no private notification details', async () => {
  for (const status of [401, 403, 404, 410]) {
    const { model, deps } = await harness(); model.status = status;
    await deliverPush(data, deps);
    assert.equal(model.shown.length, 0);
  }
  const { model, deps } = await harness(); model.body = { ...message, albumId: userB };
  await deliverPush(data, deps); assert.equal(model.shown.length, 0);
});

test('transient failures retry once; exhausted failures remain observable without private fallback content', async () => {
  const { model, deps } = await harness(); model.failures = 1;
  await deliverPush(data, deps);
  assert.equal(model.shown.length, 1);
  const failed = await harness(); failed.model.failures = 3;
  await assert.rejects(deliverPush(data, failed.deps), /Push processing unavailable/);
  assert.equal(failed.model.calls.filter(call => call.path.endsWith('/v1')).length, 2);
  assert.equal(failed.model.shown.length, 0);
});

test('every push reauthenticates instead of trusting a previous receipt', async () => {
  const { model, deps } = await harness();
  await deliverPush(data, deps);
  await deliverPush(data, deps);
  assert.equal(model.calls.filter(call => call.path === '/auth/challenge').length, 2);
  assert.equal(model.shown.length, 2);
});
