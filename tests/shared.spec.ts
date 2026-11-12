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
      case 'create': return api.createAlbum(payload.title as string, '합성 멤버');
      case 'invite': return api.createInvite(payload.albumId as string);
      case 'join': return api.joinInvite(payload.token as string, '합성 멤버');
      case 'get': return api.getAlbum(payload.albumId as string, payload.trashed === true);
      case 'trash': return api.setSharedTrashState(payload.albumId as string, payload.photoIds as string[], payload.trashed === true);
      case 'token': return server.token();
      case 'upload': return api.uploadSharedPhotos(payload.albumId as string, [new File([new Uint8Array(payload.bytes as number[])], payload.name as string, { type: (payload.type as string) ?? 'image/png' })]);
      case 'blob': return Array.from(new Uint8Array(await (await api.getPhotoBlob(payload.albumId as string, payload.photoId as string, payload.trashed === true)).arrayBuffer()));
      case 'state': return api.setSharedDownloadState(payload.albumId as string, payload.photoIds as string[], payload.state as 'requested' | 'received' | 'reset');
      case 'probe': {
        const response = await server.op(payload.op as string, { method: 'GET', version: 'v1', query: payload.query as Record<string, string>, headers: { 'x-mlhops-user-id': payload.forgedUser as string } });
        return response.status;
      }
      default: throw new Error('Unknown integration operation');
    }
  }, { operation, payload }) as Promise<T>;
}


async function completeNickname(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: '닉네임 설정', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('닉네임', { exact: true }).fill('');
  await expect(dialog.getByRole('button', { name: '완료', exact: true })).toBeDisabled();
  await dialog.getByLabel('닉네임', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '완료', exact: true }).click();
  await expect(dialog).toHaveCount(0);
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
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
  const identity = await client<{ userId: string }>(page, 'identity');
  await setApproval(page, identity.userId);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.getByRole('region', { name: '여행 보관함 목록' }).getByRole('button', { name: '새 보관함', exact: true }).click();
  await expect(page.getByLabel('보관함 이름', { exact: true })).toBeVisible();
  const manager = page.getByRole('dialog', { name: '공유보관함 관리' });
  await expect(manager.getByRole('button', { name: '만들기', exact: true })).toBeDisabled();
  await manager.getByLabel('닉네임', { exact: true }).fill('여행 주인');
}

