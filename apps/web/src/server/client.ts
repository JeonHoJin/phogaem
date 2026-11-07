import { validateApiBase } from './config.ts'

// Adapted from schedule-parser/apps/mobile/src/server/client.ts (mlhops device-key contract).
/**
 * mlhops 서버 클라이언트: 기기 키 로그인 + op 호출.
 *
 * 기기 키(ECDSA P-256)는 기기 밖으로 나가지 않는다. 서버는 공개키만 알고, 1회용 챌린지에
 * 대한 서명으로 이 기기임을 확인한 뒤 짧게 쓰는 토큰을 준다. 토큰은 메모리에만 두고
 * 새로고침하면 기기 키로 다시 받는다 — 저장소에 토큰이 남지 않게 하려는 것.
 */

export interface KeyStore {
  get(): Promise<CryptoKeyPair | undefined>
  put(keys: CryptoKeyPair): Promise<void>
}

export class ServerError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ServerError'
  }
}

interface Session {
  token: string
  userId: string
  refreshAt: number
}

export interface ClientOptions {
  base: string
  store: KeyStore
  fetch?: typeof fetch
  subtle?: SubtleCrypto
  now?: () => number
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const

export function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Stable public identity snapshot; never creates or exports a private key. */
export async function deviceKeyFingerprint(keys: CryptoKeyPair | undefined, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string | null> {
  if (!keys) return null
  const jwk = await subtle.exportKey('jwk', keys.publicKey)
  const canonical = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })
  return base64url(await subtle.digest('SHA-256', new TextEncoder().encode(canonical)))
}

function responseError(data: unknown, status: number): ServerError {
  const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined
  return new ServerError(status, typeof error === 'string' ? error : `HTTP ${status}`)
}

export class ServerClient {
  private session?: Session
  private pending?: Promise<Session>
  private pendingKeys?: Promise<CryptoKeyPair>
  private adopting?: Promise<void>
  private generation = 0
  private readonly fetch: typeof fetch
  private readonly subtle: SubtleCrypto
  private readonly now: () => number

  private readonly opts: ClientOptions

  constructor(opts: ClientOptions) {
    this.opts = { ...opts, base: validateApiBase(opts.base) }
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.subtle = opts.subtle ?? globalThis.crypto.subtle
    this.now = opts.now ?? Date.now
  }

  get userId(): string | undefined {
    return this.session?.userId
  }

  /** 이 기기가 한 번이라도 로그인해서 기기 키를 갖고 있는지. 키를 만들지 않는다. */
  async hasIdentity(): Promise<boolean> {
    return Boolean(await this.opts.store.get())
  }

  private deviceKeys(): Promise<CryptoKeyPair> {
    this.pendingKeys ??= this.loadDeviceKeys().finally(() => { this.pendingKeys = undefined })
    return this.pendingKeys
  }

  private async loadDeviceKeys(): Promise<CryptoKeyPair> {
    const existing = await this.opts.store.get()
    if (existing) return existing
    // extractable=false: 개인키는 이 브라우저 밖으로 내보낼 수 없다
    const keys = await this.subtle.generateKey(ECDSA, false, ['sign', 'verify']) as CryptoKeyPair
    await this.opts.store.put(keys)
    return keys
  }

  /** Clears the in-memory token only; the device key remains this device's identity. */
  resetSession(): void {
    this.generation += 1
    this.session = undefined
    this.pending = undefined
  }

  private checkGeneration(generation: number): void {
    if (generation !== this.generation) throw new ServerError(0, '로그인 상태가 변경됐어요. 다시 연결해 주세요.')
  }

