import { test, expect } from '@playwright/test';
import type { Page, Locator, CDPSession } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

type Point = { x: number; y: number };
const grid = (page: Page) => page.locator('.photo-grid');
const cards = (page: Page) => page.locator('article.photo-card');
const selectionMode = (page: Page) => page.getByRole('button', { name: '사진 선택', exact: true });

async function seed(page: Page) {
  await page.goto('./');
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  await page.getByRole('button', { name: '샘플', exact: true }).click();
  await expect(cards(page)).toHaveCount(12);
}

async function center(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

async function alignGrid(page: Page) {
  const top = await grid(page).evaluate(element => element.getBoundingClientRect().top + window.scrollY);
  await page.evaluate(y => window.scrollTo(0, Math.max(0, y - 100)), top);
  await frame(page);
}

async function selectedIndices(page: Page) {
  return cards(page).evaluateAll(elements => elements.flatMap((element, index) =>
    element.querySelector('.photo-select')?.getAttribute('aria-pressed') === 'true' ? [index] : []));
}

async function expectSelected(page: Page, indices: number[]) {
  await expect.poll(() => selectedIndices(page)).toEqual(indices);
}

async function frame(page: Page, count = 2) {
  await page.evaluate(async n => {
    for (let i = 0; i < n; i += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }, count);
}

async function touch(session: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: Point[]) {
  await session.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((point, id) => ({ ...point, id, radiusX: 4, radiusY: 4, force: 1 })),
  });
}

async function touchMove(session: CDPSession, from: Point[], to: Point[], steps = 6) {
  for (let step = 1; step <= steps; step += 1) {
    await touch(session, 'touchMove', from.map((point, index) => ({
      x: point.x + (to[index]!.x - point.x) * step / steps,
      y: point.y + (to[index]!.y - point.y) * step / steps,
    })));
  }
}

async function columns(page: Page) {
  return Number(await grid(page).getAttribute('data-columns'));
}

test('mouse sweep selects a range, restores reversed cells and preserves selection outside the range', async ({ page }) => {
  await seed(page);
  await cards(page).nth(8).locator('.photo-select').click();
  await selectionMode(page).click();
  await alignGrid(page);
  const first = await center(cards(page).nth(0).locator('.photo-frame'));
  const fourth = await center(cards(page).nth(3).locator('.photo-frame'));
  const second = await center(cards(page).nth(1).locator('.photo-frame'));
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  try {
    await page.mouse.move(fourth.x, fourth.y, { steps: 12 });
    await expectSelected(page, [0, 1, 2, 3, 8]);
    await page.mouse.move(second.x, second.y, { steps: 8 });
    await expectSelected(page, [0, 1, 8]);
  } finally { await page.mouse.up(); }
  await expect(page.getByRole('dialog', { name: '사진 크게 보기' })).toHaveCount(0);
});

test('sweeping from a selected photo erases that range and normal photo clicks still open the viewer', async ({ page }) => {
  await seed(page);
  await cards(page).nth(0).locator('.photo-select').click();
  await cards(page).nth(1).locator('.photo-select').click();
  await cards(page).nth(8).locator('.photo-select').click();
  await selectionMode(page).click();
  await alignGrid(page);
  const first = await center(cards(page).nth(0).locator('.photo-frame'));
  const second = await center(cards(page).nth(1).locator('.photo-frame'));
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(second.x, second.y, { steps: 8 });
  await page.mouse.up();
  await expectSelected(page, [8]);
  await selectionMode(page).click();
  await cards(page).nth(0).locator('.photo-open').click();
  await expect(page.getByRole('dialog', { name: '사진 크게 보기' })).toBeVisible();
});

test('ending selection mode cancels an old contact even when its release outlives the click guard timer', async ({ page }) => {
  await seed(page);
  await selectionMode(page).click();
  await alignGrid(page);
  const first = await center(cards(page).nth(0).locator('.photo-frame'));
  const second = await center(cards(page).nth(1).locator('.photo-frame'));
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  try {
    await page.mouse.move(second.x, second.y, { steps: 8 });
    await expectSelected(page, [0, 1]);
    await selectionMode(page).focus();
    await page.keyboard.press('Enter');
    await expect(selectionMode(page)).toHaveAttribute('aria-pressed', 'false');
    // This explicitly crosses the old 350ms click-guard boundary; the held
    // contact must stay cancelled until its own release, without a timing reset.
    await page.waitForTimeout(450);
  } finally { await page.mouse.up(); }
  await expect(page.getByRole('dialog', { name: '사진 크게 보기' })).toHaveCount(0);
  await cards(page).nth(1).locator('.photo-open').click();
  await expect(page.getByRole('dialog', { name: '사진 크게 보기' })).toBeVisible();
});

test('accessible zoom controls obey column bounds, preserve selection and save the chosen density', async ({ page }) => {
  await seed(page);
  await cards(page).nth(0).locator('.photo-select').click();
  const enlarge = page.getByRole('button', { name: '사진 확대', exact: true });
  const shrink = page.getByRole('button', { name: '사진 축소', exact: true });
  while (await columns(page) > 2) await enlarge.click();
  await expect(enlarge).toBeDisabled();
  while (await columns(page) < 8) await shrink.click();
  await expect(shrink).toBeDisabled();
  await expectSelected(page, [0]);
  await enlarge.focus();
  await page.keyboard.press('Enter');
  await expect(grid(page)).toHaveAttribute('data-columns', '7');
  await expectSelected(page, [0]);
  await page.reload();
  await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
  await expect(grid(page)).toHaveAttribute('data-columns', '7');
  await expect(page.locator('p:visible, [title]')).toHaveCount(0);
  await mkdir('.local/gesture-verification', { recursive: true });
  await page.screenshot({ path: '.local/gesture-verification/desktop.png' });
});