async function verifyTrashRoundtrip(owner: Page, member: Page, outsider: Page) {
  const album = await client<{ id: string }>(owner, 'create', { title: '휴지통 원본 격리 검증' });
  const invite = await client<{ token: string }>(owner, 'invite', { albumId: album.id });
  await client(member, 'join', { token: invite.token });
  await client(member, 'upload', { albumId: album.id, name: 'member.png', bytes: imageBytes });
  const ownerBytes = [...imageBytes, 7];
  await client(owner, 'upload', { albumId: album.id, name: 'owner.png', bytes: ownerBytes });
  const active = await client<{ photos: Array<{ id: string; name: string }> }>(member, 'get', { albumId: album.id });
  const ownId = active.photos.find(photo => photo.name === 'member.png')!.id;
  const otherId = active.photos.find(photo => photo.name === 'owner.png')!.id;
  const memberToken = await client<string>(member, 'token');
  const outsiderToken = await client<string>(outsider, 'token');
  for (const [token, ids, status] of [[memberToken, [ownId, otherId], 403], [outsiderToken, [ownId], 404]] as const) {
    const rejected = await member.request.post(`${apiBase}/op/phogaem-trash-set/v1`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      data: { albumId: album.id, photoIds: ids, trashed: true },
    });
    expect(rejected.status()).toBe(status);
  }
  expect((await client<{ photos: unknown[] }>(member, 'get', { albumId: album.id })).photos).toHaveLength(2);
  expect((await client<{ photos: unknown[] }>(member, 'get', { albumId: album.id, trashed: true })).photos).toHaveLength(0);
  await client(member, 'trash', { albumId: album.id, photoIds: [ownId], trashed: true });
  expect((await client<{ photos: Array<{ id: string }> }>(owner, 'get', { albumId: album.id })).photos.map(photo => photo.id)).toEqual([otherId]);
  const bin = await client<{ photos: Array<{ id: string; trashedAt: number }> }>(member, 'get', { albumId: album.id, trashed: true });
  expect(bin.photos).toHaveLength(1); expect(bin.photos[0]!.id).toBe(ownId); expect(bin.photos[0]!.trashedAt).toBeGreaterThan(0);
  const query = new URLSearchParams({ albumId: album.id, photoId: ownId });
  const hiddenOriginal = await member.request.get(`${apiBase}/op/phogaem-photo-get/v1?${query}`, { headers: { authorization: `Bearer ${memberToken}` } });
  expect(hiddenOriginal.status()).toBe(404);
  expect(await client(member, 'blob', { albumId: album.id, photoId: ownId, trashed: true })).toEqual(imageBytes);
  const uploadQuery = new URLSearchParams({ albumId: album.id, name: 'same-again.png' });
  const reupload = await member.request.post(`${apiBase}/op/phogaem-photo-upload/v1?${uploadQuery}`, {
    headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'image/png' }, data: Buffer.from(imageBytes),
  });
  expect(reupload.status()).toBe(409);
  await client(member, 'trash', { albumId: album.id, photoIds: [ownId], trashed: false });
  expect((await client<{ photos: unknown[] }>(member, 'get', { albumId: album.id })).photos).toHaveLength(2);
  expect((await client<{ photos: unknown[] }>(member, 'get', { albumId: album.id, trashed: true })).photos).toHaveLength(0);
  expect(await client(member, 'blob', { albumId: album.id, photoId: ownId })).toEqual(imageBytes);
  await client(owner, 'trash', { albumId: album.id, photoIds: [ownId], trashed: true });
  expect((await client<{ photos: unknown[] }>(member, 'get', { albumId: album.id, trashed: true })).photos).toHaveLength(1);
  await client(member, 'trash', { albumId: album.id, photoIds: [ownId], trashed: false });
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

    await test.step('trash isolates originals and preserves bytes across authorized restoration', async () => {
      await verifyTrashRoundtrip(pages[0]!, pages[1]!, pages[3]!);
    });
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('shared-library UI creates, invites, shares and downloads an original after explicit connection', async ({ page, browser }) => {
  await page.goto('./');
  await connectApprovedUi(page);
  await page.getByLabel('보관함 이름', { exact: true }).fill('브라우저에서 만든 여행');
  await page.getByLabel('닉네임', { exact: true }).fill('  여행 주인  ');
  const creation = page.waitForRequest(request => request.url().includes('/op/phogaem-album-create/'));
  await page.getByRole('dialog', { name: '공유보관함 관리' }).getByRole('button', { name: '만들기', exact: true }).click();
  expect((await creation).postDataJSON()).toEqual({ title: '브라우저에서 만든 여행', nickname: '여행 주인' });
  await expect(page.getByRole('dialog', { name: '닉네임 설정', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('공유보관함 선택', { exact: true })).toBeVisible();
  const createdId = await page.getByLabel('공유보관함 선택', { exact: true }).inputValue();
  const created = await client<{ members: Array<{ name: string; nickname: string }> }>(page, 'get', { albumId: createdId });
  expect(created.members[0]).toMatchObject({ name: '여행 주인', nickname: '여행 주인' });
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByRole('heading', { name: '브라우저에서 만든 여행', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '올리기', exact: true })).toBeEnabled();
  await page.getByLabel('사진 파일 선택').setInputFiles({ name: 'shared-ui.png', mimeType: 'image/png', buffer: Buffer.from(imageBytes) });
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await expect(page.getByRole('img', { name: 'shared-ui.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '친구 초대', exact: true }).click();
  const invitation = await page.getByLabel('초대 링크', { exact: true }).inputValue();
  const previewUrl = new URL(invitation);
  expect(previewUrl.origin).toBe(apiBase);
  expect(previewUrl.pathname).toBe('/op/phogaem-invite-preview/v1');
  expect(previewUrl.hash).toBe('');
  const preview = await page.request.get(invitation, { headers: { 'user-agent': 'KakaoTalk-Scrap/1.0' } });
  expect(preview.status()).toBe(200);
  expect(preview.headers()['content-type']).toContain('text/html');
  expect(await preview.text()).toContain('property="og:title" content="포갬 - 브라우저에서 만든 여행"');
  const previewContext = await browser.newContext();
  try {
    const previewPage = await previewContext.newPage();
    // Exercise the real server HTML/CSP, but intercept the fixed production app destination.
    await previewPage.route('https://jeonhojin.github.io/phogaem/**', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Synthetic invitation destination</title>',
    }));
    await previewPage.goto(invitation, { waitUntil: 'commit' });
    await expect(previewPage).toHaveURL(`https://jeonhojin.github.io/phogaem/#invite=${previewUrl.searchParams.get('token')}`);
  } finally { await previewContext.close(); }
  const friendContext = await browser.newContext();
  try {
    const friend = await friendContext.newPage();
    await friend.goto('./');
    await connectApprovedUi(friend);
    await friend.getByRole('button', { name: '공유보관함 관리 닫기', exact: true }).click();
    await friend.getByRole('region', { name: '여행 보관함 목록' }).getByRole('button', { name: '초대 참여', exact: true }).click();
    await friend.getByLabel('초대 코드', { exact: true }).fill(invitation);
    await friend.getByRole('dialog', { name: '공유보관함 관리' }).getByRole('button', { name: '참여', exact: true }).click();
    await completeNickname(friend, '여행 친구');
    await expect(friend.locator('article.photo-card')).toHaveCount(1);
    await friend.getByRole('button', { name: '내 사진 제외', exact: true }).click();
    await expect(friend.locator('article.photo-card')).toHaveCount(1);
    await friend.getByRole('button', { name: 'shared-ui.png 선택', exact: true }).click();
    await friend.getByRole('button', { name: '선택 다운로드', exact: true }).click();
    const downloadEvent = friend.waitForEvent('download');
    await friend.getByRole('button', { name: 'shared-ui.png 원본 다운로드', exact: true }).click();
    expect((await downloadEvent).suggestedFilename()).toBe('shared-ui.png');
    await expect(friend.getByRole('button', { name: '받았음 확인', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await friend.getByRole('button', { name: '받았음 확인', exact: true }).click();
    await friend.getByRole('button', { name: '다운로드 창 닫기', exact: true }).click();
    await friend.getByRole('button', { name: '받은 사진 제외', exact: true }).click();
    await expect(friend.locator('article.photo-card')).toHaveCount(0);
    await friend.getByRole('button', { name: '계정', exact: true }).click();
    await friend.getByRole('button', { name: '기기 보관함', exact: true }).click();
    await expect(friend.getByRole('heading', { name: '기기 보관함', exact: true })).toBeVisible();
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
  await page.getByRole('dialog', { name: '공유보관함 관리' }).getByRole('button', { name: '만들기', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '닉네임 설정', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '올리기', exact: true })).toBeEnabled();
  await page.getByLabel('사진 파일 선택').setInputFiles({ name: 'album-a.png', mimeType: 'image/png', buffer: Buffer.from(imageBytes) });
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  const albumA = await page.getByLabel('공유보관함 선택', { exact: true }).inputValue();
  await client(page, 'create', { title: '새로운 여행 B' });
  await page.reload();
  await page.getByRole('button', { name: '사진이 있는 여행 A', exact: false }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  let failed = false;
  await page.route(`${apiBase}/op/phogaem-album-get/v1?*`, async route => {
    if (!failed && new URL(route.request().url()).searchParams.get('albumId') !== albumA) {
      failed = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic unavailable' }) });
    } else await route.continue();
  });
  await page.getByLabel('공유보관함 선택', { exact: true }).selectOption({ label: '새로운 여행 B' });
  await expect.poll(() => failed).toBe(true);
  await expect(page.getByRole('heading', { name: '사진이 있는 여행 A', exact: true })).toBeVisible();
  await expect(page.getByLabel('공유보관함 선택', { exact: true })).toHaveValue(albumA);
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'album-a.png 크게 보기', exact: true })).toBeVisible();
  await page.unroute(`${apiBase}/op/phogaem-album-get/v1?*`);
  await page.getByLabel('공유보관함 선택', { exact: true }).selectOption({ label: '새로운 여행 B' });
  await expect(page.getByRole('dialog', { name: '닉네임 설정', exact: true })).toHaveCount(0);
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
    ['phogaem-thumbnail-get', 'GET'], ['phogaem-processing-retry', 'POST'], ['phogaem-similar-get', 'GET'],
    ['phogaem-member-name-set', 'POST'], ['phogaem-representative-set', 'POST'], ['phogaem-similar-exclude', 'POST'], ['phogaem-trash-set', 'POST'],
    ['phogaem-push-status', 'POST'], ['phogaem-push-subscribe', 'POST'],
    ['phogaem-push-unsubscribe', 'POST'], ['phogaem-push-message', 'POST'],
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
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
  await expect(page.getByText(pending.userId.replaceAll('-', '').slice(0, 8), { exact: true })).toBeVisible();
  await expect(page.getByLabel('보관함 이름', { exact: true })).toHaveCount(0);
  await expect(page.locator('article.photo-card')).toHaveCount(0);

  // A pending user may add their own first recovery passkey without gaining photo access.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.getByRole('button', { name: '패스키 등록', exact: true }).click();
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
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.getByRole('region', { name: '여행 보관함 목록' }).getByRole('button', { name: '초대 참여', exact: true }).click();
    await expect(page.getByLabel('초대 코드', { exact: true })).toBeVisible();
    await page.getByLabel('초대 코드', { exact: true }).fill(invite.token);
    await page.getByRole('dialog', { name: '공유보관함 관리' }).getByRole('button', { name: '참여', exact: true }).click();
    await completeNickname(page, '승인된 친구');
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
    await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
    await expect(page.locator('article.photo-card')).toHaveCount(0);
    await expect(page.getByRole('region', { name: '계정 승인 대기' }).getByRole('button', { name: '새로고침' })).toBeEnabled();
    expect(uploadCount).toBe(2);
    const revoked = await page.request.get(`${apiBase}/op/phogaem-albums/v1`, { headers: { authorization: `Bearer ${token}` } });
    expect(revoked.status()).toBe(403);
    expect(await revoked.json()).toEqual({ error: 'approval required' });
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(page.getByRole('region', { name: '계정 승인 대기', exact: true })).toBeVisible();
    await expect(page.getByLabel('공유보관함 선택', { exact: true })).toHaveCount(0);
  } finally {
    await ownerContext.close();
  }
});

test('an invitation survives explicit login and pending approval before joining its trip', async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await owner.goto('./');
    await approveIdentity(owner);
    const album = await client<{ id: string }>(owner, 'create', { title: '초대로 만난 여행' });
    const invite = await client<{ token: string }>(owner, 'invite', { albumId: album.id });
    const guest = await guestContext.newPage();
    await guest.goto(`./#invite=${encodeURIComponent(invite.token)}`);
    const manager = guest.getByRole('dialog', { name: '공유보관함 관리' });
    await expect(manager.getByRole('button', { name: '시작', exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '시작', exact: true }).click();
    const pending = guest.getByRole('region', { name: '계정 승인 대기' });
    await expect(pending).toBeVisible();
    await expect(guest.locator('p:visible, [title]')).toHaveCount(0);
    const identity = await client<{ userId: string }>(guest, 'identity');
    await setApproval(guest, identity.userId);
    await guest.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(guest.getByLabel('보관함 이름', { exact: true })).toHaveCount(0);
    await completeNickname(guest, '초대된 친구');
    const joined = await client<{ members: Array<{ id: string; name: string; nickname: string }> }>(guest, 'get', { albumId: album.id });
    expect(joined.members.find(member => member.id === identity.userId)).toMatchObject({ name: '초대된 친구', nickname: '초대된 친구' });
    await expect(guest.getByRole('heading', { name: '초대로 만난 여행', exact: true })).toBeVisible();
    await expect(guest.getByLabel('공유보관함 선택', { exact: true })).toHaveValue(album.id);
    await expect(guest.locator('p:visible, [title]')).toHaveCount(0);
  } finally {
    await Promise.all([ownerContext.close(), guestContext.close()]);
  }
});

for (const outcome of ['success', 'approval-denied'] as const) {
  test(`a delayed shared resume ${outcome} cannot replace an explicitly opened local library`, async ({ page }) => {
    await page.goto('./');
    await connectApprovedUi(page);
    await page.getByRole('button', { name: '공유보관함 관리 닫기', exact: true }).click();
    let release!: () => void;
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`${apiBase}/op/phogaem-albums/v1`, async route => {
      const response = await route.fetch();
      started();
      await gate;
      if (outcome === 'success') await route.fulfill({ response });
      else await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'approval required' }) });
    });
    await page.reload();
    await requested;
    await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
    await expect(page.getByRole('heading', { name: '기기 보관함', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '샘플', exact: true }).click();
    await expect(page.locator('article.photo-card')).toHaveCount(12);
    const delivered = page.waitForResponse(response => response.url() === `${apiBase}/op/phogaem-albums/v1`);
    release();
    await delivered;
    await expect(page.getByRole('heading', { name: '기기 보관함', exact: true })).toBeVisible();
    await expect(page.locator('article.photo-card')).toHaveCount(12);
    await expect(page.getByRole('region', { name: '계정 승인 대기' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '여행 보관함 목록' })).toHaveCount(0);
  });
}

