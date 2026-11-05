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
