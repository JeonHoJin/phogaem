import { API_BASE } from './index.ts';

export const INVITE_PREVIEW_PATH = '/op/phogaem-invite-preview/v1';

/** Crawlers need a server-visible token, rather than the app's fragment-only URL. */
export function inviteShareUrl(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('초대 링크를 확인하지 못했어요.');
  const url = new URL(INVITE_PREVIEW_PATH, API_BASE);
  url.searchParams.set('token', token);
  return url.href;
}

/** Keep existing fragment links and raw codes usable alongside preview links. */
export function inviteTokenFromInput(input: string): string {
  const value = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const legacy = new URLSearchParams(url.hash.slice(1)).get('invite');
    if (legacy !== null) return legacy;
    if (url.origin === API_BASE && url.pathname === INVITE_PREVIEW_PATH && !url.username && !url.password) {
      return url.searchParams.getAll('token').length === 1 ? url.searchParams.get('token')! : '';
    }
  } catch { /* invalid pasted URL */ }
  return '';
}
