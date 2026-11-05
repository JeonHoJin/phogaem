import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const apiBase = process.env.PHOGAEM_INTEGRATION_API_BASE!;
const adminBase = process.env.PHOGAEM_INTEGRATION_ADMIN_BASE!;
const imageBytes = Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));

async function client<T>(page: Page, operation: string, payload: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(async ({ operation, payload }) => {
    const apiPath = '/phogaem/src/server/api.ts';
    const indexPath = '/phogaem/src/server/index.ts';
    const api = await import(apiPath);
    const { server } = await import(indexPath);
    switch (operation) {
      case 'identity': { await server.token(); return { userId: server.userId }; }
      case 'list': return api.listAlbums();
      case 'create': return api.createAlbum(payload.title as string);
      case 'invite': return api.createInvite(payload.albumId as string);
      case 'join': return api.joinInvite(payload.token as string);
      case 'get': return api.getAlbum(payload.albumId as string);
      case 'upload': return api.uploadSharedPhotos(payload.albumId as string, [new File([new Uint8Array(payload.bytes as number[])], payload.name as string, { type: 'image/png' })]);
      case 'blob': return Array.from(new Uint8Array(await (await api.getPhotoBlob(payload.albumId as string, payload.photoId as string)).arrayBuffer()));
      case 'state': return api.setSharedDownloadState(payload.albumId as string, payload.photoIds as string[], payload.state as 'requested' | 'received' | 'reset');
      case 'probe': {
        const response = await server.op(payload.op as string, { method: 'GET', version: 'v1', query: payload.query as Record<string, string>, headers: { 'x-mlhops-user-id': payload.forgedUser as string } });
        return response.status;
      }
      default: throw new Error('Unknown integration operation');
    }
  }, { operation, payload }) as Promise<T>;
}


async function setApproval(page: Page, userId: string, approved = true) {
  const response = await page.request.post(`${adminBase}/api/users/${userId}/${approved ? 'approve' : 'revoke'}`, {
    headers: { 'content-type': 'application/json', 'x-mlhops-admin': '1', 'sec-fetch-site': 'same-origin', origin: adminBase },
    data: {},
  });
  expect(response.status()).toBe(200);
}

async function approveIdentity(page: Page): Promise<{ userId: string }> {
  const identity = await client<{ userId: string }>(page, 'identity');
  await setApproval(page, identity.userId);
  return identity;
}

async function connectApprovedUi(page: Page) {
  await page.getByRole('button', { name: '공유보관함 연결', exact: true }).click();
  await page.getByRole('button', { name: '이 기기로 연결', exact: true }).click();
  await expect(page.getByRole('heading', { name: '승인 대기 중', exact: true })).toBeVisible();
  const identity = await client<{ userId: string }>(page, 'identity');
  await setApproval(page, identity.userId);
  await page.getByRole('button', { name: '승인 상태 다시 확인', exact: true }).click();
  await expect(page.getByLabel('보관함 이름', { exact: true })).toBeVisible();
}

