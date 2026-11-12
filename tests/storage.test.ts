import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importPhotos, loadPreferences, savePreferences } from '../apps/web/src/storage.ts';

test('invalid upload batch rejects before opening IndexedDB, including a valid first file', async () => {
  const valid = new File(['synthetic bytes'], 'photo.jpg', { type: 'image/jpeg' });
  await assert.rejects(importPhotos([valid, new File(['hello'], 'notes.txt')], 'me'), /지원하는 사진/);
  await assert.rejects(importPhotos([new File(['<svg/>'], 'photo.svg', { type: 'image/svg+xml' })], 'me'), /SVG/);
  await assert.rejects(importPhotos([new File([], 'empty.jpg')], 'me'), /비어 있는/);
});

test('files larger than 50MiB reject before hashing or writing', async () => {
  const large = new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });
  await assert.rejects(importPhotos([large], 'me'), /최대 50MB/);
});

test('preferences are namespaced, validated and tolerate unavailable storage', () => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try {
    assert.deepEqual(loadPreferences(), { member: 'me', filters: ['all'] });
    savePreferences({ member: 'sora', filters: ['others', 'unreceived'] });
    assert.equal([...values.keys()][0], 'phogaem:/:preferences');
    assert.deepEqual(loadPreferences(), { member: 'sora', filters: ['others', 'unreceived'] });
    savePreferences({ member: 'me', filters: ['all'], columns: 6 });
    assert.deepEqual(loadPreferences(), { member: 'me', filters: ['all'], columns: 6 });
    for (const columns of [0, 1, 9, 2.5, '4', null]) {
      values.set('phogaem:/:preferences', JSON.stringify({ member: 'me', filters: ['all'], columns }));
      assert.deepEqual(loadPreferences(), { member: 'me', filters: ['all'] });
    }
    values.set('phogaem:/:preferences', '{broken');
    assert.deepEqual(loadPreferences(), { member: 'me', filters: ['all'] });
    values.set('phogaem:/:preferences', JSON.stringify({ member: 'unknown', filters: ['all'] }));
    assert.deepEqual(loadPreferences(), { member: 'me', filters: ['all'] });
    values.set('phogaem:/:preferences', JSON.stringify({ member: 'me', filters: ['unknown'] }));
    assert.deepEqual(loadPreferences(), { member: 'me', filters: ['all'] });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});


test('photo extensions cannot disguise active MIME and image MIME cannot disguise download extensions', async () => {
  for (const [name, type] of [
    ['photo.jpg', 'text/html'],
    ['photo.png', 'application/xhtml+xml'],
    ['photo.jpg', 'text/javascript'],
    ['photo.html', 'image/png'],
    ['photo.jpg.exe', 'image/jpeg'],
    ['photo', 'image/jpeg'],
  ]) {
    await assert.rejects(importPhotos([new File(['synthetic bytes'], name, { type })], 'me'), /지원하는 사진/);
  }
});

test('video validation accepts supported camera formats and rejects disguised or oversized files atomically', async () => {
  const { validateFile } = await import('../apps/web/src/storage.ts');
  for (const [name, type] of [['clip.mp4', 'video/mp4'], ['clip.MOV', 'video/quicktime'], ['clip.webm', 'video/webm'], ['clip.mov', ''], ['clip.mp4', 'application/octet-stream']]) {
    assert.doesNotThrow(() => validateFile(new File(['synthetic video'], name!, { type })));
  }
  for (const [name, type] of [['clip.mp4', 'text/html'], ['clip.mov', 'image/jpeg'], ['photo.jpg', 'video/mp4'], ['clip.mp4', 'video/webm'], ['clip.html', 'video/mp4'], ['clip.mp4.exe', 'video/mp4'], ['clip.constructor', ''], ['clip.__proto__', 'application/octet-stream']]) {
    await assert.rejects(importPhotos([new File(['valid video'], 'valid.mp4', { type: 'video/mp4' }), new File(['synthetic'], name!, { type })], 'me'), /지원하는 사진/);
  }
  const overLimit = new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'large.mp4', { type: 'video/mp4' });
  await assert.rejects(importPhotos([overLimit], 'me'), /최대 50MB/);
});

test('local repeated videos retain distinct records and bytes while photographs still deduplicate', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const records = new Map<string, import('../apps/web/src/domain.ts').Photo>();
  const db = {
    onversionchange: null as (() => void) | null,
    close() {},
    transaction() {
      let timer: ReturnType<typeof setTimeout>;
      const transaction = { oncomplete: null as (() => void) | null, onabort: null, error: null, objectStore: () => store };
      const complete = () => { clearTimeout(timer); timer = setTimeout(() => transaction.oncomplete?.(), 0); };
      const store = {
        get(id: string) {
          const request = { result: records.get(id), onsuccess: null as (() => void) | null };
          queueMicrotask(() => { request.onsuccess?.(); complete(); });
          return request;
        },
        getAll() { complete(); return { result: [...records.values()] }; },
        add(photo: import('../apps/web/src/domain.ts').Photo) { assert.equal(records.has(photo.id), false); records.set(photo.id, photo); complete(); },
        put(photo: import('../apps/web/src/domain.ts').Photo) { records.set(photo.id, photo); complete(); },
      };
      return transaction;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() {
    const request = { result: db, onsuccess: null as (() => void) | null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } } });
  try {
    const video = new File(['identical original video'], 'trip.MOV');
    const result = await importPhotos([video, video], 'me');
    assert.equal(result.added, 2); assert.equal(result.duplicates, 0);
    assert.notEqual(result.photos[0]!.id, result.photos[1]!.id);
    assert.equal(result.photos[0]!.hash, result.photos[1]!.hash);
    for (const item of result.photos) {
      assert.equal(item.type, 'video/quicktime'); assert.equal(item.importCount, 1);
      assert.equal(await item.blob!.text(), 'identical original video');
    }
    const image = new File(['identical photo'], 'photo.jpg', { type: 'image/jpeg' });
    const mixed = await importPhotos([video, image, image], 'mina');
    assert.equal(mixed.added, 2); assert.equal(mixed.duplicates, 1);
    assert.equal(mixed.photos.filter(item => item.type === 'video/quicktime').length, 3);
    assert.equal(mixed.photos.filter(item => item.type === 'image/jpeg').length, 1);
  } finally {
    db.onversionchange?.();
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});