test('a partially failed shared upload shows committed photos and retries only the remaining original', async ({ page }) => {
  await page.goto('./');
  await connectApprovedUi(page);
  await page.getByLabel('보관함 이름', { exact: true }).fill('업로드 복구 여행');
  await page.getByRole('dialog', { name: '공유보관함 관리' }).getByRole('button', { name: '만들기', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '닉네임 설정', exact: true })).toHaveCount(0);
  const albumId = await page.getByLabel('공유보관함 선택', { exact: true }).inputValue();
  let attempts = 0;
  let failedOnce = false;
  let committed!: () => void;
  const committedResponse = new Promise<void>(resolve => { committed = resolve; });
  await page.route(`${apiBase}/op/phogaem-photo-upload/v1?*`, async route => {
    attempts += 1;
    const name = new URL(route.request().url()).searchParams.get('name');
    if (name === 'retry.png' && !failedOnce) {
      failedOnce = true;
      await committedResponse;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic interrupted upload' }) });
    } else {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({ response });
      if (name === 'committed.png') committed();
    }
  });
  await page.getByLabel('사진 파일 선택').setInputFiles([
    { name: 'retry.png', mimeType: 'image/png', buffer: Buffer.concat([Buffer.from(imageBytes), Buffer.from('second synthetic original')]) },
    { name: 'committed.png', mimeType: 'image/png', buffer: Buffer.from(imageBytes) },
  ]);
  await expect(page.getByRole('group', { name: '작업 실패' })).toBeVisible();
  await expect(page.locator('article.photo-card')).toHaveCount(1);
  const queue = page.getByRole('region', { name: '업로드 파일' });
  await expect(queue).toContainText('retry.png');
  await expect(queue).not.toContainText('committed.png');
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
  await queue.getByRole('button', { name: '올리기', exact: true }).click();
  await expect(page.locator('article.photo-card')).toHaveCount(2);
  await expect(queue).toHaveCount(0);
  expect(attempts).toBe(3);
  const final = await client<{ photos: Array<{ name: string; importCount: number }> }>(page, 'get', { albumId });
  expect(final.photos.map(photo => photo.importCount)).toEqual([1, 1]);
});