test('four real device-key users share two albums through gateway/core and preserve originals', async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  try {
    await Promise.all(pages.map(page => page.goto('./')));
    const identities = await Promise.all(pages.map(page => approveIdentity(page)));
    expect(new Set(identities.map(identity => identity.userId)).size).toBe(4);
    const album = await client<{ id: string; title: string }>(pages[0]!, 'create', { title: '함께한 여행' });
    const privateAlbum = await client<{ id: string }>(pages[3]!, 'create', { title: '다른 여행' });
    const invitation = await client<{ token: string }>(pages[0]!, 'invite', { albumId: album.id });
    await Promise.all([pages[1]!, pages[2]!].map(page => client(page, 'join', { token: invitation.token })));
    await client(pages[0]!, 'upload', { albumId: album.id, name: 'original.png', bytes: imageBytes });
    await client(pages[1]!, 'upload', { albumId: album.id, name: 'same-renamed.png', bytes: imageBytes });
    const shared = await client<{ members: unknown[]; photos: Array<{ id: string; contributors: string[]; importCount: number; receivedBy: string[]; requestedBy: string[] }> }>(pages[2]!, 'get', { albumId: album.id });
    expect(shared.members).toHaveLength(3);
    expect(shared.photos).toHaveLength(1);
    expect(shared.photos[0]!.contributors.sort()).toEqual([identities[0]!.userId, identities[1]!.userId].sort());
    expect(shared.photos[0]!.importCount).toBe(2);
    const photoId = shared.photos[0]!.id;
    expect(await client<number[]>(pages[2]!, 'blob', { albumId: album.id, photoId })).toEqual(imageBytes);

    // A guessed UUID and a forged identity header do not grant membership through the gateway.
    expect(await client<number>(pages[3]!, 'probe', { op: 'phogaem-album-get', query: { albumId: album.id }, forgedUser: identities[0]!.userId })).toBe(404);
    expect(await client<number>(pages[3]!, 'probe', { op: 'phogaem-photo-get', query: { albumId: album.id, photoId }, forgedUser: identities[0]!.userId })).toBe(404);
    expect(await client<number>(pages[0]!, 'probe', { op: 'phogaem-album-get', query: { albumId: privateAlbum.id }, forgedUser: identities[3]!.userId })).toBe(404);

    // Bypass client-side header stripping: the actual gateway/core must replace forged identity.
    const outsiderToken = await pages[3]!.evaluate(async () => {
      const path = '/phogaem/src/server/index.ts';
      return (await import(path)).server.token();
    });
    const forgedHeaders = {
      authorization: `Bearer ${outsiderToken}`,
      'x-mlhops-user-id': identities[0]!.userId,
      'x-mlhops-core': 'synthetic-forged-core-token',
      'x-mlhops-op': 'phogaem-albums',
    };
    const attempts: Array<{ op: string; method: string; params?: Record<string, string>; data?: Record<string, unknown> | Buffer }> = [
      { op: 'phogaem-album-get', method: 'GET', params: { albumId: album.id } },
      { op: 'phogaem-photo-get', method: 'GET', params: { albumId: album.id, photoId } },
      { op: 'phogaem-invite-create', method: 'POST', data: { albumId: album.id } },
      { op: 'phogaem-download-state', method: 'POST', data: { albumId: album.id, photoIds: [photoId], state: 'requested' } },
      { op: 'phogaem-photo-upload', method: 'POST', params: { albumId: album.id, name: 'forged.png' }, data: Buffer.from(imageBytes) },
    ];
    for (const attempt of attempts) {
      const denied = await pages[3]!.request.fetch(`${apiBase}/op/${attempt.op}/v1`, {
        ...attempt,
        headers: { ...forgedHeaders, 'content-type': Buffer.isBuffer(attempt.data) ? 'image/png' : 'application/json' },
      });
      expect(denied.status(), `raw forged headers: ${attempt.op}`).toBe(404);
    }
    const segments = outsiderToken.split('.');
    segments[1] = Buffer.from(JSON.stringify({ sub: identities[0]!.userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const tampered = await pages[3]!.request.get(`${apiBase}/op/phogaem-albums/v1`, {
      headers: { authorization: `Bearer ${segments.join('.')}` },
    });
    expect(tampered.status()).toBe(401);

    const metadata = await pages[3]!.request.get(`${apiBase}/op/phogaem-albums/v1`, { headers: { authorization: `Bearer ${outsiderToken}`, origin: 'https://untrusted.invalid' } });
    expect(metadata.status()).toBe(200);
    expect(metadata.headers()['access-control-allow-origin']).toBeUndefined();
    expect(metadata.headers()['cache-control']).toContain('no-store');

    await client(pages[2]!, 'state', { albumId: album.id, photoIds: [photoId], state: 'requested' });
    let own = await client<typeof shared>(pages[2]!, 'get', { albumId: album.id });
    expect(own.photos[0]!.requestedBy).toEqual([identities[2]!.userId]);
    expect(own.photos[0]!.receivedBy).toEqual([]);
    await client(pages[2]!, 'state', { albumId: album.id, photoIds: [photoId], state: 'received' });
    own = await client<typeof shared>(pages[2]!, 'get', { albumId: album.id });
    expect(own.photos[0]!.receivedBy).toEqual([identities[2]!.userId]);
    const friend = await client<typeof shared>(pages[0]!, 'get', { albumId: album.id });
    expect(friend.photos[0]!.receivedBy).toEqual([]);
    expect(friend.photos[0]!.requestedBy).toEqual([]);

    await pages[2]!.reload();
    expect((await client<{ userId: string }>(pages[2]!, 'list')).userId).toBe(identities[2]!.userId);
    expect((await client<typeof shared>(pages[2]!, 'get', { albumId: album.id })).photos[0]!.receivedBy).toEqual([identities[2]!.userId]);
    await client(pages[2]!, 'state', { albumId: album.id, photoIds: [photoId], state: 'reset' });
    expect((await client<typeof shared>(pages[2]!, 'get', { albumId: album.id })).photos[0]!.requestedBy).toEqual([]);
    const noAuth = await pages[3]!.request.get(`${apiBase}/op/phogaem-albums/v1`, { headers: { 'x-mlhops-user-id': identities[0]!.userId } });
    expect(noAuth.status()).toBe(401);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('shared-library UI creates, invites, shares and downloads an original after explicit connection', async ({ page, browser }) => {
  await page.goto('./');
  await connectApprovedUi(page);
  await page.getByLabel('보관함 이름', { exact: true }).fill('브라우저에서 만든 여행');
  await page.getByRole('button', { name: '공유보관함 만들기', exact: true }).click();
  await expect(page.getByLabel('공유보관함 선택', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByRole('heading', { name: '브라우저에서 만든 여행', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '사진 올리기', exact: true })).toBeEnabled();
  await page.getByLabel('사진 파일 선택').setInputFiles({ name: 'shared-ui.png', mimeType: 'image/png', buffer: Buffer.from(imageBytes) });
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await expect(page.getByRole('img', { name: 'shared-ui.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '초대 링크 만들기', exact: true }).click();
  const invitation = await page.getByLabel('초대 링크', { exact: true }).inputValue();
  const friendContext = await browser.newContext();
  try {
    const friend = await friendContext.newPage();
    await friend.goto('./');
    await connectApprovedUi(friend);
    await friend.getByLabel('초대 코드', { exact: true }).fill(invitation);
    await friend.getByRole('button', { name: '초대 코드로 참여', exact: true }).click();
    await expect(friend.locator('article.photo-card')).toHaveCount(1);
    await friend.getByRole('button', { name: '친구 사진만', exact: true }).click();
    await expect(friend.locator('article.photo-card')).toHaveCount(1);
    await friend.getByRole('button', { name: 'shared-ui.png 선택', exact: true }).click();
    await friend.getByRole('button', { name: '선택 다운로드', exact: true }).click();
    const downloadEvent = friend.waitForEvent('download');
    await friend.getByRole('button', { name: 'shared-ui.png 원본 다운로드', exact: true }).click();
    expect((await downloadEvent).suggestedFilename()).toBe('shared-ui.png');
    await expect(friend.getByRole('dialog', { name: '선택 사진 다운로드' })).toContainText('다운로드 요청됨');
    await friend.getByRole('button', { name: '받았음 확인', exact: true }).click();
    await friend.getByRole('button', { name: '다운로드 창 닫기', exact: true }).click();
    await friend.getByRole('button', { name: '아직 안 받은 사진', exact: true }).click();
    await expect(friend.locator('article.photo-card')).toHaveCount(0);
    await friend.getByRole('button', { name: '이 기기 보관함으로', exact: true }).click();
    await expect(friend.getByRole('heading', { name: '우리의 첫 사진을 포개볼까요?', exact: true })).toBeVisible();
  } finally {
    await friendContext.close();
  }
});


test('a synthetic resident passkey links a second browser device to the original account', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const owner = await first.newPage();
    const newcomer = await second.newPage();
    await Promise.all([owner.goto('./'), newcomer.goto('./')]);
    const ownerSession = await first.newCDPSession(owner);
    await ownerSession.send('WebAuthn.enable');
    const options = { protocol: 'ctap2' as const, transport: 'internal' as const, hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };
    const { authenticatorId } = await ownerSession.send('WebAuthn.addVirtualAuthenticator', { options });
    const original = await approveIdentity(owner);
    await owner.evaluate(async () => {
      const path = '/phogaem/src/server/passkey.ts';
      await (await import(path)).registerPasskey();
    });
    const { credentials } = await ownerSession.send('WebAuthn.getCredentials', { authenticatorId });
    expect(credentials).toHaveLength(1);
    const secondSession = await second.newCDPSession(newcomer);
    await secondSession.send('WebAuthn.enable');
    const secondAuthenticator = await secondSession.send('WebAuthn.addVirtualAuthenticator', { options });
    await secondSession.send('WebAuthn.addCredential', { authenticatorId: secondAuthenticator.authenticatorId, credential: credentials[0]! });
    const signedIn = await newcomer.evaluate(async () => {
      const path = '/phogaem/src/server/passkey.ts';
      return (await import(path)).signInWithPasskey();
    });
    expect(signedIn).toBe(original.userId);
    expect((await client<{ userId: string }>(newcomer, 'list')).userId).toBe(original.userId);
    await newcomer.reload();
    expect((await client<{ userId: string }>(newcomer, 'list')).userId).toBe(original.userId);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test('a failed album switch keeps the previous album and its photos together until retry', async ({ page }) => {
  await page.goto('./');
  await connectApprovedUi(page);
  await page.getByLabel('보관함 이름', { exact: true }).fill('사진이 있는 여행 A');
  await page.getByRole('button', { name: '공유보관함 만들기', exact: true }).click();
  await expect(page.getByRole('button', { name: '사진 올리기', exact: true })).toBeEnabled();
  await page.getByLabel('사진 파일 선택').setInputFiles({ name: 'album-a.png', mimeType: 'image/png', buffer: Buffer.from(imageBytes) });
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  const albumA = await page.getByLabel('공유보관함 선택', { exact: true }).inputValue();
  let failed = false;
  await page.route(`${apiBase}/op/phogaem-album-get/v1?*`, async route => {
    if (!failed && new URL(route.request().url()).searchParams.get('albumId') !== albumA) {
      failed = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic unavailable' }) });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '보관함 관리', exact: true }).click();
  await page.getByLabel('보관함 이름', { exact: true }).fill('새로운 여행 B');
  await page.getByRole('button', { name: '공유보관함 만들기', exact: true }).click();
  await expect.poll(() => failed).toBe(true);
  await expect(page.getByRole('heading', { name: '사진이 있는 여행 A', exact: true })).toBeVisible();
  await expect(page.getByLabel('공유보관함 선택', { exact: true })).toHaveValue(albumA);
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await expect(page.locator('article.photo-card')).toContainText('album-a.png');
  const close = page.getByRole('button', { name: '공유보관함 관리 닫기', exact: true });
  if (await close.isVisible()) await close.click();
  await page.unroute(`${apiBase}/op/phogaem-album-get/v1?*`);
  await page.getByLabel('공유보관함 선택', { exact: true }).selectOption({ label: '새로운 여행 B' });
  await expect(page.getByRole('heading', { name: '새로운 여행 B', exact: true })).toBeVisible();
  await expect(page.locator('article.photo-card')).toHaveCount(0);
});

test('approval gates all photo operations, invitations cannot bypass it, and revocation is immediate', async ({ page, browser }) => {
  await page.goto('./');
  const pending = await client<{ userId: string }>(page, 'identity');
  const token = await page.evaluate(async () => {
    const path = '/phogaem/src/server/index.ts';
    return (await import(path)).server.token();
  });
  const operations = [
    ['phogaem-albums', 'GET'], ['phogaem-album-create', 'POST'],
    ['phogaem-album-get', 'GET'], ['phogaem-invite-create', 'POST'],
    ['phogaem-invite-join', 'POST'], ['phogaem-photo-upload', 'POST'],
    ['phogaem-photo-get', 'GET'], ['phogaem-download-state', 'POST'],
  ];
  for (const [operation, method] of operations) {
    const denied = await page.request.fetch(`${apiBase}/op/${operation}/v1`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      data: method === 'POST' ? '{}' : undefined,
    });
    expect(denied.status(), operation).toBe(403);
    expect(await denied.json()).toEqual({ error: 'approval required' });
    const unsigned = await page.request.fetch(`${apiBase}/op/${operation}/v1`, {
      method,
      headers: { 'content-type': 'application/json', 'x-mlhops-user-id': pending.userId },
      data: method === 'POST' ? '{}' : undefined,
    });
    expect(unsigned.status(), operation).toBe(401);
  }

  // The public app receives a typed approval denial and reveals only the caller's account code.
  await page.getByRole('button', { name: '공유보관함 연결', exact: true }).click();
  await page.getByRole('button', { name: '이 기기로 연결', exact: true }).click();
  await expect(page.getByRole('heading', { name: '승인 대기 중', exact: true })).toBeVisible();
  await expect(page.getByText(pending.userId.replaceAll('-', '').slice(0, 8), { exact: true })).toBeVisible();
  await expect(page.getByLabel('보관함 이름', { exact: true })).toHaveCount(0);
  await expect(page.locator('article.photo-card')).toHaveCount(0);

  // A pending user may add their own first recovery passkey without gaining photo access.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.getByRole('button', { name: '기기 연결용 패스키 등록', exact: true }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const path = '/phogaem/src/server/passkey.ts';
    return (await (await import(path)).passkeys()).length;
  })).toBe(1);
  const stillPending = await page.request.get(`${apiBase}/op/phogaem-albums/v1`, { headers: { authorization: `Bearer ${token}` } });
  expect(stillPending.status()).toBe(403);

  const ownerContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await owner.goto('./');
    await approveIdentity(owner);
    const album = await client<{ id: string }>(owner, 'create', { title: '승인 확인용 여행' });
    await client(owner, 'upload', { albumId: album.id, name: 'before-revoke.png', bytes: imageBytes });
    const invite = await client<{ token: string }>(owner, 'invite', { albumId: album.id });
    const blockedInvite = await page.request.post(`${apiBase}/op/phogaem-invite-join/v1`, {
      headers: { authorization: `Bearer ${token}` }, data: { token: invite.token },
    });
    expect(blockedInvite.status()).toBe(403);
    expect(await blockedInvite.json()).toEqual({ error: 'approval required' });

    await setApproval(page, pending.userId);
    const approvedWithoutRelogin = await page.request.get(`${apiBase}/op/phogaem-albums/v1`, { headers: { authorization: `Bearer ${token}` } });
    expect(approvedWithoutRelogin.status()).toBe(200);
    await page.getByRole('button', { name: '승인 상태 다시 확인', exact: true }).click();
    await expect(page.getByLabel('초대 코드', { exact: true })).toBeVisible();
    await page.getByLabel('초대 코드', { exact: true }).fill(invite.token);
    await page.getByRole('button', { name: '초대 코드로 참여', exact: true }).click();
    await expect(page.getByRole('heading', { name: '승인 확인용 여행', exact: true })).toBeVisible();
    await expect(page.locator('article.photo-card')).toHaveCount(1);
    // Revoke between two real uploads: a partial-success message must retain the
    // approval error type so existing protected photos and controls are cleared.
    await expect(page.getByRole('img', { name: 'before-revoke.png', exact: true })).toBeVisible();
    let uploadCount = 0;
    await page.route(`${apiBase}/op/phogaem-photo-upload/v1?*`, async route => {
      if (++uploadCount === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await setApproval(page, pending.userId, false);
        await route.fulfill({ response });
      } else await route.continue();
    });
    await page.getByLabel('사진 파일 선택').setInputFiles([
      { name: 'first-upload.png', mimeType: 'image/png', buffer: Buffer.from(imageBytes) },
      { name: 'second-upload.png', mimeType: 'image/png', buffer: Buffer.concat([Buffer.from(imageBytes), Buffer.from('synthetic metadata')]) },
    ]);
    await expect(page.getByRole('heading', { name: '승인 대기 중', exact: true })).toBeVisible();
    await expect(page.locator('article.photo-card')).toHaveCount(0);
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('처리 후 중단');
    expect(uploadCount).toBe(2);
    const revoked = await page.request.get(`${apiBase}/op/phogaem-albums/v1`, { headers: { authorization: `Bearer ${token}` } });
    expect(revoked.status()).toBe(403);
    expect(await revoked.json()).toEqual({ error: 'approval required' });
    await page.getByRole('button', { name: '승인 상태 다시 확인', exact: true }).click();
    await expect(page.getByRole('heading', { name: '승인 대기 중', exact: true })).toBeVisible();
    await expect(page.getByLabel('공유보관함 선택', { exact: true })).toHaveCount(0);
  } finally {
    await ownerContext.close();
  }
});
