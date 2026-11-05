import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerClient, ServerError, base64url, fromBase64url } from '../apps/web/src/server/client.ts';
import type { KeyStore } from '../apps/web/src/server/client.ts';
import { API_BASE, deviceKeyNamespace, server, validateApiBase } from '../apps/web/src/server/index.ts';
import { getSimilarPhotos, setRepresentative, setMemberNickname, getAlbum, getPhotoBlob, getThumbnailBlob, retryProcessing, listAlbums, createAlbum, createInvite, joinInvite, setSharedDownloadState, uploadSharedPhotos, validateSharedFiles, SHARED_MAX_FILE_SIZE, ApprovalRequired, getUploadFailureIndex } from '../apps/web/src/server/api.ts';
import { creationOptions, requestOptions } from '../apps/web/src/server/passkey.ts';

function memoryKeys() {
  let keys: CryptoKeyPair | undefined;
  let reads = 0;
  let writes = 0;
  const store: KeyStore = {
    async get() { reads += 1; return keys; },
    async put(value) { writes += 1; keys = value; },
  };
  return { store, get reads() { return reads; }, get writes() { return writes; }, get keys() { return keys; } };
}

type Recorded = { url: string; init: RequestInit };
function mockTransport(operation: (url: URL, init: RequestInit) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const calls: Recorded[] = [];
  let challenges = 0;
  let tokens = 0;
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init });
    if (url.pathname === '/auth/challenge') {
      challenges += 1;
      return Response.json({ challenge: `challenge-${challenges}`, expires_in: 120 });
    }
    if (url.pathname === '/auth/token') {
      tokens += 1;
      const body = JSON.parse(String(init.body)) as { public_key: JsonWebKey; signature: string; challenge: string };
      const key = await crypto.subtle.importKey('jwk', body.public_key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64url(body.signature) as Uint8Array<ArrayBuffer>, new TextEncoder().encode(`mlhops-auth-v1:${body.challenge}`));
      assert.equal(valid, true, 'device signature must verify against the submitted public key');
      return Response.json({ access_token: `token-${tokens}`, expires_in: 600, user_id: 'user-one' });
    }
    return operation(url, init);
  };
  return { fetch, calls, get challenges() { return challenges; }, get tokens() { return tokens; } };
}

test('constructing a client is lazy and concurrent token requests share one device-key sign-in', async () => {
  const keys = memoryKeys();
  const transport = mockTransport();
  const client = new ServerClient({ base: 'https://example.test', store: keys.store, fetch: transport.fetch });
  assert.equal(keys.reads, 0);
  assert.equal(keys.writes, 0);
  assert.equal(transport.calls.length, 0);
  assert.equal(await client.hasIdentity(), false);
  assert.equal(keys.writes, 0);
  assert.deepEqual(await Promise.all([client.token(), client.token(), client.token()]), ['token-1', 'token-1', 'token-1']);
  assert.equal(transport.challenges, 1);
  assert.equal(transport.tokens, 1);
  assert.equal(keys.writes, 1);
  assert.equal(keys.keys?.privateKey.extractable, false);
  assert.equal(client.userId, 'user-one');
  const second = new ServerClient({ base: 'https://example.test', store: keys.store, fetch: transport.fetch });
  assert.equal(await second.hasIdentity(), true);
  await second.token();
  assert.equal(keys.writes, 1, 'existing device identity is reused without replacing its key');
});

test('401 retries once, keeps bearer tokens in memory and strips untrusted mlhops headers', async () => {
  const keys = memoryKeys();
  const transport = mockTransport(() => Response.json({ error: 'expired' }, { status: 401 }));
  const client = new ServerClient({ base: 'https://example.test', store: keys.store, fetch: transport.fetch });
  const response = await client.op('phogaem-albums', { version: 'v1', method: 'GET', headers: { 'x-mlhops-user-id': 'forged', 'X-MLHOPS-Core': 'forged', authorization: 'forged' } });
  assert.equal(response.status, 401);
  const requests = transport.calls.filter(call => call.url.includes('/op/'));
  assert.equal(requests.length, 2);
  assert.equal(transport.tokens, 2);
  assert.equal(keys.writes, 1);
  for (const [index, request] of requests.entries()) {
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get('authorization'), `Bearer token-${index + 1}`);
    assert.equal(headers.has('x-mlhops-user-id'), false);
    assert.equal(headers.has('x-mlhops-core'), false);
  }
  client.resetSession();
  assert.equal(client.userId, undefined);
  assert.equal(await client.hasIdentity(), true, 'token reset does not destroy the device identity');
});

