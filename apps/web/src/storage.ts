import { hashBlob, MEMBERS } from './domain.ts';
import type { MemberId, Photo, PhotoFilter } from './domain.ts';

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const FILTERS: PhotoFilter[] = ['all', 'others', 'mine', 'duplicates', 'unreceived'];
type Preferences = { filters: PhotoFilter[]; member: MemberId };

function namespace(): string {
  const segment = typeof location === 'undefined' ? '' : location.pathname.split('/').filter(Boolean)[0];
  return `phogaem:/${segment && segment !== 'index.html' ? `${segment}/` : ''}`;
}

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(namespace(), 1);
    request.onupgradeneeded = () => request.result.createObjectStore('photos', { keyPath: 'id' });
    request.onerror = () => reject(request.error ?? new Error('사진 보관함을 열 수 없습니다.'));
    request.onblocked = () => reject(new Error('다른 탭을 닫고 다시 시도해 주세요.'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  }).catch((error: unknown) => { database = undefined; throw error; });
  return database;
}

function storageError(error: DOMException | null): Error {
  if (error?.name === 'QuotaExceededError') return new Error('이 브라우저의 저장 공간이 부족합니다. 원본은 기기에 그대로 남아 있습니다.');
  return error ?? new Error('사진 저장에 실패했습니다. 브라우저 저장 공간과 권한을 확인해 주세요.');
}

export async function loadPhotos(): Promise<Photo[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('photos', 'readonly');
    const request = transaction.objectStore('photos').getAll();
    transaction.oncomplete = () => resolve((request.result as Photo[]).sort((a, b) => b.createdAt - a.createdAt));
    transaction.onabort = () => reject(storageError(transaction.error));
  });
}

function validateFile(file: File): void {
  if (file.size > MAX_FILE_SIZE) throw new Error(`${file.name}: 파일당 최대 50MB까지 올릴 수 있습니다.`);
  if (file.size === 0) throw new Error(`${file.name}: 비어 있는 파일입니다.`);
  if (/svg/i.test(file.type) || /\.svgz?$/i.test(file.name)) throw new Error(`${file.name}: SVG 파일은 업로드할 수 없습니다.`);
  const allowedType = /^image\/(jpeg|png|webp|gif|avif|heic|heif|heic-sequence|heif-sequence)$/i.test(file.type);
  const allowedExtension = /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(file.name);
  if (!allowedType && !allowedExtension) throw new Error(`${file.name}: 지원하는 사진 파일을 선택해 주세요.`);
}

export async function importPhotos(files: File[], member: MemberId): Promise<{ added: number; duplicates: number; photos: Photo[] }> {
  files.forEach(validateFile);
  // Hash before opening a write transaction; asynchronous hashing would make it inactive.
  const prepared: { file: File; hash: string }[] = [];
  for (const file of files) prepared.push({ file, hash: await hashBlob(file) });
  const db = await openDatabase();
  let added = 0;
  let duplicates = 0;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('photos', 'readwrite');
    const store = transaction.objectStore('photos');
    let index = 0;
    const next = () => {
      const item = prepared[index++];
      if (!item) return;
      const id = `${item.hash}:${item.file.size}`;
      const request = store.get(id);
      request.onsuccess = () => {
        const existing = request.result as Photo | undefined;
        if (existing) {
          duplicates += 1;
          existing.importCount = (existing.importCount ?? existing.contributors.length) + 1;
          if (!existing.contributors.includes(member)) existing.contributors.push(member);
          store.put(existing);
        } else {
          added += 1;
          store.add({
            id, name: item.file.name, type: item.file.type, size: item.file.size,
            hash: item.hash, createdAt: Date.now(), contributors: [member],
            requestedBy: [], receivedBy: [], blob: item.file, importCount: 1,
          } satisfies Photo);
        }
        next();
      };
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(storageError(transaction.error));
    next();
  });
  return { added, duplicates, photos: await loadPhotos() };
}

export async function setDownloadState(ids: string[], member: MemberId, state: 'requested' | 'received' | 'reset'): Promise<Photo[]> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('photos', 'readwrite');
    const store = transaction.objectStore('photos');
    for (const id of new Set(ids)) {
      const request = store.get(id);
      request.onsuccess = () => {
        const photo = request.result as Photo | undefined;
        if (!photo) return;
        if (state === 'reset') {
          photo.requestedBy = photo.requestedBy.filter((id) => id !== member);
          photo.receivedBy = photo.receivedBy.filter((id) => id !== member);
        } else if (state === 'requested') {
          if (!photo.requestedBy.includes(member)) photo.requestedBy.push(member);
        } else if (photo.requestedBy.includes(member) && !photo.receivedBy.includes(member)) photo.receivedBy.push(member);
        store.put(photo);
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(storageError(transaction.error));
  });
  return loadPhotos();
}

