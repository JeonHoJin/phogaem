import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const albumId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const friendId = '10000000-0000-4000-8000-000000000003';
const token = 'a'.repeat(43);

async function sharedAlbum(page: Page, { owner = true, title = '친구들과 함께한 제주 여행' } = {}) {
  const model = { inviteCalls: 0, nickname: '여행 주인', liveToken: '' };
  const album = { id: albumId, title, ownerId: owner ? userId : friendId, createdAt: 1 };
  await page.addInitScript(() => {
    Reflect.set(window, 'sharedInvites', []);
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => {
      (Reflect.get(window, 'sharedInvites') as ShareData[]).push(data);
    } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { Reflect.set(window, 'copiedInvite', value); } } });
  });
  await page.route('**/auth/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/token')
    ? { access_token: 'synthetic-actions-token', expires_in: 600, user_id: userId }
    : { challenge: 'synthetic-actions-challenge' } }));
  await page.route('**/op/phogaem-*/v1*', async route => {
    const operation = new URL(route.request().url()).pathname.split('/')[2];
    if (operation === 'phogaem-albums') return route.fulfill({ json: { userId, albums: [album] } });
    if (operation === 'phogaem-album-get') return route.fulfill({ json: {
      album, members: [{ id: userId, name: model.nickname, nickname: model.nickname, color: '#c5d6c4' }, { id: friendId, name: '여행 친구', nickname: '여행 친구', color: '#d8c6b5' }], photos: [],
    } });
    if (operation === 'phogaem-similar-get') return route.fulfill({ json: { groups: [], pending: 0, failed: 0, analyzed: 0 } });
    if (operation === 'phogaem-invite-create') {
      model.inviteCalls += 1;
      model.liveToken = String.fromCharCode(96 + model.inviteCalls).repeat(43);
      expect(route.request().postDataJSON()).toEqual({ albumId });
      return route.fulfill({ json: { token: model.liveToken, expiresAt: Date.now() + 86_400_000 } });
    }
    if (operation === 'phogaem-member-name-set') {
      model.nickname = route.request().postDataJSON().nickname;
      return route.fulfill({ json: { ok: true } });
    }
    throw new Error(`Unexpected synthetic album action ${operation}`);
  });
  await page.goto('./');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  return { model, album, open: () => page.getByRole('button', { name: title, exact: false }).click() };
}

const manager = (page: Page) => page.getByRole('dialog', { name: '공유보관함 관리', exact: true });
const close = (page: Page) => page.getByRole('button', { name: '공유보관함 관리 닫기', exact: true }).click();

test('creating, joining, album settings and account settings expose only their own controls', async ({ page }) => {
  const fixture = await sharedAlbum(page);
  await page.getByRole('button', { name: '새 보관함', exact: true }).click();
  await expect(manager(page).getByLabel('보관함 이름', { exact: true })).toBeVisible();
  await expect(manager(page).getByLabel('초대 코드', { exact: true })).toHaveCount(0);
  await expect(manager(page).getByRole('button', { name: '패스키 등록', exact: true })).toHaveCount(0);
  await close(page);
  await page.getByRole('button', { name: '초대 참여', exact: true }).click();
  await expect(manager(page).getByLabel('초대 코드', { exact: true })).toBeVisible();
  await expect(manager(page).getByLabel('보관함 이름', { exact: true })).toHaveCount(0);
  await close(page);
  await fixture.open();
  await page.getByRole('button', { name: '보관함 설정', exact: true }).click();
  await expect(manager(page).getByLabel('내 닉네임', { exact: true })).toBeVisible();
  await expect(manager(page).getByLabel('보관함 이름', { exact: true })).toHaveCount(0);
  await expect(manager(page).getByLabel('초대 코드', { exact: true })).toHaveCount(0);
  await expect(manager(page).getByRole('button', { name: '패스키 등록', exact: true })).toHaveCount(0);
  await manager(page).getByLabel('내 닉네임', { exact: true }).fill('새 닉네임');
  await manager(page).getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => fixture.model.nickname).toBe('새 닉네임');
  if (await manager(page).isVisible()) await close(page);
  await page.getByRole('button', { name: '계정', exact: true }).click();
  await expect(manager(page).getByRole('button', { name: '패스키 등록', exact: true })).toBeVisible();
  await expect(manager(page).getByLabel('내 닉네임', { exact: true })).toHaveCount(0);
  await expect(manager(page).getByLabel('보관함 이름', { exact: true })).toHaveCount(0);
  await expect(page.locator('p:visible,[title]')).toHaveCount(0);
});