test('tokens refresh before expiry and never touch browser localStorage', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('tokens must not use localStorage'); } });
  try {
    let now = 0;
    const transport = mockTransport();
    const client = new ServerClient({ base: 'https://example.test', store: memoryKeys().store, fetch: transport.fetch, now: () => now });
    assert.equal(await client.token(), 'token-1');
    now = 539_000;
    assert.equal(await client.token(), 'token-1');
    now = 540_000;
    assert.equal(await client.token(), 'token-2');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('server origins allow HTTPS or exact HTTP loopback and namespace device keys by app path', () => {
  assert.equal(API_BASE, 'https://168-107-32-199.sslip.io');
  assert.equal(validateApiBase('https://api.example.test/'), 'https://api.example.test');
  assert.equal(validateApiBase('http://127.0.0.1:8000'), 'http://127.0.0.1:8000');
  assert.equal(validateApiBase('http://[::1]:8000'), 'http://[::1]:8000');
  for (const value of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test?key=abc', 'https://example.test#abc', 'javascript:alert(1)']) {
    assert.throws(() => validateApiBase(value));
  }
  assert.equal(deviceKeyNamespace(), 'phogaem-keys:/');
});

test('base64url and passkey option conversion preserve the existing WebAuthn contract', () => {
  const bytes = new Uint8Array([0, 1, 254, 255]);
  const encoded = base64url(bytes);
  assert.deepEqual(fromBase64url(encoded), bytes);
  assert.equal(/[+/=]/.test(encoded), false);
  const options = creationOptions({ challenge: encoded, rp: { id: 'example.test', name: 'mlhops' }, user: { id: encoded, name: 'u', displayName: 'u' }, excludeCredentials: [encoded], timeoutMs: 120_000 });
  assert.deepEqual(options.challenge, bytes);
  assert.equal(options.authenticatorSelection?.userVerification, 'required');
  assert.equal(options.pubKeyCredParams[0]?.alg, -7);
  assert.equal(requestOptions({ challenge: encoded, rpId: 'example.test', timeoutMs: 120_000 }).rpId, 'example.test');
});

test('network failures give an actionable error without losing device keys', async () => {
  const keys = memoryKeys();
  const client = new ServerClient({ base: 'https://example.test', store: keys.store, fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(client.token(), (error: unknown) => error instanceof ServerError && error.status === 0 && /서버에 연결하지 못했어요/.test(error.message));
  assert.equal(keys.writes, 1);
});

test('passkey account adoption replaces the device key only after the link succeeds', async () => {
  const keys = memoryKeys();
  let allowLink = false;
  const transport = mockTransport(async (_url, init) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer passkey-token');
    const body = JSON.parse(String(init.body)) as { public_key: JsonWebKey; signature: string; challenge: string };
    const publicKey = await crypto.subtle.importKey('jwk', body.public_key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const signature = fromBase64url(body.signature) as Uint8Array<ArrayBuffer>;
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, new TextEncoder().encode(`mlhops-link-v1:${body.challenge}`)), true, 'link proof must use the core link-message domain');
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, new TextEncoder().encode(`mlhops-auth-v1:${body.challenge}`)), false, 'a link proof must not also be a device sign-in proof');
    return Response.json({}, { status: allowLink ? 201 : 403 });
  });
  const client = new ServerClient({ base: 'https://example.test', store: keys.store, fetch: transport.fetch });
  await client.token();
  const originalKey = keys.keys;
  const login = { access_token: 'passkey-token', expires_in: 600, user_id: 'recovered-account' };
  await assert.rejects(client.adoptAccount(login), (error: unknown) => error instanceof ServerError && error.status === 403);
  assert.equal(keys.keys, originalKey);
  assert.equal(client.userId, 'user-one');
  allowLink = true;
  await client.adoptAccount(login);
  assert.notEqual(keys.keys, originalKey);
  assert.equal(keys.writes, 2);
  assert.equal(client.userId, 'recovered-account');
  assert.equal(await client.token(), 'passkey-token');
});

