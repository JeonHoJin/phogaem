import { ApprovalRequired } from './api.ts';
import { fromBase64url, ServerError } from './client.ts';
import { server } from './index.ts';

export const PUSH_ENABLED = import.meta.env?.VITE_PHOGAEM_PUSH_ENABLED === 'true';
const basePath = import.meta.env?.BASE_URL ?? '/phogaem/';
const identifier = /^[A-Za-z0-9_-]{1,128}$/;

export interface AlbumPushStatus { enabled: boolean; publicKey: string | null }
export interface PushMessage { id: string; albumId: string; title: string; body: string }
interface BrowserSubscription { endpoint: string; keys: { p256dh: string; auth: string } }

/** Only this exact ownership rejection permits a user-initiated browser subscription reset. */
export class PushEndpointConflict extends ServerError {
  constructor(options?: ErrorOptions) {
    super(409, '이 브라우저의 알림 계정이 변경됐어요.');
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

function invalid(): never { throw new ServerError(502, '알림 응답을 확인하지 못했어요.'); }
function validId(value: string): void {
  if (!identifier.test(value)) throw new ServerError(0, '알림 대상을 확인하지 못했어요.');
}
function keyBytes(value: unknown, size: number): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  try {
    const bytes = fromBase64url(value.replace(/=+$/, '')) as Uint8Array<ArrayBuffer>;
    return bytes.length === size ? bytes : null;
  } catch { return null; }
}
function publicKeyBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  const bytes = keyBytes(value, 65);
  return bytes?.[0] === 4 ? bytes : null;
}
function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port;
  } catch { return false; }
}
async function request(name: string, body: unknown): Promise<unknown> {
  const response = await server.op(`phogaem-push-${name}`, {
    version: 'v1', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 403 && data && typeof data === 'object' && 'error' in data && data.error === 'approval required') {
      throw new ApprovalRequired(server.userId);
    }
    if (name === 'subscribe' && response.status === 409 && data && typeof data === 'object'
      && 'error' in data && data.error === 'push endpoint belongs to another account') {
      throw new PushEndpointConflict();
    }
    throw new ServerError(response.status, '알림 설정을 완료하지 못했어요.');
  }
  return data;
}

export async function getAlbumPushStatus(albumId: string, endpoint?: string): Promise<AlbumPushStatus> {
  validId(albumId);
  if (endpoint !== undefined && !validEndpoint(endpoint)) throw new ServerError(0, '알림 기기를 확인하지 못했어요.');
  const value = await request('status', { albumId, ...(endpoint !== undefined ? { endpoint } : {}) });
  if (!value || typeof value !== 'object' || !('enabled' in value) || typeof value.enabled !== 'boolean'
    || !('publicKey' in value) || (value.publicKey !== null && !publicKeyBytes(value.publicKey))) return invalid();
  return { enabled: value.enabled, publicKey: value.publicKey as string | null };
}

export async function subscribeAlbumPush(albumId: string, subscription: PushSubscription): Promise<void> {
  validId(albumId);
  const value = subscription.toJSON();
  if (!validEndpoint(value.endpoint) || !publicKeyBytes(value.keys?.p256dh) || !keyBytes(value.keys?.auth, 16)) {
    throw new ServerError(0, '알림 기기를 확인하지 못했어요.');
  }
  const body: BrowserSubscription = { endpoint: value.endpoint, keys: { p256dh: value.keys!.p256dh!, auth: value.keys!.auth! } };
  const result = await request('subscribe', { albumId, subscription: body });
  if (!result || typeof result !== 'object' || !('enabled' in result) || result.enabled !== true) invalid();
}

/** Disable just this album. The browser subscription is shared by its other albums. */
export async function unsubscribeAlbumPush(albumId: string, endpoint: string): Promise<void> {
  validId(albumId);
  if (!validEndpoint(endpoint)) throw new ServerError(0, '알림 기기를 확인하지 못했어요.');
  const value = await request('unsubscribe', { albumId, endpoint });
  if (!value || typeof value !== 'object' || !('enabled' in value) || value.enabled !== false) invalid();
}

export async function fetchPushMessage(id: string): Promise<PushMessage> {
  validId(id);
  const value = await request('message', { id });
  if (!value || typeof value !== 'object') return invalid();
  const message = value as Partial<PushMessage>;
  if (message.id !== id || typeof message.albumId !== 'string' || !identifier.test(message.albumId)
    || typeof message.title !== 'string' || !message.title.length || message.title.length > 200
    || typeof message.body !== 'string' || !message.body.length || message.body.length > 500) return invalid();
  return message as PushMessage;
}

export function pushSupported(): boolean {
  if (typeof window === 'undefined' || !window.isSecureContext || typeof navigator === 'undefined'
    || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return !ios || window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration(new URL(basePath, location.origin).href);
  return registration ? registration.pushManager.getSubscription() : null;
}

function stillCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new DOMException('Notification setting changed', 'AbortError');
}
async function activeRegistration(registration: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> {
  if (registration.active) return registration;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('알림 준비 실패')), 10_000); }),
    ]);
    if (ready.scope !== registration.scope || !ready.active) throw new Error('알림 준비 실패');
    return ready;
  } finally { clearTimeout(timer); }
}

/** Permission is requested synchronously in the caller's click, before the first await. */
export function enableAlbumPush(albumId: string, publicKey: string, isCurrent: () => boolean): Promise<PushSubscription> {
  validId(albumId);
  const applicationServerKey = publicKeyBytes(publicKey);
  if (!applicationServerKey || !pushSupported()) return Promise.reject(new Error('알림을 사용할 수 없어요.'));
  stillCurrent(isCurrent);
  const permission = Notification.permission === 'granted' ? Promise.resolve('granted' as const) : Notification.requestPermission();
  return (async () => {
    if (await permission !== 'granted') throw new Error('알림 권한이 필요해요.');
    stillCurrent(isCurrent);
    const registration = await activeRegistration(await navigator.serviceWorker.register(new URL('sw.js', new URL(basePath, location.origin)).href, {
      type: 'module', scope: basePath, updateViaCache: 'none',
    }));
    stillCurrent(isCurrent);
    let subscription = await registration.pushManager.getSubscription()
      ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    stillCurrent(isCurrent);
    try { await subscribeAlbumPush(albumId, subscription); }
    catch (error) {
      if (!(error instanceof PushEndpointConflict)) throw error;
      stillCurrent(isCurrent);
      // An explicit enable action may replace this browser's former account endpoint.
      // The server retains its owner; other browsers and ordinary album muting are untouched.
      const previousEndpoint = subscription.endpoint;
      const removed = await subscription.unsubscribe();
      stillCurrent(isCurrent);
      if (!removed) throw new Error('알림 기기를 다시 연결하지 못했어요.', { cause: error });
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      stillCurrent(isCurrent);
      if (subscription.endpoint === previousEndpoint) throw new PushEndpointConflict({ cause: error });
      await subscribeAlbumPush(albumId, subscription);
    }
    stillCurrent(isCurrent);
    return subscription;
  })();
}