test('inviting uses a dedicated share surface and reuses the still-valid link', async ({ page }) => {
  const fixture = await sharedAlbum(page); await fixture.open();
  await page.getByRole('button', { name: '친구 초대', exact: true }).click();
  const link = await manager(page).getByLabel('초대 링크', { exact: true }).inputValue();
  expect(new URL(link).pathname).toBe('/op/phogaem-invite-preview/v1');
  expect(new URL(link).searchParams.get('token')).toBe(token);
  await expect(manager(page).getByLabel('보관함 이름', { exact: true })).toHaveCount(0);
  await expect(manager(page).getByLabel('초대 코드', { exact: true })).toHaveCount(0);
  await manager(page).getByRole('button', { name: '공유하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'sharedInvites'))).toEqual([{ title: `포갬 - ${fixture.album.title}`, url: link }]);
  await manager(page).getByRole('button', { name: '초대 링크 복사', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'copiedInvite'))).toBe(link);
  await close(page);
  await page.getByRole('button', { name: '친구 초대', exact: true }).click();
  expect(await manager(page).getByLabel('초대 링크', { exact: true }).inputValue()).toBe(link);
  expect(fixture.model.inviteCalls).toBe(1);
});

test('an owner can replace a cached invitation after another device reissues it', async ({ page }) => {
  const fixture = await sharedAlbum(page); await fixture.open();
  await page.getByRole('button', { name: '친구 초대', exact: true }).click();
  const original = await manager(page).getByLabel('초대 링크', { exact: true }).inputValue();
  await close(page);
  fixture.model.liveToken = 'z'.repeat(43); // Another device invalidated this browser's cached capability.
  await page.getByRole('button', { name: '친구 초대', exact: true }).click();
  await expect(manager(page).getByLabel('초대 링크', { exact: true })).toHaveValue(original);
  expect(fixture.model.inviteCalls).toBe(1);
  expect(new URL(original).searchParams.get('token')).not.toBe(fixture.model.liveToken);
  await manager(page).getByRole('button', { name: '링크 재발급', exact: true }).click();
  await expect(manager(page).getByLabel('초대 링크', { exact: true })).not.toHaveValue(original);
  expect(fixture.model.inviteCalls).toBe(2);
  const replacement = await manager(page).getByLabel('초대 링크', { exact: true }).inputValue();
  expect(new URL(replacement).searchParams.get('token')).toBe(fixture.model.liveToken);
  await manager(page).getByRole('button', { name: '초대 링크 복사', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'copiedInvite'))).toBe(replacement);
});

test('a known nonowner has settings and library navigation without an unusable invitation action', async ({ page }) => {
  const fixture = await sharedAlbum(page, { owner: false }); await fixture.open();
  await expect(page.getByRole('button', { name: '친구 초대', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '보관함 설정', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '보관함 목록', exact: true }).click();
  await expect(page.getByRole('region', { name: '여행 보관함 목록', exact: true })).toBeVisible();
  expect(fixture.model.inviteCalls).toBe(0);
});

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test(`${name} album actions have touch-sized controls and no overflow or guidance`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await sharedAlbum(page, { title: '친구들과 함께한 아주아주 긴 이름의 제주도 여름 여행 보관함' }); await fixture.open();
    const names = ['보관함 목록', '친구 초대', '보관함 설정', '비교', '새로고침'];
    for (const name of names) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.width, name).toBeGreaterThanOrEqual(44);
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('p:visible,[title]')).toHaveCount(0);
    await mkdir('.local/ui-toolbar', { recursive: true });
    await page.screenshot({ path: `.local/ui-toolbar/after-${name}.png`, fullPage: true });
    await page.getByRole('button', { name: '친구 초대', exact: true }).click();
    await expect(manager(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.local/ui-toolbar/after-invite-${name}.png`, fullPage: true });
  });
}