test('photo API uses encoded flat op queries, raw originals and separate metadata and bytes', async () => {
  const originalOp = server.op;
  const transport = mockTransport(async (url, init) => {
    if (url.pathname.endsWith('phogaem-photo-upload/v1')) {
      assert.equal(url.searchParams.get('albumId'), 'album +&');
      assert.equal(url.searchParams.get('name'), '여행 & 한 장.HEIC');
      assert.equal(new Headers(init.headers).get('content-type'), 'image/heic');
      assert.ok(init.body instanceof File);
      assert.equal(await (init.body as File).text(), 'exact original');
      return Response.json({ added: true });
    }
    if (url.pathname.endsWith('phogaem-photo-get/v1')) return new Response('exact original', { headers: { 'content-type': 'image/heic' } });
    return Response.json({ album: { id: 'a', title: 'Trip', createdAt: 1 }, members: [], photos: [] });
  });
  const client = new ServerClient({ base: 'https://example.test', store: memoryKeys().store, fetch: transport.fetch });
  server.op = client.op.bind(client);
  try {
    const details = await getAlbum('album +&');
    assert.deepEqual(details.photos, []);
    assert.equal(transport.calls.filter(call => call.url.includes('/op/')).length, 1, 'listing metadata must not download any originals');
    const file = new File(['exact original'], '여행 & 한 장.HEIC');
    assert.deepEqual(await uploadSharedPhotos('album +&', [file]), { added: 1, duplicates: 0 });
    assert.equal(await (await getPhotoBlob('album +&', 'id &')).text(), 'exact original');
    assert.equal(transport.tokens, 1);
  } finally { server.op = originalOp; }
});

test('upload validates the entire batch before touching the server', async () => {
  const originalOp = server.op;
  let calls = 0;
  server.op = async () => { calls += 1; return Response.json({ added: true }); };
  try {
    const valid = new File(['synthetic'], 'one.png', { type: 'image/png' });
    await assert.rejects(uploadSharedPhotos('album', [valid, new File(['bad'], 'notes.txt')]), /지원하는 사진/);
    assert.equal(calls, 0);
    assert.throws(() => validateSharedFiles([new File([], 'empty.jpg')]), /비어 있는/);
    assert.throws(() => validateSharedFiles([new File(['bytes'], 'a'.repeat(197) + '.png')]), /이름/);
    assert.doesNotThrow(() => validateSharedFiles([new File(['bytes'], '가'.repeat(196) + '.png')]));
    assert.throws(() => validateSharedFiles([new File(['<svg/>'], 'photo.svg', { type: 'image/svg+xml' })]), /SVG/);
    assert.throws(() => validateSharedFiles([new File([new Uint8Array(SHARED_MAX_FILE_SIZE + 1)], 'large.jpg')]), /16MB/);
  } finally { server.op = originalOp; }
});

test('shared operations retain server errors and report partial uploads', async () => {
  const originalOp = server.op;
  const calls: { name: string; init: Parameters<typeof server.op>[1] }[] = [];
  server.op = async (name, init) => {
    calls.push({ name, init });
    if (name === 'phogaem-albums') return Response.json({ userId: 'u', albums: [] });
    if (name === 'phogaem-album-create' || name === 'phogaem-invite-join') return Response.json({ album: { id: 'a', title: 'Trip', createdAt: 1 } });
    if (name === 'phogaem-invite-create') return Response.json({ token: 'invite', expiresAt: 123 });
    return Response.json({ ok: true });
  };
  try {
    assert.deepEqual(await listAlbums(), { userId: 'u', albums: [] });
    assert.equal((await createAlbum('Trip')).title, 'Trip');
    assert.equal((await joinInvite('invite')).id, 'a');
    assert.equal((await createInvite('a')).token, 'invite');
    await setSharedDownloadState('a', ['photo'], 'received');
    assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { albumId: 'a', photoIds: ['photo'], state: 'received' });
    assert.ok(calls.every(call => call.init?.version === 'v1'));
    server.op = async () => Response.json({ error: 'album not found' }, { status: 404 });
    await assert.rejects(getAlbum('missing'), (error: unknown) => error instanceof ServerError && error.status === 404 && /album not found/.test(error.message));
    let uploads = 0;
    server.op = async () => ++uploads === 1 ? Response.json({ added: true }) : Response.json({ error: 'unavailable' }, { status: 503 });
    await assert.rejects(uploadSharedPhotos('a', [new File(['a'], 'a.png'), new File(['b'], 'b.png')]), /1장 추가.*중단/);
  } finally { server.op = originalOp; }
});