test('new libraries default to the browser-local yymmdd travel date', async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: 'Asia/Seoul' });
  try {
    const page = await context.newPage();
    // UTC is still January 1: the product default must use the user's January 2.
    await page.clock.setFixedTime(new Date('2026-01-01T15:30:00Z'));
    await page.goto('./');
    await connectApprovedUi(page);
    await expect(page.getByLabel('보관함 이름', { exact: true })).toHaveValue('260102 여행');
  } finally {
    await context.close();
  }
});

test('parallel completions update photos and the remaining queue before the batch finishes', async ({ page }) => {
  await page.goto('./');
  await connectApprovedUi(page);
  await page.getByLabel('보관함 이름', { exact: true }).fill('병렬 완료 여행');
  await page.getByRole('dialog', { name: '공유보관함 관리' }).getByRole('button', { name: '만들기', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '닉네임 설정', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('공유보관함 선택', { exact: true })).toBeVisible();
  let releaseFirst!: () => void;
  let releaseThird!: () => void;
  let releaseOldDuplicate!: () => void;
  let releaseFinalMetadata!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const thirdGate = new Promise<void>(resolve => { releaseThird = resolve; });
  const oldDuplicateGate = new Promise<void>(resolve => { releaseOldDuplicate = resolve; });
  const finalMetadataGate = new Promise<void>(resolve => { releaseFinalMetadata = resolve; });
  let holdFinalMetadata = false;
  let finalMetadataHeld = false;
  let oldDuplicateCommitted = false;
  let firstCommitted = false;
  let thirdCommitted = false;
  let albumReads = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/op/phogaem-album-get/v1') albumReads += 1;
  });
  await page.route(`${apiBase}/op/phogaem-photo-upload/v1?*`, async route => {
    const name = new URL(route.request().url()).searchParams.get('name');
    if (name === 'slow-first.png' || name === 'held-third.png' || name === 'old-duplicate.png') {
      // Commit against the real sidecar, then delay only the browser's response.
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      if (name === 'slow-first.png') { firstCommitted = true; await firstGate; }
      else if (name === 'held-third.png') { thirdCommitted = true; await thirdGate; }
      else { oldDuplicateCommitted = true; await oldDuplicateGate; }
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.route(`${apiBase}/op/phogaem-album-get/v1?*`, async route => {
    if (holdFinalMetadata) { finalMetadataHeld = true; await finalMetadataGate; }
    await route.continue();
  });
  const fastBytes = Buffer.concat([Buffer.from(imageBytes), Buffer.from('fast synthetic original')]);
  try {
    await page.getByLabel('사진 파일 선택').setInputFiles([
      { name: 'slow-first.png', mimeType: 'image/png', buffer: Buffer.from(imageBytes) },
      { name: 'fast-second.png', mimeType: 'image/png', buffer: fastBytes },
    ]);
    await expect.poll(() => firstCommitted).toBe(true);
    const fastCard = page.locator('article.photo-card').filter({ hasText: 'fast-second.png' });
    await expect(fastCard).toHaveCount(1);
    await expect(page.locator('article.photo-card')).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    const queue = page.getByRole('region', { name: '업로드 파일' });
    await expect(queue).toContainText('slow-first.png');
    await expect(queue).not.toContainText('fast-second.png');
    expect(albumReads).toBe(0);
    releaseFirst();
    await expect(page.locator('article.photo-card')).toHaveCount(2);
    await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'false');
    await expect(queue).toHaveCount(0);

    await page.getByLabel('사진 파일 선택').setInputFiles([
      { name: 'fast-renamed-duplicate.png', mimeType: 'image/png', buffer: fastBytes },
      { name: 'held-third.png', mimeType: 'image/png', buffer: Buffer.concat([Buffer.from(imageBytes), Buffer.from('third synthetic original')]) },
    ]);
    await expect.poll(() => thirdCommitted).toBe(true);
    await expect(fastCard.getByLabel('중복 2', { exact: true })).toBeVisible();
    await expect(page.locator('article.photo-card')).toHaveCount(2);
    await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    await expect(queue).toContainText('held-third.png');
    await expect(queue).not.toContainText('fast-renamed-duplicate.png');
    releaseThird();
    await expect(page.locator('article.photo-card')).toHaveCount(3);
    await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'false');
    await expect(queue).toHaveCount(0);

    // Two duplicate commits also return snapshots: a late older snapshot must not
    // overwrite the newer import count while the final metadata refresh is pending.
    holdFinalMetadata = true;
    await page.getByLabel('사진 파일 선택').setInputFiles([
      { name: 'old-duplicate.png', mimeType: 'image/png', buffer: fastBytes },
      { name: 'new-duplicate.png', mimeType: 'image/png', buffer: fastBytes },
    ]);
    await expect.poll(() => oldDuplicateCommitted).toBe(true);
    await expect(fastCard.getByLabel('중복 4', { exact: true })).toBeVisible();
    releaseOldDuplicate();
    await expect.poll(() => finalMetadataHeld).toBe(true);
    await expect(fastCard.getByLabel('중복 4', { exact: true })).toBeVisible();
    releaseFinalMetadata();
    await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'false');
  } finally {
    releaseFirst();
    releaseThird();
    releaseOldDuplicate();
    releaseFinalMetadata();
  }
});