export function loadPreferences(): Preferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`${namespace()}:preferences`) ?? 'null');
    if (value && typeof value === 'object' && 'member' in value && 'filters' in value &&
      MEMBERS.some((member) => member.id === value.member) && Array.isArray(value.filters) &&
      value.filters.every((filter: unknown) => FILTERS.includes(filter as PhotoFilter))) {
      return { member: value.member as MemberId, filters: value.filters as PhotoFilter[] };
    }
  } catch { /* A blocked or corrupted preference store must not prevent opening the album. */ }
  return { member: 'me', filters: ['all'] };
}

export function savePreferences(preferences: Preferences): void {
  localStorage.setItem(`${namespace()}:preferences`, JSON.stringify(preferences));
}

const SCENES = [
  ['바다로 가는 길', '#d6e4e8', '#8eb7be', '#426b69', '#ddd1b1'],
  ['오후의 해변', '#e9c7aa', '#b5c8bd', '#4d7c79', '#eddbc1'],
  ['초록의 오름', '#dce6dd', '#a9bc97', '#59775b', '#bec99d'],
  ['노을이 머문 곳', '#d8a790', '#c09b90', '#635f69', '#d2ac90'],
  ['숲에서 만난 빛', '#dbe0b5', '#8ba280', '#3f6655', '#b1bb8c'],
  ['작은 포구', '#c7dfe0', '#93b7ba', '#597e86', '#d6d0b5'],
  ['우리의 아침', '#ede2c6', '#c1c5ac', '#7e967c', '#dfd5b9'],
  ['수평선 너머', '#c5d7df', '#7fa9ba', '#4a7182', '#c9c8bb'],
  ['돌담을 따라서', '#e4d9c3', '#adbea3', '#697f68', '#b5ae95'],
  ['마지막 산책', '#d9c5b5', '#aebcb1', '#6d8e88', '#d7c4a7'],
  ['파도가 들리는 밤', '#abb9c7', '#7a93a8', '#435e77', '#b3b8b2'],
  ['다음에 또 만나', '#efd5b7', '#c5c3a1', '#739389', '#e4d4b4'],
];

function landscape(index: number): Blob {
  const [, sky, far, near, sand] = SCENES[index]!;
  const sunX = 170 + (index * 67) % 500;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${sky}"/><stop offset="1" stop-color="${sand}"/></linearGradient><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".65" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".08"/></feComponentTransfer><feBlend in="SourceGraphic" mode="multiply"/></filter></defs><g filter="url(#grain)"><path fill="url(#sky)" d="M0 0h1200v900H0z"/><circle cx="${sunX}" cy="${190 + index * 8}" r="65" fill="#fff5d5" opacity=".75"/><path d="M0 530 Q200 ${280 + index * 9} 420 480 T850 440 L1200 390V900H0Z" fill="${far}"/><path d="M0 650 Q290 450 530 610 T1200 490V900H0Z" fill="${near}"/><path d="M0 760 Q360 670 680 790 T1200 710V900H0Z" fill="${sand}"/><path d="M0 730 Q320 650 650 750 T1200 680" fill="none" stroke="#f8f3df" stroke-width="5" opacity=".6"/><path d="M850 900Q730 810 690 750" fill="none" stroke="#fff3d8" stroke-width="32" opacity=".35"/></g></svg>`;
  return new Blob([svg], { type: 'image/svg+xml' });
}

export async function seedDemo(): Promise<Photo[]> {
  const photos: Photo[] = await Promise.all(SCENES.map(async (scene, index) => {
    const blob = landscape(index);
    const hash = await hashBlob(blob);
    const contributor = MEMBERS[index % MEMBERS.length]!.id;
    const contributors: MemberId[] = index % 4 === 1 ? [contributor, 'me'] : [contributor];
    return {
      id: `${hash}:${blob.size}`, name: `${String(index + 1).padStart(2, '0')}_${scene[0]}.svg`,
      type: blob.type, size: blob.size, hash, createdAt: Date.UTC(2026, 9, 17, 9 + index),
      contributors, requestedBy: index === 2 || index === 3 ? ['me'] : [], receivedBy: index === 3 ? ['me'] : [],
      blob, importCount: contributors.length,
    };
  }));
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('photos', 'readwrite');
    const store = transaction.objectStore('photos');
    const request = store.count();
    request.onsuccess = () => { if (request.result === 0) for (const photo of photos) store.add(photo); };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(storageError(transaction.error));
  });
  return loadPhotos();
}