test('original reads are paced and at most two response bodies download concurrently', async () => {
  const originalOp = server.op;
  const starts: number[] = [];
  const release: Array<() => void> = [];
  let active = 0;
  let maximum = 0;
  server.op = async () => {
    starts.push(Date.now());
    active += 1;
    maximum = Math.max(maximum, active);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      let released = false;
      release.push(() => {
        if (released) return;
        released = true;
        active -= 1;
        controller.enqueue(new TextEncoder().encode('original'));
        controller.close();
      });
    } });
    return new Response(body);
  };
  const waitUntil = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(predicate(), true, 'queued read should eventually start');
  };
  try {
    const pending = ['one', 'two', 'three'].map(id => getPhotoBlob('album', id));
    await waitUntil(() => starts.length === 2);
    assert.ok(starts[1]! - starts[0]! >= 300, 'starts must be spaced about 350ms apart');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(starts.length, 2, 'third read waits until a full response body has completed');
    release[0]!();
    await waitUntil(() => starts.length === 3);
    release[1]!(); release[2]!();
    assert.deepEqual(await Promise.all(pending.map(async value => (await value).text())), ['original', 'original', 'original']);
    assert.equal(maximum, 2);
  } finally { release.forEach(run => run()); server.op = originalOp; }
});

test('only original GETs retry a rate limit once, respecting the bounded retry delay', async () => {
  const originalOp = server.op;
  let calls = 0;
  const starts: number[] = [];
  server.op = async () => {
    calls += 1; starts.push(Date.now());
    return calls === 1 ? Response.json({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '0' } }) : new Response('retried original');
  };
  try {
    assert.equal(await (await getPhotoBlob('a', 'p')).text(), 'retried original');
    assert.equal(calls, 2);
    assert.ok(starts[1]! - starts[0]! >= 300);
    calls = 0;
    server.op = async () => { calls += 1; return Response.json({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '0' } }); };
    await assert.rejects(getPhotoBlob('a', 'p'), (error: unknown) => error instanceof ServerError && error.status === 429);
    assert.equal(calls, 2, 'repeated throttling must not retry indefinitely');
    calls = 0;
    await assert.rejects(uploadSharedPhotos('a', [new File(['original'], 'a.png')]), (error: unknown) => error instanceof ServerError && error.status === 429);
    assert.equal(calls, 1, 'uploads and other mutations do not automatically retry 429');
  } finally { server.op = originalOp; }
});