  private requestUrl(path: string): string {
    // Never turn a caller-controlled path into another credential destination.
    if (!path.startsWith('/') || path.startsWith('//') || [...path].some(char => char === '\\' || char === '#' || char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) {
      throw new ServerError(0, '올바르지 않은 서버 요청 경로예요.')
    }
    const url = new URL(path, this.opts.base)
    if (url.origin !== this.opts.base) throw new ServerError(0, '올바르지 않은 서버 요청 경로예요.')
    return url.href
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    const url = this.requestUrl(path)
    try {
      return await this.fetch(url, {
        ...init,
        // Redirects can forward upload bodies and signed authentication proofs.
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      })
    } catch {
      throw new ServerError(0, '서버에 연결하지 못했어요. 네트워크와 서버 상태를 확인해 주세요.')
    }
  }

  private async postJson<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.send(path, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data: unknown = await res.json().catch(() => ({}))
    if (!res.ok) throw responseError(data, res.status)
    return data as T
  }

  private async signIn(): Promise<Session> {
    const keys = await this.deviceKeys()
    const { challenge } = await this.postJson<{ challenge: string }>('/auth/challenge')
    const message = new TextEncoder().encode(`mlhops-auth-v1:${challenge}`)
    const signature = await this.subtle.sign(SIGN, keys.privateKey, message)
    const jwk = await this.subtle.exportKey('jwk', keys.publicKey)
    const res = await this.postJson<{ access_token: string; expires_in: number; user_id: string }>(
      '/auth/token',
      {
        public_key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
        challenge,
        signature: base64url(signature),
      },
    )
    const margin = Math.min(60, res.expires_in / 2)
    return {
      token: res.access_token,
      userId: res.user_id,
      refreshAt: this.now() + (res.expires_in - margin) * 1000,
    }
  }

  /** 동시에 여러 요청이 와도 로그인은 한 번만 한다. */
  async token(): Promise<string> {
    if (this.adopting) await this.adopting
    if (this.session && this.now() < this.session.refreshAt) return this.session.token
    if (!this.pending) {
      const generation = this.generation
      const pending = this.signIn().then(session => {
        this.checkGeneration(generation)
        this.session = session
        return session
      }).finally(() => { if (this.pending === pending) this.pending = undefined })
      this.pending = pending
    }
    return (await this.pending).token
  }

  /** `/op/{name}[/{version}]` 호출. 401 이면 한 번 다시 로그인해서 재시도한다. */
  async op(name: string, init: {
    method?: string; body?: BodyInit; version?: string; headers?: Record<string, string>; query?: Record<string, string>
  } = {}): Promise<Response> {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || (init.version !== undefined && !/^[a-zA-Z0-9_-]+$/.test(init.version))) throw new ServerError(0, '올바르지 않은 서버 작업 이름이에요.')
    const query = init.query ? `?${new URLSearchParams(init.query)}` : ''
    return this.request(`/op/${name}${init.version ? `/${init.version}` : ''}${query}`, init)
  }

  /** 로그인한 사용자로 서버 경로를 부른다(`/auth/passkey/…` 등). 401 이면 한 번 다시 로그인한다. */
  async request(path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
    this.requestUrl(path)
    const generation = this.generation
    const call = async () => {
      const headers = new Headers(init.headers)
      // Only the core may set trusted user headers. Never forward a caller-supplied copy.
      for (const key of [...headers.keys()]) if (key.startsWith('x-mlhops-')) headers.delete(key)
      headers.set('authorization', `Bearer ${await this.token()}`)
      this.checkGeneration(generation)
      const response = await this.send(path, { method: init.method ?? 'POST', body: init.body, headers })
      this.checkGeneration(generation)
      return response
    }
    let res = await call()
    if (res.status === 401) {
      this.session = undefined
      res = await call()
    }
    return res
  }

  /** 로그인 없이 서버 경로에 JSON 을 보낸다(패스키 로그인). */
  async postPublic<T>(path: string, body?: unknown): Promise<T> {
    return this.postJson<T>(path, body)
  }

  async startGoogleAuth(body: { mode: 'login' | 'link'; return_url: string; code_challenge: string; client_state: string }, confirmationToken?: string): Promise<{ authorization_url: string; expires_in: number }> {
    if (body.mode === 'login') return this.postJson('/auth/google/start', body)
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    const generation = this.generation
    const res = confirmationToken === undefined
      ? await this.request('/auth/google/start', init)
      : await this.send('/auth/google/start', { ...init, headers: { ...init.headers, authorization: `Bearer ${confirmationToken}` } })
    this.checkGeneration(generation)
    const data = await res.json().catch(() => ({})) as { authorization_url: string; expires_in: number; error?: string }
    this.checkGeneration(generation)
    if (!res.ok) throw responseError(data, res.status)
    return data
  }

