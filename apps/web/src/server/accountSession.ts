/** Logout retains the non-exportable device key so device-only accounts remain recoverable. */
import { server } from './index.ts';

const basePath = import.meta.env?.BASE_URL ?? (typeof location === 'undefined' ? '/' : new URL('.', location.href).pathname);
export const ACCOUNT_SIGNED_OUT_KEY = `phogaem:${basePath}:signed-out`;
let signedOut = false;

export function isAccountSignedOut(): boolean {
  try { return signedOut || localStorage.getItem(ACCOUNT_SIGNED_OUT_KEY) === 'true'; }
  catch { return signedOut; }
}

export function logoutAccount(): void {
  signedOut = true;
  server.suspendSession();
  // A storage failure must not leave an authenticated token usable in the current tab.
  localStorage.setItem(ACCOUNT_SIGNED_OUT_KEY, 'true');
}

/** Only explicit login actions may call this; passive session restoration must not. */
export function resumeAccount(): void {
  localStorage.removeItem(ACCOUNT_SIGNED_OUT_KEY);
  signedOut = false;
  server.resumeSession();
}
