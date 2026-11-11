import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThumbnailCache } from '../apps/web/src/thumbnailCache.ts';

function deferred() {
  let resolve!: (blob: Blob) => void;
  const promise = new Promise<Blob>(done => { resolve = done; });
  return { promise, resolve };
}
const miss = () => { throw new Error('unexpected thumbnail cache miss'); };

test('thumbnail cache shares in-flight reads and reuses completed blobs without another load', async () => {
  const cache = new ThumbnailCache();
  const held = deferred();
  let reads = 0;
  const first = cache.get('album:photo', () => { reads += 1; return held.promise; });
  const second = cache.get('album:photo', miss);
  assert.equal(first, second);
  const blob = new Blob(['thumbnail']);
  held.resolve(blob);
  assert.equal(await first, blob);
  assert.equal(await cache.get('album:photo', miss), blob);
  assert.equal(reads, 1);
});

test('thumbnail entry limit evicts the least recently used blob and a hit promotes it', async () => {
  const cache = new ThumbnailCache({ maxEntries: 2 });
  const a = await cache.get('a', async () => new Blob(['a']));
  await cache.get('b', async () => new Blob(['b']));
  assert.equal(await cache.get('a', miss), a);
  const c = await cache.get('c', async () => new Blob(['c']));
  assert.equal(await cache.get('a', miss), a);
  assert.equal(await cache.get('c', miss), c);
  let reloaded = false;
  await cache.get('b', async () => { reloaded = true; return new Blob(['b2']); });
  assert.equal(reloaded, true);
});

test('thumbnail byte limit evicts old blobs independently of the entry limit', async () => {
  const cache = new ThumbnailCache({ maxEntries: 10, maxBytes: 7 });
  const a = await cache.get('a', async () => new Blob(['aaa']));
  await cache.get('b', async () => new Blob(['bbb']));
  await cache.get('a', miss);
  const c = await cache.get('c', async () => new Blob(['ccc']));
  assert.equal(await cache.get('a', miss), a);
  assert.equal(await cache.get('c', miss), c);
  let reloaded = false;
  await cache.get('b', async () => { reloaded = true; return new Blob(['b']); });
  assert.equal(reloaded, true);
});

test('oversized thumbnails are returned without being cached or evicting usable entries', async () => {
  const cache = new ThumbnailCache({ maxBytes: 4 });
  const small = await cache.get('small', async () => new Blob(['x']));
  let reads = 0;
  const loadLarge = async () => { reads += 1; return new Blob(['12345']); };
  assert.equal((await cache.get('large', loadLarge)).size, 5);
  assert.equal((await cache.get('large', loadLarge)).size, 5);
  assert.equal(reads, 2);
  assert.equal(await cache.get('small', miss), small);
});

test('failed thumbnail reads, including synchronous loader failures, remain retryable', async () => {
  const cache = new ThumbnailCache();
  await assert.rejects(cache.get('photo', () => { throw new Error('sync failure'); }), /sync failure/);
  await assert.rejects(cache.get('photo', async () => { throw new Error('async failure'); }), /async failure/);
  const recovered = new Blob(['recovered']);
  assert.equal(await cache.get('photo', async () => recovered), recovered);
  assert.equal(await cache.get('photo', miss), recovered);
});

test('clear isolates old completions and their cleanup from a newer request for the same key', async () => {
  const cache = new ThumbnailCache();
  const old = deferred();
  const fresh = deferred();
  const oldRead = cache.get('album:photo', () => old.promise);
  cache.clear();
  const freshRead = cache.get('album:photo', () => fresh.promise);
  const oldBlob = new Blob(['old']);
  old.resolve(oldBlob);
  assert.equal(await oldRead, oldBlob);
  assert.equal(cache.get('album:photo', miss), freshRead);
  const freshBlob = new Blob(['fresh']);
  fresh.resolve(freshBlob);
  assert.equal(await freshRead, freshBlob);
  assert.equal(await cache.get('album:photo', miss), freshBlob);
});

test('clear releases fulfilled entries and resets the byte budget', async () => {
  const cache = new ThumbnailCache({ maxBytes: 4 });
  await cache.get('a', async () => new Blob(['aaaa']));
  cache.clear();
  const fresh = await cache.get('b', async () => new Blob(['bbbb']));
  assert.equal(await cache.get('b', miss), fresh);
  let reloaded = false;
  await cache.get('a', async () => { reloaded = true; return new Blob(['a']); });
  assert.equal(reloaded, true);
});