test('approved invitations open directly on reload and hash change, and replaced links recover', async ({ browser }) => {
  const ownerContext = await browser.newContext(); const guestContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage(); await owner.goto('./'); await approveIdentity(owner);
    const album = await client<{ id: string }>(owner, 'create', { title: '바로 참여 여행' });
    const invitation = await client<{ token: string }>(owner, 'invite', { albumId: album.id });
    const guest = await guestContext.newPage(); await guest.goto('./'); await approveIdentity(guest);
    await guest.getByRole('button', { name: '시작', exact: true }).click();
    await expect(guest.getByRole('region', { name: '여행 보관함 목록' })).toBeVisible();
    for (const entry of ['reload', 'hashchange']) {
      if (entry === 'reload') await guest.goto('about:blank');
      let joins = 0;
      const countJoin = (request: import('@playwright/test').Request) => { if (request.url().includes('/op/phogaem-invite-join/')) joins += 1; };
      guest.on('request', countJoin);
      await guest.goto(`./#invite=${encodeURIComponent(invitation.token)}`);
      if (entry === 'reload') await completeNickname(guest, '다시 만난 친구');
      else await expect(guest.getByRole('dialog', { name: '닉네임 설정', exact: true })).toHaveCount(0);
      await expect(guest.getByRole('heading', { name: '바로 참여 여행', exact: true })).toBeVisible();
      await expect(guest.getByRole('dialog', { name: '공유보관함 관리' })).toHaveCount(0);
      expect(new URL(guest.url()).hash).toBe(''); expect(joins).toBe(1);
      guest.off('request', countJoin);
    }
    const result = await client<{ members: unknown[] }>(guest, 'get', { albumId: album.id });
    expect(result.members).toHaveLength(2);
    const fresh = await client<{ token: string }>(owner, 'invite', { albumId: album.id });
    await guest.goto(`./#invite=${encodeURIComponent(invitation.token)}`);
    await expect(guest.getByRole('img', { name: '사용할 수 없는 초대', exact: true })).toBeVisible();
    await expect(guest.getByLabel('보관함 이름', { exact: true })).toHaveCount(0);
    await expect(guest.locator('p:visible, [title]')).toHaveCount(0);
    await guest.getByLabel('초대 링크', { exact: true }).fill(`${new URL(guest.url()).origin}/phogaem/#invite=${fresh.token}`);
    await guest.getByRole('dialog', { name: '공유보관함 관리' }).getByRole('button', { name: '참여', exact: true }).click();
    await expect(guest.getByRole('dialog', { name: '공유보관함 관리' })).toHaveCount(0);
    await expect(guest.getByRole('heading', { name: '바로 참여 여행', exact: true })).toBeVisible();
  } finally { await Promise.all([ownerContext.close(), guestContext.close()]); }
});


