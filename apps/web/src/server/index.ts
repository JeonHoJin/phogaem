// Adapted from schedule-parser/apps/mobile/src/server/index.ts.
// Key-store access is lazy: constructing this module never opens IndexedDB or signs in.
import { ServerClient, type KeyStore } from './client.ts';

const DEFAULT_API_BASE = 'https://168-107-32-199.sslip.io';

export function validateApiBase(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('서버 주소는 HTTPS 출처 또는 로컬 개발용 HTTP 출처여야 합니다.');
  }
  return url.origin;
}

export const API_BASE = validateApiBase(import.meta.env?.VITE_MLHOPS_API_BASE || DEFAULT_API_BASE);

export function deviceKeyNamespace(): string {
  const path = import.meta.env?.BASE_URL ?? (typeof location === 'undefined' ? '/' : new URL('.', location.href).pathname);
  return `phogaem-keys:${path}`;
}

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(deviceKeyNamespace(), 1);
    request.onupgradeneeded = () => request.result.createObjectStore('device');
    request.onerror = () => reject(new Error('기기 키 저장소를 열지 못했어요. 브라우저의 저장소 설정을 확인해 주세요.'));
    request.onblocked = () => reject(new Error('다른 포갬 탭을 닫고 다시 시도해 주세요.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function keyRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('device', mode);
    const request = run(transaction.objectStore('device'));
    transaction.oncomplete = () => { db.close(); resolve(request.result); };
    transaction.onerror = transaction.onabort = () => { db.close(); reject(new Error('기기 키를 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.')); };
  });
}

export const indexedDbKeyStore: KeyStore = {
  get: () => keyRequest('readonly', store => store.get('default') as IDBRequest<CryptoKeyPair | undefined>),
  put: keys => keyRequest('readwrite', store => store.put(keys, 'default')).then(() => undefined),
};

export const server = new ServerClient({ base: API_BASE, store: indexedDbKeyStore });
export { ServerError } from './client.ts';