test('local trash is a reversible atomic partition that retains originals and blocks stale imports/downloads', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  type Photo = import('../apps/web/src/domain.ts').Photo;
  const records = new Map<string, Photo>();
  const db = {
    onversionchange: null as (() => void) | null,
    close() {},
    transaction() {
      const pending = new Map([...records].map(([id, photo]) => [id, structuredClone(photo)]));
      let timer: ReturnType<typeof setTimeout>;
      let aborted = false;
      const transaction = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        error: null,
        abort() { aborted = true; clearTimeout(timer); queueMicrotask(() => transaction.onabort?.()); },
        objectStore: () => store,
      };
      const complete = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (aborted) return;
          records.clear(); for (const [id, photo] of pending) records.set(id, structuredClone(photo));
          transaction.oncomplete?.();
        }, 0);
      };
      const request = <T,>(result: T) => {
        const read = { result, onsuccess: null as (() => void) | null };
        queueMicrotask(() => { if (!aborted) { read.onsuccess?.(); if (!aborted) complete(); } });
        return read;
      };
      const store = {
        get(id: string) { return request(pending.has(id) ? structuredClone(pending.get(id)) : undefined); },
        getAll() { return request([...pending.values()].map(photo => structuredClone(photo))); },
        add(photo: Photo) { assert.equal(pending.has(photo.id), false); pending.set(photo.id, structuredClone(photo)); complete(); },
        put(photo: Photo) { pending.set(photo.id, structuredClone(photo)); complete(); },
      };
      return transaction;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() {
    const request = { result: db, onsuccess: null as (() => void) | null };
    queueMicrotask(() => request.onsuccess?.()); return request;
  } } });
  const modulePath = '../apps/web/src/storage.ts?trash-lifecycle';
  const storage = await import(modulePath) as typeof import('../apps/web/src/storage.ts');
  try {
    const mine = new File(['mine original bytes'], 'mine.jpg', { type: 'image/jpeg' });
    const foreign = new File(['friend original bytes'], 'friend.jpg', { type: 'image/jpeg' });
    const mineId = (await storage.importPhotos([mine], 'me')).photos[0]!.id;
    const foreignId = (await storage.importPhotos([foreign], 'mina')).photos.find(photo => photo.name === 'friend.jpg')!.id;
    await storage.setDownloadState([mineId], 'me', 'requested');
    await storage.setDownloadState([mineId], 'me', 'received');
    const bin = await storage.setTrashState([mineId], 'me', true);
    assert.deepEqual(bin.map(photo => photo.id), [mineId]);
    assert.equal(bin[0]!.trashedBy, 'me'); assert.ok(bin[0]!.trashedAt);
    assert.equal(await bin[0]!.blob!.text(), 'mine original bytes');
    assert.deepEqual((await storage.loadPhotos()).map(photo => photo.id), [foreignId]);
    assert.deepEqual(bin[0]!.receivedBy, ['me']);
    await assert.rejects(storage.setTrashState([mineId, foreignId], 'me', false), /권한/);
    await assert.rejects(storage.setTrashState([mineId, 'missing'], 'me', false), /권한/);
    assert.deepEqual((await storage.loadPhotos(true)).map(photo => photo.id), [mineId]);
    await assert.rejects(storage.importPhotos([new File(['new bytes'], 'new.jpg', { type: 'image/jpeg' }), mine], 'me'), /휴지통/);
    assert.equal(records.size, 2, 'an aborted mixed import must not commit its earlier new file');
    await assert.rejects(storage.setDownloadState([foreignId, mineId], 'me', 'requested'), /휴지통/);
    assert.deepEqual(records.get(foreignId)!.requestedBy, [], 'a rejected batch must not record earlier downloads');
    const restored = await storage.setTrashState([mineId], 'me', false);
    assert.equal(restored.length, 2); assert.deepEqual(await storage.loadPhotos(true), []);
    const restoredMine = restored.find(photo => photo.id === mineId)!;
    assert.equal(restoredMine.trashedAt, undefined); assert.equal(restoredMine.trashedBy, undefined);
    assert.equal(await restoredMine.blob!.text(), 'mine original bytes');
    assert.deepEqual(restoredMine.receivedBy, ['me']);
    assert.equal((await storage.importPhotos([mine], 'me')).duplicates, 1);
  } finally {
    db.onversionchange?.();
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});
