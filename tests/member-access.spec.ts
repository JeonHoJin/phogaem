import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const albumId = '30000000-0000-4000-8000-000000000001';
const me = '30000000-0000-4000-8000-000000000002';
const friend = '30000000-0000-4000-8000-000000000003';
const manager = (page: Page) => page.getByRole('dialog', { name: '공유보관함 관리', exact: true });
const confirmation = (page: Page) => page.getByRole('dialog', { name: '멤버 변경 확인', exact: true });
async function openAlbum(page: Page, owner = true) {
  const album = { id: albumId, title: '멤버 관리 여행', ownerId: owner ? me : friend, createdAt: 1 };
  const otherAlbum = { id: '30000000-0000-4000-8000-000000000004', title: '다른 여행', ownerId: me, createdAt: 2 };
  const model = {
    members: [{ id: me, name: '나', nickname: '나', color: '#c5d6c4' }, { id: friend, name: '여행 친구', nickname: '여행 친구', color: '#d8c6b5' }],
    status: 200, listStatus: 200, inviteCalls: 0, removals: [] as Array<{ albumId: string; userId: string }>,
  };
  await page.route('**/auth/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/token')
    ? { access_token: 'synthetic-member-token', expires_in: 600, user_id: me } : { challenge: 'synthetic-member-challenge' } }));
  await page.route('**/op/phogaem-*/v1*', async route => {
    const operation = new URL(route.request().url()).pathname.split('/')[2];
    if (operation === 'phogaem-albums') return route.fulfill({ status: model.listStatus, json: model.listStatus === 200
      ? { userId: me, albums: model.members.some(member => member.id === me) ? [album, otherAlbum] : [otherAlbum] } : { error: 'synthetic list unavailable' } });
    if (operation === 'phogaem-album-get') return route.fulfill({ json: { album, members: model.members, photos: [] } });
    if (operation === 'phogaem-similar-get') return route.fulfill({ json: { groups: [], pending: 0, failed: 0, analyzed: 0 } });
    if (operation === 'phogaem-push-status') return route.fulfill({ json: { enabled: false, publicKey: null } });
    if (operation === 'phogaem-invite-create') {
      model.inviteCalls += 1;
      return route.fulfill({ json: { token: String.fromCharCode(96 + model.inviteCalls).repeat(43), expiresAt: Date.now() + 86400000 } });
    }
    if (operation === 'phogaem-member-remove') {
      const body = route.request().postDataJSON() as { albumId: string; userId: string };
      model.removals.push(body);
      if (model.status !== 200) return route.fulfill({ status: model.status, json: { error: 'synthetic member removal failure' } });
      expect(body.albumId).toBe(albumId);
      expect(body.userId).not.toBe(album.ownerId);
      expect(owner || body.userId === me).toBe(true);
      model.members = model.members.filter(member => member.id !== body.userId);
      return route.fulfill({ json: { ok: true } });
    }
    throw new Error(`Unexpected member operation: ${operation}`);
  });
  await page.goto('./');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '기기 계정으로 계속', exact: true }).click();
  await page.getByRole('button', { name: album.title, exact: false }).click();
  await expect(page.getByRole('heading', { name: album.title, exact: true })).toBeVisible();
  return model;
}

test('owner removes only another member with explicit confirmation and replaces cached invitation', async ({ page }) => {
  const model = await openAlbum(page);
  await page.getByRole('button', { name: '친구 초대', exact: true }).click();
  const oldLink = await manager(page).getByLabel('초대 링크', { exact: true }).inputValue();
  await page.getByRole('button', { name: '공유보관함 관리 닫기', exact: true }).click();
  await page.getByRole('button', { name: '보관함 설정', exact: true }).click();
  await expect(manager(page).getByRole('button', { name: '보관함 나가기', exact: true })).toHaveCount(0);
  await expect(manager(page).getByRole('button', { name: '나 내보내기', exact: true })).toHaveCount(0);
  await manager(page).getByRole('button', { name: '여행 친구 내보내기', exact: true }).click();
  await expect(confirmation(page).getByRole('heading', { name: '여행 친구', exact: true })).toBeVisible();
  expect(model.removals).toEqual([]);
  await confirmation(page).getByRole('button', { name: '멤버 변경 취소', exact: true }).click();
  expect(model.members).toHaveLength(2);
  await manager(page).getByRole('button', { name: '여행 친구 내보내기', exact: true }).click();
  await confirmation(page).getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(confirmation(page)).toHaveCount(0);
  await expect(manager(page).locator('.settings-member-list li')).toHaveCount(1);
  expect(model.removals).toEqual([{ albumId, userId: friend }]);
  await page.getByRole('button', { name: '공유보관함 관리 닫기', exact: true }).click();
  await page.getByRole('button', { name: '친구 초대', exact: true }).click();
  await expect(manager(page).getByLabel('초대 링크', { exact: true })).not.toHaveValue(oldLink);
  expect(model.inviteCalls).toBe(2);
});

test('failed removal retains the member and permits explicit retry from confirmation', async ({ page }) => {
  const model = await openAlbum(page); model.status = 503;
  await page.getByRole('button', { name: '보관함 설정', exact: true }).click();
  await manager(page).getByRole('button', { name: '여행 친구 내보내기', exact: true }).click();
  await confirmation(page).getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(confirmation(page).getByRole('group', { name: '작업 실패', exact: true })).toBeVisible();
  expect(model.members).toHaveLength(2);
  await expect(confirmation(page).getByRole('button', { name: '내보내기', exact: true })).toBeEnabled();
  model.status = 200;
  await confirmation(page).getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(confirmation(page)).toHaveCount(0);
  await expect(manager(page).locator('.settings-member-list li')).toHaveCount(1);
  expect(model.removals).toHaveLength(2);
});

test('a member cannot remove peers and self-leave returns to the album list', async ({ page }) => {
  const model = await openAlbum(page, false);
  await page.getByRole('button', { name: '보관함 설정', exact: true }).click();
  await expect(manager(page).getByRole('button', { name: /내보내기/ })).toHaveCount(0);
  await manager(page).getByRole('button', { name: '보관함 나가기', exact: true }).click();
  await expect(confirmation(page).getByRole('heading', { name: '멤버 관리 여행', exact: true })).toBeVisible();
  await confirmation(page).getByRole('button', { name: '나가기', exact: true }).click();
  await expect(page.getByRole('region', { name: '여행 보관함 목록', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '멤버 관리 여행', exact: true })).toHaveCount(0);
  expect(model.removals).toEqual([{ albumId, userId: me }]);
});

test('successful self-leave hides the departed album even when list refresh fails', async ({ page }) => {
  const model = await openAlbum(page, false); model.listStatus = 503;
  await page.getByRole('button', { name: '보관함 설정', exact: true }).click();
  await manager(page).getByRole('button', { name: '보관함 나가기', exact: true }).click();
  await confirmation(page).getByRole('button', { name: '나가기', exact: true }).click();
  await expect(page.getByRole('region', { name: '여행 보관함 목록', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '멤버 관리 여행', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '멤버 관리 여행', exact: false })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '사진 보관함', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '다른 여행', exact: false })).toBeVisible();
  expect(model.removals).toEqual([{ albumId, userId: me }]);
});
