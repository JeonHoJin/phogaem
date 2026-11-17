import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashBlob } from '../apps/web/src/domain.ts';
import { addRecoveryCompletion, clearUploadRecovery, createRecoveryMatcher, createUploadRecovery, loadUploadRecovery, saveUploadRecovery } from '../apps/web/src/uploadRecovery.ts';

const scope = { userId: 'user-a', albumId: 'album-a' };
const photo = (body = 'original', name = 'photo.jpg', type = 'image/jpeg') => new File([body], name, { type });
async function fingerprint(file: File) { return { hash: await hashBlob(file), size: file.size, type: file.type }; }

test('recovery skips acknowledged bytes only, not matching filenames or modification metadata', async () => {
  const original = photo();
  const manifest = addRecoveryCompletion(createUploadRecovery(3), await fingerprint(original));
  const matcher = createRecoveryMatcher(manifest);
  assert.equal(await matcher.consume(photo('modified')), false); // Same name and size.
  assert.equal(await matcher.consume(photo('original', 'renamed.jpg')), true);
  assert.equal(await matcher.consume(original), false); // Exactly one acknowledged occurrence.
  assert.equal(manifest.completed[0]!.count, 1); // Matching does not mutate persistence.
});

test('identical videos consume only completed multiplicity and independent retries start from saved counts', async () => {
  const video = photo('video', 'clip.mov', 'video/quicktime');
  let manifest = createUploadRecovery(4);
  manifest = addRecoveryCompletion(manifest, await fingerprint(video));
  manifest = addRecoveryCompletion(manifest, await fingerprint(video));
  const matcher = createRecoveryMatcher(manifest);
  assert.deepEqual(await Promise.all([matcher.consume(video), matcher.consume(video), matcher.consume(video)]), [true, true, false]);
  assert.equal(await createRecoveryMatcher(manifest).consume(video), true);
  const wrongType = photo('video', 'clip.mp4', 'video/mp4');
  assert.equal(await createRecoveryMatcher(manifest).consume(wrongType), false);
});

test('hashing is lazy, skips impossible metadata and supports unspecified camera MIME', async () => {
  const file = photo();
  const matcher = createRecoveryMatcher(addRecoveryCompletion(createUploadRecovery(2), await fingerprint(file)));
  let reads = 0;
  const unknown = photo('original', 'photo.jpg', '');
  const originalRead = unknown.arrayBuffer.bind(unknown);
  unknown.arrayBuffer = async () => { reads += 1; return originalRead(); };
  assert.equal(reads, 0);
  assert.equal(await matcher.consume(photo('other size')), false);
  assert.equal(reads, 0);
  assert.equal(await matcher.consume(unknown), true);
  assert.equal(reads, 1);
});

test('storage isolates account and album, rejects malformed/versioned counts, and contains no names or bytes', async () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  try {
    const manifest = addRecoveryCompletion(createUploadRecovery(3), await fingerprint(photo()));
    assert.equal(saveUploadRecovery(scope, manifest), true);
    assert.deepEqual(loadUploadRecovery(scope), manifest);
    assert.equal(loadUploadRecovery({ ...scope, userId: 'user-b' }), null);
    assert.equal(loadUploadRecovery({ ...scope, albumId: 'album-b' }), null);
    const key = [...values.keys()][0]!;
    assert.equal(key, 'phogaem:/:upload-recovery:user-a:album-a');
    assert.doesNotMatch(values.get(key)!, /photo.jpg|original|lastModified/);
    for (const invalid of ['{broken', JSON.stringify({ ...manifest, version: 2 }), JSON.stringify({ ...manifest, plannedCount: 0 }), JSON.stringify({ ...manifest, completed: [{ ...manifest.completed[0], count: 4 }] }), JSON.stringify({ ...manifest, completed: [manifest.completed[0], manifest.completed[0]] })]) {
      values.set(key, invalid); assert.equal(loadUploadRecovery(scope), null);
    }
    saveUploadRecovery(scope, manifest);
    assert.equal(clearUploadRecovery(scope), true); assert.equal(loadUploadRecovery(scope), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('unavailable persistence is explicit and does not throw or mutate acknowledged state', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  try {
    const manifest = addRecoveryCompletion(createUploadRecovery(1), await fingerprint(photo()));
    assert.equal(saveUploadRecovery(scope, manifest), false);
    assert.equal(loadUploadRecovery(scope), null);
    assert.equal(clearUploadRecovery(scope), false);
    assert.equal(manifest.completed[0]!.count, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
  assert.throws(() => createUploadRecovery(0));
  assert.throws(() => createUploadRecovery(20_001));
  const full = addRecoveryCompletion(createUploadRecovery(1), await fingerprint(photo()));
  assert.throws(() => addRecoveryCompletion(full, full.completed[0]!));
});