test('shared videos keep independent items and original bytes without image processing', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const bytes = Array.from(Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex'));
  try {
    await page.goto('./');
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
    await approveIdentity(page);
    const album = await client<{ id: string }>(page, 'create', { title: '영상 원본 검증' });
    for (let index = 0; index < 2; index += 1) {
      const result = await client<{ added: number; duplicates: number }>(page, 'upload', { albumId: album.id, name: 'synthetic.mp4', type: 'video/mp4', bytes });
      expect(result).toMatchObject({ added: 1, duplicates: 0 });
    }
    const result = await client<{ photos: Array<{ id: string; type: string; processing?: unknown; importCount: number }> }>(page, 'get', { albumId: album.id });
    expect(result.photos).toHaveLength(2);
    expect(new Set(result.photos.map(photo => photo.id)).size).toBe(2);
    for (const photo of result.photos) {
      expect(photo.type).toBe('video/mp4');
      expect(photo.processing).toBeUndefined();
      expect(photo.importCount).toBe(1);
      expect(await client(page, 'blob', { albumId: album.id, photoId: photo.id })).toEqual(bytes);
    }
    await page.getByRole('button', { name: '시작', exact: true }).click();
    await page.getByRole('button', { name: '영상 원본 검증', exact: false }).click();
    await expect(page.locator('article.photo-card')).toHaveCount(2);
    await page.getByRole('button', { name: '중복', exact: true }).click();
    await expect(page.locator('article.photo-card')).toHaveCount(0);
  } finally { await context.close(); }
});