test('only the core approval-required error is treated as pending account approval', async () => {
  const originalOp = server.op;
  try {
    server.op = async () => Response.json({ error: 'approval required' }, { status: 403 });
    await assert.rejects(listAlbums(), (error: unknown) => error instanceof ApprovalRequired && error.status === 403 && /관리자 승인/.test(error.message));
    server.op = async () => Response.json({ error: 'only the album owner can invite' }, { status: 403 });
    await assert.rejects(createInvite('album'), (error: unknown) => error instanceof ServerError && !(error instanceof ApprovalRequired));
    const pending = new ApprovalRequired('a1b2c3d4-1234-4567-890a-bbbbbbbbbbbb');
    assert.equal(pending.accountCode, 'a1b2c3d4');
  } finally { server.op = originalOp; }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('all transports omit cookies, referrers and caches and refuse redirects', async () => {
  const transport = mockTransport(() => Response.json({}, { status: 201 }));
  const client = new ServerClient({ base: 'https://example.test/', store: memoryKeys().store, fetch: transport.fetch });
  await client.op('phogaem-albums', { method: 'GET' });
  await client.postPublic('/auth/passkey/login/options');
  await client.adoptAccount({ access_token: 'passkey-token', expires_in: 600, user_id: 'recovered' });
  for (const { init } of transport.calls) {
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.referrerPolicy, 'no-referrer');
  }
});

test('a real 307 redirect never forwards an authentication body to its target', async () => {
  const { createServer } = await import('node:http');
  let forwarded = 0;
  const http = createServer((request, response) => {
    if (request.url === '/auth/token') { response.writeHead(307, { location: '/untrusted-target' }); response.end(); }
    else { forwarded += 1; response.end('{}'); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    const address = http.address();
    assert.ok(address && typeof address === 'object');
    const client = new ServerClient({ base: `http://127.0.0.1:${address.port}`, store: memoryKeys().store });
    await assert.rejects(client.postPublic('/auth/token', { signature: 'synthetic-proof' }), ServerError);
    assert.equal(forwarded, 0);
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  }
});

test('invalid credential destinations and operation names fail before identity creation', async () => {
  const keys = memoryKeys();
  const transport = mockTransport();
  for (const base of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path']) {
    assert.throws(() => new ServerClient({ base, store: keys.store, fetch: transport.fetch }));
  }
  const client = new ServerClient({ base: 'https://example.test', store: keys.store, fetch: transport.fetch });
  for (const path of ['@evil.test/collect', '//evil.test/collect', '/\\evil.test/collect', '/auth/token\n', '/auth/token#fragment']) {
    await assert.rejects(client.request(path), ServerError);
    await assert.rejects(client.postPublic(path, { secret: 'synthetic' }), ServerError);
  }
  await assert.rejects(client.op('../auth/token'), ServerError);
  await assert.rejects(client.op('phogaem-albums', { version: '../token' }), ServerError);
  assert.equal(keys.writes, 0);
  assert.equal(transport.calls.length, 0);
});

test('reset invalidates a pending sign-in without allowing it to restore the session', async () => {
  const held = deferred<Response>();
  const arrived = deferred<void>();
  const transport = mockTransport();
  const client = new ServerClient({ base: 'https://example.test', store: memoryKeys().store, fetch: async (input, init) => {
    const response = await transport.fetch(input, init);
    if (String(input).endsWith('/auth/token') && transport.tokens === 1) { arrived.resolve(); return held.promise; }
    return response;
  } });
  const stale = client.token();
  const rejected = assert.rejects(stale, /로그인 상태가 변경/);
  await arrived.promise;
  client.resetSession();
  assert.equal(await client.token(), 'token-2');
  held.resolve(Response.json({ access_token: 'old-token', expires_in: 600, user_id: 'old-user' }));
  await rejected;
  assert.equal(await client.token(), 'token-2');
  assert.equal(client.userId, 'user-one');
});

test('an old in-flight sign-in cannot replace an adopted passkey account', async () => {
  const held = deferred<Response>();
  const arrived = deferred<void>();
  const transport = mockTransport(() => Response.json({}, { status: 201 }));
  const client = new ServerClient({ base: 'https://example.test', store: memoryKeys().store, fetch: async (input, init) => {
    const response = await transport.fetch(input, init);
    if (String(input).endsWith('/auth/token')) { arrived.resolve(); return held.promise; }
    return response;
  } });
  const stale = client.token();
  const rejected = assert.rejects(stale, /로그인 상태가 변경/);
  await arrived.promise;
  await client.adoptAccount({ access_token: 'recovered-token', expires_in: 600, user_id: 'recovered-user' });
  held.resolve(Response.json({ access_token: 'old-token', expires_in: 600, user_id: 'old-user' }));
  await rejected;
  assert.equal(client.userId, 'recovered-user');
  assert.equal(await client.token(), 'recovered-token');
});

test('a delayed response from the previous account cannot refresh or be returned under the new account', async () => {
  for (const status of [200, 401]) {
    const held = deferred<Response>();
    const arrived = deferred<void>();
    const transport = mockTransport(url => {
      if (url.pathname.startsWith('/op/')) { arrived.resolve(); return held.promise; }
      return Response.json({}, { status: 201 });
    });
    const client = new ServerClient({ base: 'https://example.test', store: memoryKeys().store, fetch: transport.fetch });
    const stale = client.op('phogaem-albums', { method: 'GET' });
    const rejected = assert.rejects(stale, /로그인 상태가 변경/);
    await arrived.promise;
    await client.adoptAccount({ access_token: 'recovered-token', expires_in: 600, user_id: 'recovered-user' });
    held.resolve(Response.json({ privateAlbum: 'old-account' }, { status }));
    await rejected;
    assert.equal(client.userId, 'recovered-user');
    assert.equal(await client.token(), 'recovered-token');
    assert.equal(transport.tokens, 1, 'the stale 401 must not reset or refresh the adopted session');
  }
});

test('mid-batch approval revocation retains the typed failure needed to clear protected UI', async () => {
  const originalOp = server.op;
  let uploads = 0;
  server.op = async () => ++uploads === 1 ? Response.json({ added: true }) : Response.json({ error: 'approval required' }, { status: 403 });
  try {
    await assert.rejects(uploadSharedPhotos('album', [new File(['one'], 'one.png'), new File(['two'], 'two.png')]),
      (error: unknown) => error instanceof ApprovalRequired && /1장 추가/.test(error.message));
  } finally { server.op = originalOp; }
});


function uploadFixture(index: number) {
  return { id: `photo-${index}`, name: `${index}.png`, type: 'image/png', size: 1, hash: `hash-${index}`, createdAt: index,
    contributors: ['user'], requestedBy: [], receivedBy: [], importCount: 1 };
}

async function waitForUpload(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(predicate(), true, 'expected upload scheduling event');
}

test('parallel uploads overlap at most two globally and report actual out-of-order completions', async () => {
  const originalOp = server.op;
  const starts: number[] = [];
  const release = new Map<string, () => void>();
  let active = 0;
  let maximum = 0;
  server.op = async (_name, init) => {
    const name = init?.query?.name ?? '';
    starts.push(Date.now()); active += 1; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => release.set(name, resolve));
    active -= 1;
    const index = Number(name.split('.')[0]);
    return Response.json({ added: index !== 1, photo: uploadFixture(index) });
  };
  const updates: Array<{ completed: number; index: number; indices: number[]; photo: string }> = [];
  const files = [0, 1, 2].map(index => new File(['x'], `${index}.png`));
  const first = uploadSharedPhotos('album', files, (completed, event) => updates.push({ completed, index: event.index, indices: event.completedIndices, photo: event.photo.id }));
  const second = uploadSharedPhotos('other', [new File(['x'], '3.png')]);
  try {
    await waitForUpload(() => release.size === 2);
    assert.equal(active, 2);
    release.get('1.png')!();
    await waitForUpload(() => release.has('2.png'));
    assert.equal(active, 2);
    release.get('0.png')!();
    await waitForUpload(() => release.has('3.png'));
    release.get('2.png')!(); release.get('3.png')!();
    assert.deepEqual(await first, { added: 2, duplicates: 1 });
    assert.deepEqual(await second, { added: 1, duplicates: 0 });
    assert.equal(maximum, 2);
    assert.deepEqual(updates, [
      { completed: 1, index: 1, indices: [1], photo: 'photo-1' },
      { completed: 2, index: 0, indices: [0, 1], photo: 'photo-0' },
      { completed: 3, index: 2, indices: [0, 1, 2], photo: 'photo-2' },
    ]);
    for (let index = 1; index < starts.length; index++) assert.ok(starts[index]! - starts[index - 1]! >= 340, 'global starts remain paced across batches');
  } finally {
    for (const resolve of release.values()) resolve();
    await Promise.allSettled([first, second]); server.op = originalOp;
  }
});

test('upload failure stops queued writes and drains successful in-flight writes before reporting retry indices', async () => {
  const originalOp = server.op;
  const first = deferred<Response>();
  let starts = 0;
  let settled = false;
  const completed: number[][] = [];
  server.op = async () => ++starts === 1 ? first.promise : Response.json({ error: 'synthetic unavailable' }, { status: 503 });
  const batch = uploadSharedPhotos('album', [0, 1, 2, 3].map(index => new File(['x'], `${index}.png`)), (_count, event) => completed.push(event.completedIndices));
  const failure = assert.rejects(batch, (error: unknown) => {
    assert.ok(error instanceof ServerError);
    assert.equal(error.status, 503); assert.equal(getUploadFailureIndex(error), 1);
    assert.match(error.message, /1장 추가/);
    return true;
  });
  void batch.then(() => { settled = true; }, () => { settled = true; });
  try {
    await waitForUpload(() => starts === 2);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(settled, false, 'caller must wait for the original still committing');
    assert.equal(starts, 2, 'neither queued write starts or retries after failure');
    first.resolve(Response.json({ added: true, photo: uploadFixture(0) }));
    await failure;
    assert.deepEqual(completed, [[0]]);
    assert.equal(starts, 2);
  } finally { first.resolve(Response.json({ added: true, photo: uploadFixture(0) })); await failure; server.op = originalOp; }
});

test('approval denial wins over another parallel upload failure and prevents unscheduled writes', async () => {
  const originalOp = server.op;
  const approval = deferred<Response>();
  const unavailable = deferred<Response>();
  let starts = 0;
  let callbacks = 0;
  server.op = async () => ++starts === 1 ? approval.promise : unavailable.promise;
  const batch = uploadSharedPhotos('album', [0, 1, 2].map(index => new File(['x'], `${index}.png`)), () => { callbacks += 1; });
  const failure = assert.rejects(batch, (error: unknown) => error instanceof ApprovalRequired && getUploadFailureIndex(error) === 0);
  try {
    await waitForUpload(() => starts === 2);
    unavailable.resolve(Response.json({ error: 'synthetic unavailable' }, { status: 503 }));
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(starts, 2);
    approval.resolve(Response.json({ error: 'approval required' }, { status: 403 }));
    await failure;
    assert.equal(callbacks, 0);
  } finally {
    unavailable.resolve(Response.json({ error: 'unavailable' }, { status: 503 }));
    approval.resolve(Response.json({ error: 'approval required' }, { status: 403 }));
    await failure; server.op = originalOp;
  }
});


test('uploads and original previews share a transfer start budget with metadata headroom', async () => {
  const originalOp = server.op;
  const starts: Array<{ at: number; kind: string }> = [];
  server.op = async name => {
    starts.push({ at: Date.now(), kind: name });
    return name === 'phogaem-photo-upload'
      ? Response.json({ added: true, photo: uploadFixture(0) }) : new Response('synthetic original');
  };
  try {
    await Promise.all([
      uploadSharedPhotos('album', [0, 1, 2].map(index => new File(['x'], `${index}.png`))),
      ...[0, 1, 2].map(index => getPhotoBlob('album', String(index))),
    ]);
    assert.equal(starts.length, 6);
    for (let index = 1; index < starts.length; index++) assert.ok(starts[index]!.at - starts[index - 1]!.at >= 240, 'mixed transfers reserve at least 250ms between starts');
    for (const kind of ['phogaem-photo-upload', 'phogaem-photo-get']) {
      const times = starts.filter(start => start.kind === kind);
      for (let index = 1; index < times.length; index++) assert.ok(times[index]!.at - times[index - 1]!.at >= 340, 'each transfer class retains its own pacing');
    }
  } finally { server.op = originalOp; }
});


test('an approval observer fires before in-flight writes drain and cannot mask the denial', async () => {
  const originalOp = server.op;
  const first = deferred<Response>();
  const notified = deferred<void>();
  let starts = 0;
  let settled = false;
  server.op = async () => ++starts === 1 ? first.promise : Response.json({ error: 'approval required' }, { status: 403 });
  const observed: Array<{ error: unknown; index: number }> = [];
  const batch = uploadSharedPhotos('album', [0, 1, 2].map(index => new File(['x'], `${index}.png`)), undefined, (error, index) => {
    observed.push({ error, index }); notified.resolve(); throw new Error('synthetic observer failure');
  });
  const failure = assert.rejects(batch, (error: unknown) => error instanceof ApprovalRequired && getUploadFailureIndex(error) === 1);
  void batch.then(() => { settled = true; }, () => { settled = true; });
  try {
    await notified.promise;
    assert.equal(settled, false, 'public promise still waits for an already-started write');
    assert.equal(observed.length, 1); assert.equal(observed[0]!.index, 1);
    assert.ok(observed[0]!.error instanceof ApprovalRequired);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(starts, 2, 'observer failure does not reopen the queue');
    first.resolve(Response.json({ added: true, photo: uploadFixture(0) }));
    await failure;
  } finally { first.resolve(Response.json({ added: true, photo: uploadFixture(0) })); await failure; server.op = originalOp; }
});

test('thumbnail reads use the protected thumbnail operation and retries retain approval denial', async () => {
  const originalOp = server.op;
  const calls: { name: string; init: Parameters<typeof server.op>[1] }[] = [];
  server.op = async (name, init) => {
    calls.push({ name, init });
    if (name === 'phogaem-thumbnail-get') return new Response('synthetic-webp', { headers: { 'content-type': 'image/webp' } });
    return Response.json({ ok: true });
  };
  try {
    const thumbnail = await getThumbnailBlob('album', 'photo');
    assert.equal(thumbnail.type, 'image/webp');
    assert.equal(await thumbnail.text(), 'synthetic-webp');
    assert.equal(calls[0]!.name, 'phogaem-thumbnail-get');
    assert.deepEqual(calls[0]!.init?.query, { albumId: 'album', photoId: 'photo' });
    await retryProcessing('album', 'photo', 'vision');
    assert.equal(calls[1]!.name, 'phogaem-processing-retry');
    assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), { albumId: 'album', photoId: 'photo', kind: 'vision' });
    server.op = async () => Response.json({ error: 'approval required' }, { status: 403 });
    await assert.rejects(retryProcessing('album', 'photo', 'thumbnail'), ApprovalRequired);
  } finally { server.op = originalOp; }
});