  /** Google's one-time capability binds a fresh device key without passkey-only /auth/link. */
  async completeGoogleAuth(code: string, verifier: string, expectedUserId?: string, expectedDeviceFingerprint?: string | null): Promise<string> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) {
      throw new ServerError(0, '올바르지 않은 Google 로그인 요청이에요.')
    }
    if (this.adopting) throw new ServerError(0, '계정 연결이 이미 진행 중이에요.')
    const generation = ++this.generation
    this.pending = undefined
    const completing = this.completeGoogleAccount(code, verifier, expectedUserId, expectedDeviceFingerprint, generation)
    const adopting = completing.then(() => undefined)
    this.adopting = adopting
    // Observe the lock's rejection even when no token request is waiting on it.
    void adopting.catch(() => undefined)
    try { return await completing } finally { if (this.adopting === adopting) this.adopting = undefined }
  }

  private async checkDeviceFingerprint(expected: string | null | undefined): Promise<void> {
    if (expected === undefined) return
    if (await deviceKeyFingerprint(await this.opts.store.get(), this.subtle) !== expected) {
      throw new ServerError(0, '로그인 상태가 변경됐어요. 다시 연결해 주세요.')
    }
  }

  private async completeGoogleAccount(code: string, verifier: string, expectedUserId: string | undefined, expectedDeviceFingerprint: string | null | undefined, generation: number): Promise<string> {
    await this.pendingKeys
    this.checkGeneration(generation)
    const keys = await this.subtle.generateKey(ECDSA, false, ['sign', 'verify']) as CryptoKeyPair
    const signature = await this.subtle.sign(SIGN, keys.privateKey, new TextEncoder().encode(`mlhops-google-complete-v1:${code}:${verifier}`))
    const jwk = await this.subtle.exportKey('jwk', keys.publicKey)
    await this.checkDeviceFingerprint(expectedDeviceFingerprint)
    this.checkGeneration(generation)
    const data = await this.postJson<unknown>('/auth/google/complete', {
      code, verifier, public_key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, signature: base64url(signature),
    })
    this.checkGeneration(generation)
    if (!data || typeof data !== 'object') throw new ServerError(502, '올바르지 않은 로그인 응답이에요.')
    const login = data as { access_token?: unknown; user_id?: unknown; expires_in?: unknown; created?: unknown }
    if (typeof login.access_token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(login.access_token)
      || typeof login.user_id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(login.user_id)
      || typeof login.expires_in !== 'number' || !Number.isFinite(login.expires_in) || login.expires_in <= 0 || login.expires_in > 86_400
      || (login.created !== undefined && typeof login.created !== 'boolean')) {
      throw new ServerError(502, '올바르지 않은 로그인 응답이에요.')
    }
    if (expectedUserId !== undefined && login.user_id !== expectedUserId) throw new ServerError(403, '현재 계정의 로그인 수단으로 확인해 주세요.')
    await this.checkDeviceFingerprint(expectedDeviceFingerprint)
    this.checkGeneration(generation)
    await this.opts.store.put(keys)
    this.checkGeneration(generation)
    const margin = Math.min(60, login.expires_in / 2)
    this.session = { token: login.access_token, userId: login.user_id, refreshAt: this.now() + (login.expires_in - margin) * 1000 }
    return login.user_id
  }

  /**
   * 다른 곳(패스키)으로 로그인한 계정을 이 기기의 계정으로 삼는다. 새 기기 키를 만들어 그 계정에
   * 연결한 뒤에야 저장해 두므로, 연결에 실패하면 이 기기의 원래 계정이 그대로 남는다.
   */
  async adoptAccount(login: { access_token: string; expires_in: number; user_id: string }): Promise<void> {
    if (this.adopting) throw new ServerError(0, '계정 연결이 이미 진행 중이에요.')
    const generation = ++this.generation
    this.pending = undefined
    const adopting = this.linkAccount(login, generation)
    this.adopting = adopting
    try { await adopting } finally { if (this.adopting === adopting) this.adopting = undefined }
  }

  private async linkAccount(login: { access_token: string; expires_in: number; user_id: string }, generation: number): Promise<void> {
    // Finish any old device-key creation before replacing the persisted identity.
    await this.pendingKeys
    this.checkGeneration(generation)
    const keys = await this.subtle.generateKey(ECDSA, false, ['sign', 'verify']) as CryptoKeyPair
    const { challenge } = await this.postJson<{ challenge: string }>('/auth/challenge')
    // Linking is a different proof from signing in: the core rejects an auth-domain signature.
    const signature = await this.subtle.sign(SIGN, keys.privateKey, new TextEncoder().encode(`mlhops-link-v1:${challenge}`))
    const jwk = await this.subtle.exportKey('jwk', keys.publicKey)
    const res = await this.send('/auth/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${login.access_token}` },
      body: JSON.stringify({
        public_key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
        challenge,
        signature: base64url(signature),
      }),
    })
    if (res.status !== 201 && res.status !== 200) {
      const data: unknown = await res.json().catch(() => ({}))
      throw responseError(data, res.status)
    }
    this.checkGeneration(generation)
    await this.opts.store.put(keys)
    this.checkGeneration(generation)
    const margin = Math.min(60, login.expires_in / 2)
    this.session = { token: login.access_token, userId: login.user_id, refreshAt: this.now() + (login.expires_in - margin) * 1000 }
  }
}
