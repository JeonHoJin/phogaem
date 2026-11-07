import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePendingGoogle, validateGoogleAuthorizationUrl, finishGoogleAuth, GOOGLE_PENDING_KEY } from '../apps/web/src/server/google.ts';

const now = 1_000_000;
const valid = { state: 's'.repeat(43), verifier: 'v'.repeat(43), createdAt: now, mode: 'login', deviceFingerprint: null, returnHash: '#invite=trip_123' };

test('Google handoff accepts only bounded fresh flows and explicit link targets', () => {
  assert.deepEqual(parsePendingGoogle(JSON.stringify(valid), now), valid);
  for (const patch of [
    { createdAt: now - 600_001 }, { createdAt: now + 1 }, { state: 'bad' }, { verifier: null },
    { mode: 'link' }, { mode: 'other' }, { returnHash: '#google_code=secret' }, { returnHash: 'https://evil.test' },
  ]) assert.equal(parsePendingGoogle(JSON.stringify({ ...valid, ...patch }), now), null);
  assert.equal(parsePendingGoogle('invalid', now), null);
  assert.equal(parsePendingGoogle(null, now), null);
  assert.ok(parsePendingGoogle(JSON.stringify({ ...valid, mode: 'link', expectedUserId: 'user-one' }), now));
});

test('only the exact Google authorization endpoint is accepted', () => {
  assert.equal(validateGoogleAuthorizationUrl('https://accounts.google.com/o/oauth2/v2/auth?state=abc'), 'https://accounts.google.com/o/oauth2/v2/auth?state=abc');
  for (const url of [
    'http://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com.evil.test/o/oauth2/v2/auth',
    'https://accounts.google.com/other', 'https://user@accounts.google.com/o/oauth2/v2/auth',
    'https://accounts.google.com/o/oauth2/v2/auth#token', 'javascript:alert(1)',
  ]) assert.throws(() => validateGoogleAuthorizationUrl(url));
});

test('ordinary startup is lazy; forged callback clears its code without touching identity', async () => {
  const prior = { location: Object.getOwnPropertyDescriptor(globalThis, 'location'), history: Object.getOwnPropertyDescriptor(globalThis, 'history'), sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage') };
  const replacements: string[] = [];
  let removed = '';
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '#invite=trip', pathname: '/phogaem/', search: '' } });
    assert.equal(await finishGoogleAuth(), '');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '#google_code=' + 'c'.repeat(43) + '&google_state=' + 's'.repeat(43), pathname: '/phogaem/', search: '' } });
    Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: (_data: unknown, _unused: string, url: string) => replacements.push(url) } });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => null, removeItem: (key: string) => { removed = key; } } });
    assert.equal(await finishGoogleAuth(), 'Google 로그인 실패');
    assert.deepEqual(replacements, ['/phogaem/']);
    assert.equal(removed, GOOGLE_PENDING_KEY);
  } finally {
    for (const [name, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