test('comparison candidates use an approved metadata GET and retain approval errors', async () => {
  const original = server.op;
  try {
    server.op = async (name, init) => {
      assert.equal(name, 'phogaem-similar-get');
      assert.equal(init?.version, 'v1'); assert.equal(init?.method, 'GET');
      assert.deepEqual(init?.query, { albumId: 'album-one' }); assert.equal(init?.body, undefined);
      return Response.json({ groups: [{ id: 'group-one', photoIds: ['photo-one', 'photo-two'] }], pending: 1, failed: 0, analyzed: 2 });
    };
    assert.equal((await getSimilarPhotos('album-one')).groups.length, 1);
    server.op = async () => Response.json({ error: 'approval required' }, { status: 403 });
    await assert.rejects(getSimilarPhotos('album-one'), error => error instanceof ApprovalRequired);
  } finally { server.op = original; }
});

test('malformed, overlapping or unbounded comparison results are rejected', async () => {
  const original = server.op;
  const valid = { groups: [{ id: 'group-one', photoIds: ['photo-one', 'photo-two'] }], pending: 0, failed: 0, analyzed: 2 };
  const invalid = [
    null, {}, { ...valid, pending: -1 }, { ...valid, analyzed: 0.5 },
    { ...valid, pending: 1999 },
    { ...valid, groups: [{ ...valid.groups[0], representativeId: 'outside-photo' }] },
    { ...valid, groups: [{ ...valid.groups[0], representativeId: null }] },
    { ...valid, groups: [{ ...valid.groups[0], representativeId: '<img>' }] },
    { ...valid, groups: [{ id: 'group-one', photoIds: ['photo-one', 'photo-one'] }] },
    { ...valid, groups: [{ id: 'group-one', photoIds: ['photo-one'] }] },
    { ...valid, groups: [{ id: 'group-one', photoIds: Array.from({ length: 13 }, (_, i) => `photo-${i}`) }] },
    { ...valid, groups: [...valid.groups, { id: 'group-two', photoIds: ['photo-two', 'photo-three'] }] },
    { ...valid, groups: [...valid.groups, { id: 'group-one', photoIds: ['photo-three', 'photo-four'] }] },
    { ...valid, groups: [{ id: '<img>', photoIds: ['photo-one', 'photo-two'] }] },
  ];
  try {
    for (const value of invalid) {
      server.op = async () => Response.json(value);
      await assert.rejects(getSimilarPhotos('album'), error => error instanceof ServerError && error.status === 502);
    }
  } finally { server.op = original; }
});


