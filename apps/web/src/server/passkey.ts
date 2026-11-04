// Adapted from schedule-parser/apps/mobile/src/server/passkey.ts; retains the mlhops WebAuthn contract.
/**
 * 패스키: 계정을 기기 밖(iCloud 키체인 / 구글 비밀번호 관리자)에 묶어 두는 두 번째 로그인 수단.
 * 평소 로그인은 기기 키로 조용히 하고, 패스키는 폰을 바꾸거나 브라우저 데이터를 지웠을 때
 * 원래 계정을 되찾는 데 쓴다.
 */
import { base64url, fromBase64url, ServerError } from './client.ts'
import { server } from './index.ts'

/** 서버의 등록 옵션 (`/auth/passkey/register/options`) */
export interface RegisterOptions {
  challenge: string
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  excludeCredentials: string[]
  timeoutMs: number
}

export interface LoginOptions { challenge: string; rpId: string; timeoutMs: number }

export interface PasskeyLogin { access_token: string; expires_in: number; user_id: string }

const bytes = (b64: string) => fromBase64url(b64) as Uint8Array<ArrayBuffer>

export function creationOptions(o: RegisterOptions): PublicKeyCredentialCreationOptions {
  return {
    challenge: bytes(o.challenge),
    rp: o.rp,
    user: { id: bytes(o.user.id), name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: o.excludeCredentials.map(id => ({ type: 'public-key', id: bytes(id) })),
    attestation: 'none',
    timeout: o.timeoutMs,
  }
}

export function requestOptions(o: LoginOptions): PublicKeyCredentialRequestOptions {
  return { challenge: bytes(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: o.timeoutMs }
}

/** 브라우저가 만든 패스키를 서버 등록 요청으로 */
export function registrationBody(cred: { rawId: ArrayBuffer; response: AuthenticatorAttestationResponse }) {
  const r = cred.response
  const key = r.getPublicKey?.()
  if (!key || typeof r.getAuthenticatorData !== 'function') throw new PasskeyUnsupported()
  return {
    credentialId: base64url(cred.rawId),
    clientDataJson: base64url(r.clientDataJSON),
    authenticatorData: base64url(r.getAuthenticatorData()),
    publicKey: base64url(key),
    publicKeyAlg: r.getPublicKeyAlgorithm(),
  }
}

/** 브라우저의 패스키 서명을 서버 로그인 요청으로 */
export function assertionBody(cred: { rawId: ArrayBuffer; response: AuthenticatorAssertionResponse }) {
  const r = cred.response
  return {
    credentialId: base64url(cred.rawId),
    clientDataJson: base64url(r.clientDataJSON),
    authenticatorData: base64url(r.authenticatorData),
    signature: base64url(r.signature),
    userHandle: r.userHandle ? base64url(r.userHandle) : undefined,
  }
}

export class PasskeyUnsupported extends Error {
  constructor() { super('이 브라우저에서는 패스키를 쓸 수 없어요. Safari 나 Chrome 에서 열어 주세요.') }
}

/** 사용자가 Face ID 창을 닫았을 때 */
export class PasskeyCancelled extends Error {
  constructor() { super('패스키 확인이 취소됐어요.') }
}

export function passkeySupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function'
    && typeof navigator.credentials?.create === 'function'
}

async function webauthn<T>(run: () => Promise<Credential | null>): Promise<T> {
  if (!passkeySupported()) throw new PasskeyUnsupported()
  try {
    const cred = await run()
    if (!cred) throw new PasskeyCancelled()
    return cred as T
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) throw new PasskeyCancelled()
    if (e instanceof DOMException && e.name === 'InvalidStateError') throw new Error('이 기기의 패스키가 이미 이 계정에 등록돼 있어요.', { cause: e })
    throw e
  }
}

async function ok(res: Response): Promise<Response> {
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string }
    throw new ServerError(res.status, data.error ?? `HTTP ${res.status}`)
  }
  return res
}

/** 지금 계정에 패스키를 하나 더한다(이 기기의 기기 키로 로그인한 상태). */
export async function registerPasskey(): Promise<number> {
  const options = await (await ok(await server.request('/auth/passkey/register/options'))).json() as RegisterOptions
  const cred = await webauthn<{ rawId: ArrayBuffer; response: AuthenticatorAttestationResponse }>(
    () => navigator.credentials.create({ publicKey: creationOptions(options) }))
  const res = await ok(await server.request('/auth/passkey/register', {
    body: JSON.stringify(registrationBody(cred)),
    headers: { 'content-type': 'application/json' },
  }))
  return (await res.json() as { passkeys: number }).passkeys
}

export async function passkeys(): Promise<Array<{ createdAt: string; lastUsedAt: string }>> {
  const res = await ok(await server.request('/auth/passkeys', { method: 'GET' }))
  return (await res.json() as { passkeys: Array<{ createdAt: string; lastUsedAt: string }> }).passkeys
}

/**
 * 패스키로 계정을 찾아 이 기기를 그 계정에 연결한다. 끝나면 이 기기는 그 계정으로 로그인돼 있고,
 * 다음부터는 Face ID 없이 기기 키로 들어간다.
 */
export async function signInWithPasskey(): Promise<string> {
  const options = await server.postPublic<LoginOptions>('/auth/passkey/login/options')
  const cred = await webauthn<{ rawId: ArrayBuffer; response: AuthenticatorAssertionResponse }>(
    () => navigator.credentials.get({ publicKey: requestOptions(options) }))
  const login = await server.postPublic<PasskeyLogin>('/auth/passkey/login', assertionBody(cred))
  await server.adoptAccount(login)
  return login.user_id
}
