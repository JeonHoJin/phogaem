import { base64url, deviceKeyFingerprint } from './client.ts';
import { server, ServerError, indexedDbKeyStore } from './index.ts';
import { confirmPasskeyAccount } from './passkey.ts';

export const GOOGLE_LOGIN_ENABLED = import.meta.env?.VITE_GOOGLE_LOGIN_ENABLED === 'true';
const basePath = import.meta.env?.BASE_URL ?? '/phogaem/';
export const GOOGLE_PENDING_KEY = `phogaem:${basePath}:google-pending`;
const resumeKey = `phogaem:${basePath}:resume-shared`;
const opaque = /^[A-Za-z0-9_-]{43}$/;
export interface PendingGoogle {
  state: string;
  verifier: string;
  createdAt: number;
  returnHash: string;
  mode: 'login' | 'link';
  expectedUserId?: string;
  deviceFingerprint: string | null;
}

export function parsePendingGoogle(raw: string | null, now = Date.now()): PendingGoogle | null {
  try {
    const value = JSON.parse(raw ?? 'null') as PendingGoogle | null;
    if (!value || typeof value.state !== 'string' || typeof value.verifier !== 'string' || !opaque.test(value.state) || !opaque.test(value.verifier)
      || !Number.isFinite(value.createdAt) || value.createdAt > now || now - value.createdAt > 600_000
      || typeof value.returnHash !== 'string' || value.returnHash.length > 4096
      || (value.returnHash !== '' && !/^#invite=[A-Za-z0-9_%.-]+$/.test(value.returnHash))
      || (value.mode !== 'login' && value.mode !== 'link')
      || (value.deviceFingerprint !== null && (typeof value.deviceFingerprint !== 'string' || !opaque.test(value.deviceFingerprint)))
      || (value.mode === 'link' && (typeof value.expectedUserId !== 'string' || !value.expectedUserId))) return null;
    return value;
  } catch { return null; }
}

export function validateGoogleAuthorizationUrl(raw: string): string {
  const url = new URL(raw);
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth'
    || url.username || url.password || url.hash) throw new Error('Google 인증 주소 오류');
  return url.href;
}

export async function beginGoogleAuth(expectedUserId?: string, inviteToken = ''): Promise<void> {
  if (!GOOGLE_LOGIN_ENABLED) throw new Error('Google 로그인 비활성');
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const mode: 'login' | 'link' = expectedUserId ? 'link' : 'login';
  const pending: PendingGoogle = {
    state, verifier, createdAt: Date.now(), mode, expectedUserId,
    deviceFingerprint: await deviceKeyFingerprint(await indexedDbKeyStore.get()),
    returnHash: inviteToken ? `#invite=${encodeURIComponent(inviteToken)}` : '',
  };
  if (!parsePendingGoogle(JSON.stringify(pending))) throw new Error('초대 코드 오류');
  // Storage must be available before leaving this page. Tokens never enter it.
  sessionStorage.setItem(GOOGLE_PENDING_KEY, JSON.stringify(pending));
  try {
    const body = { mode, return_url: new URL(basePath, location.origin).href, code_challenge: challenge, client_state: state };
    let result;
    try { result = await server.startGoogleAuth(body); }
    catch (reason) {
      if (!expectedUserId || !(reason instanceof ServerError) || reason.status !== 403) throw reason;
      const confirmation = await confirmPasskeyAccount(expectedUserId);
      result = await server.startGoogleAuth(body, confirmation.access_token);
    }
    location.assign(validateGoogleAuthorizationUrl(result.authorization_url));
  } catch (reason) { sessionStorage.removeItem(GOOGLE_PENDING_KEY); throw reason; }
}

/** Called once before React mounts, so invitation state is restored before its initializers. */
export async function finishGoogleAuth(): Promise<string> {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('google_code') && !params.has('google_error') && !params.has('google_state')) return '';
  let pending: PendingGoogle | null = null;
  try { pending = parsePendingGoogle(sessionStorage.getItem(GOOGLE_PENDING_KEY)); }
  catch { /* unavailable storage fails closed */ }
  const validState = !!pending && params.getAll('google_state').length === 1 && params.get('google_state') === pending.state;
  // Remove transient codes before performing any asynchronous work or mounting UI.
  history.replaceState(null, '', `${location.pathname}${location.search}${validState ? pending!.returnHash : ''}`);
  try {
    sessionStorage.removeItem(GOOGLE_PENDING_KEY);
    if (!GOOGLE_LOGIN_ENABLED || !validState || !pending) throw new Error('Google 로그인 확인 실패');
    if (params.has('google_error')) throw new Error('Google 로그인 취소');
    const code = params.get('google_code') ?? '';
    if (params.getAll('google_code').length !== 1 || !opaque.test(code)) throw new Error('Google 로그인 확인 실패');
    await server.completeGoogleAuth(code, pending.verifier, pending.mode === 'link' ? pending.expectedUserId : undefined, pending.deviceFingerprint);
    try { localStorage.setItem(resumeKey, '1'); } catch { /* optional resume */ }
    return '';
  } catch { return 'Google 로그인 실패'; }
}