test('representative selection and nickname writes retain approved transport and typed denial', async () => {
  const original = server.op;
  const writes: Array<{ name: string; body: unknown }> = [];
  try {
    server.op = async (name, init) => {
      assert.equal(init?.version, 'v1'); assert.equal(init?.method, 'POST');
      writes.push({ name, body: JSON.parse(init?.body as string) });
      return Response.json({ ok: true });
    };
    await setRepresentative('album-one', 'group-one', 'photo-two');
    await setMemberNickname('album-one', '여행 친구');
    assert.deepEqual(writes, [
      { name: 'phogaem-representative-set', body: { albumId: 'album-one', groupId: 'group-one', photoId: 'photo-two' } },
      { name: 'phogaem-member-name-set', body: { albumId: 'album-one', nickname: '여행 친구' } },
    ]);
    server.op = async () => Response.json({ error: 'approval required' }, { status: 403 });
    await assert.rejects(setRepresentative('album-one', 'group-one', 'photo-two'), ApprovalRequired);
    await assert.rejects(setMemberNickname('album-one', '친구'), ApprovalRequired);
  } finally { server.op = original; }
});

test('a server-selected representative survives candidate transport', async () => {
  const original = server.op;
  const group = { id: 'group-one', photoIds: ['photo-one', 'photo-two'], representativeId: 'photo-two' };
  try {
    server.op = async () => Response.json({ groups: [group], pending: 0, failed: 0, analyzed: 2 });
    assert.deepEqual((await getSimilarPhotos('album-one')).groups, [group]);
  } finally { server.op = original; }
});
