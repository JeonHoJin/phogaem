import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteShareUrl, inviteTokenFromInput, INVITE_PREVIEW_PATH } from '../apps/web/src/server/invite.ts';
import { API_BASE } from '../apps/web/src/server/index.ts';

const token = 'a'.repeat(43);
test('share links expose a bounded token to the preview server without album details', () => {
  const url = new URL(inviteShareUrl(token));
  assert.equal(url.origin, API_BASE);
  assert.equal(url.pathname, INVITE_PREVIEW_PATH);
  assert.equal(url.searchParams.get('token'), token);
  assert.equal(url.hash, '');
  for (const bad of ['', 'short', 'a'.repeat(44), '<'.repeat(43)]) assert.throws(() => inviteShareUrl(bad));
});

test('pasted preview URLs, old fragment links and raw codes resolve to the same invitation', () => {
  assert.equal(inviteTokenFromInput(inviteShareUrl(token)), token);
  assert.equal(inviteTokenFromInput(`https://jeonhojin.github.io/phogaem/#invite=${token}`), token);
  assert.equal(inviteTokenFromInput(`  ${token}  `), token);
  for (const url of [`https://other.invalid${INVITE_PREVIEW_PATH}?token=${token}`, `${API_BASE}/other?token=${token}`, `${inviteShareUrl(token)}&token=other`]) {
    assert.equal(inviteTokenFromInput(url), '');
  }
});