test.describe('trusted mobile touch gestures', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('a horizontal sweep selects rows and touch cancellation restores the prior selection', async ({ page, context }) => {
    await seed(page);
    await selectionMode(page).click();
    await alignGrid(page);
    const session = await context.newCDPSession(page);
    const first = await center(cards(page).nth(0).locator('.photo-frame'));
    const second = await center(cards(page).nth(1).locator('.photo-frame'));
    const fourth = await center(cards(page).nth(3).locator('.photo-frame'));
    try {
      await touch(session, 'touchStart', [first]);
      await touchMove(session, [first], [second]);
      await touchMove(session, [second], [fourth]);
      await expectSelected(page, [0, 1, 2, 3]);
      await touchMove(session, [fourth], [second]);
      await touch(session, 'touchEnd', []);
      await expectSelected(page, [0, 1]);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await alignGrid(page);
      const circle = await center(cards(page).nth(0).locator('.photo-select'));
      await touch(session, 'touchStart', [circle]);
      await frame(page);
      await expectSelected(page, [1]);
      await touch(session, 'touchCancel', []);
      await frame(page);
      await expectSelected(page, [0, 1]);
    } finally { await session.detach(); }
  });

  test('one-finger vertical movement scrolls normally even while selection mode is enabled', async ({ page, context }) => {
    await seed(page);
    await selectionMode(page).click();
    await alignGrid(page);
    const session = await context.newCDPSession(page);
    const start = await center(cards(page).nth(0).locator('.photo-frame'));
    const before = await page.evaluate(() => window.scrollY);
    try {
      await touch(session, 'touchStart', [start]);
      await touchMove(session, [start], [{ x: start.x, y: start.y - 140 }], 10);
      await touch(session, 'touchEnd', []);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 30);
      await expectSelected(page, []);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally { await session.detach(); }
  });

  test('pinch changes density in both directions without changing selection or opening a photo', async ({ page, context }) => {
    await seed(page);
    await cards(page).nth(0).locator('.photo-select').click();
    await alignGrid(page);
    const session = await context.newCDPSession(page);
    const y = (await center(cards(page).nth(0).locator('.photo-frame'))).y;
    try {
      await expect(grid(page)).toHaveAttribute('data-columns', '2');
      const spread = [{ x: 45, y }, { x: 345, y }];
      const close = [{ x: 120, y }, { x: 270, y }];
      await touch(session, 'touchStart', spread);
      await touchMove(session, spread, close);
      await touch(session, 'touchEnd', []);
      await frame(page);
      const dense = await columns(page);
      expect(dense).toBeGreaterThan(2);
      expect(dense).toBeLessThanOrEqual(6);
      await expectSelected(page, [0]);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await alignGrid(page);
      const pinchY = (await center(cards(page).nth(0).locator('.photo-frame'))).y;
      const inner = [{ x: 125, y: pinchY }, { x: 265, y: pinchY }];
      const outer = [{ x: 40, y: pinchY }, { x: 350, y: pinchY }];
      await touch(session, 'touchStart', inner);
      await touchMove(session, inner, outer);
      await touch(session, 'touchEnd', []);
      await frame(page);
      const expanded = await columns(page);
      expect(expanded).toBeLessThan(dense);
      expect(expanded).toBeGreaterThanOrEqual(2);
      await expectSelected(page, [0]);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      while (await columns(page) < 6) await page.getByRole('button', { name: '사진 축소', exact: true }).click();
      await expect(page.getByRole('button', { name: '사진 축소', exact: true })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await mkdir('.local/gesture-verification', { recursive: true });
      await page.screenshot({ path: '.local/gesture-verification/mobile.png' });
      await page.reload();
      await page.getByRole('button', { name: '기기 보관함', exact: true }).click();
      await expect(grid(page)).toHaveAttribute('data-columns', '6');
    } finally { await session.detach(); }
  });

  test('a second finger converts an active sweep into pinch and restores its selection baseline', async ({ page, context }) => {
    await seed(page);
    await cards(page).nth(0).locator('.photo-select').click();
    await alignGrid(page);
    const session = await context.newCDPSession(page);
    const anchor = await center(cards(page).nth(2).locator('.photo-select'));
    try {
      await touch(session, 'touchStart', [anchor]);
      await expectSelected(page, [0, 2]);
      const second = { x: anchor.x + 100, y: anchor.y };
      await touch(session, 'touchStart', [anchor, second]);
      await expectSelected(page, [0]);
      await touchMove(session, [anchor, second], [anchor, { x: anchor.x + 45, y: anchor.y }]);
      await touch(session, 'touchEnd', []);
      await frame(page);
      expect(await columns(page)).toBeGreaterThan(2);
      await expectSelected(page, [0]);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally { await session.detach(); }
  });

  test('locked selection auto-scrolls at the edge and stops scrolling when the gesture ends', async ({ page, context }) => {
    await seed(page);
    await alignGrid(page);
    const session = await context.newCDPSession(page);
    const start = await center(cards(page).nth(0).locator('.photo-select'));
    const before = await page.evaluate(() => window.scrollY);
    try {
      await touch(session, 'touchStart', [start]);
      await touchMove(session, [start], [{ x: start.x, y: 835 }], 12);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 40);
      await touch(session, 'touchEnd', []);
      await frame(page, 3);
      const stopped = await page.evaluate(() => window.scrollY);
      await frame(page, 5);
      expect(Math.abs(await page.evaluate(() => window.scrollY) - stopped)).toBeLessThanOrEqual(1);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally { await session.detach(); }
  });
});
