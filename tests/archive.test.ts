import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { createPhotoArchive, validateArchiveSize, MAX_ARCHIVE_BYTES } from '../apps/web/src/archive.ts';

// Parse the directory independently, then follow its local offsets and verify both records.
async function extract(blob: Blob): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 4, true), 0);
  assert.equal(view.getUint16(end + 6, true), 0);
  const count = view.getUint16(end + 10, true);
  assert.equal(view.getUint16(end + 8, true), count);
  let directory = view.getUint32(end + 16, true);
  assert.equal(directory + view.getUint32(end + 12, true), end);
  const results = [];
  for (let index = 0; index < count; index++) {
    assert.equal(view.getUint32(directory, true), 0x02014b50);
    assert.equal(view.getUint16(directory + 8, true), 0x0800);
    assert.equal(view.getUint16(directory + 10, true), 0); // Stored, not compressed.
    const size = view.getUint32(directory + 24, true);
    assert.equal(view.getUint32(directory + 20, true), size);
    const nameLength = view.getUint16(directory + 28, true);
    const nameBytes = bytes.slice(directory + 46, directory + 46 + nameLength);
    const local = view.getUint32(directory + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    assert.equal(view.getUint16(local + 6, true), 0x0800);
    assert.equal(view.getUint16(local + 8, true), 0);
    assert.equal(view.getUint32(local + 18, true), size);
    assert.equal(view.getUint32(local + 22, true), size);
    assert.equal(view.getUint16(local + 26, true), nameLength);
    assert.deepEqual(bytes.slice(local + 30, local + 30 + nameLength), nameBytes);
    const payload = bytes.slice(local + 30 + nameLength, local + 30 + nameLength + size);
    const expectedCrc = crc32(payload);
    assert.equal(view.getUint32(local + 14, true), expectedCrc);
    assert.equal(view.getUint32(directory + 16, true), expectedCrc);
    results.push({ name: new TextDecoder('utf-8', { fatal: true }).decode(nameBytes), bytes: payload });
    directory += 46 + nameLength + view.getUint16(directory + 30, true) + view.getUint16(directory + 32, true);
  }
  assert.equal(directory, end);
  return results;
}

test('stored archive preserves every original byte, UTF-8 filenames and CRC32', async () => {
  const binary = new Uint8Array(Array.from({ length: 1024 }, (_, index) => index & 0xff));
  const archive = await createPhotoArchive([
    { name: '해변 📷.HEIC', blob: new Blob([binary]) },
    { name: 'photo.png', blob: new Blob(['123456789']) },
    { name: 'empty.jpg', blob: new Blob([]) },
  ]);
  assert.equal(archive.type, 'application/zip');
  const files = await extract(archive);
  assert.deepEqual(files.map(file => file.name), ['해변 📷.HEIC', 'photo.png', 'empty.jpg']);
  assert.deepEqual(files[0]!.bytes, binary);
  assert.equal(new TextDecoder().decode(files[1]!.bytes), '123456789');
  assert.equal(crc32(files[1]!.bytes), 0xcbf43926);
  assert.equal(files[2]!.bytes.length, 0);
});

test('archive flattens paths, disambiguates duplicate names and removes unsafe extraction names', async () => {
  const names = ['../../photo.jpg', 'C:\\travel\\PHOTO.jpg', 'photo (2).jpg', 'photo.jpg', 'CON.png', '.hidden.jpg', '../..', 'bad\u0000:name?.png', 'e\u0301.jpg', 'é.jpg'];
  const files = await extract(await createPhotoArchive(names.map(name => ({ name, blob: new Blob(['x']) }))));
  assert.deepEqual(files.map(file => file.name), ['photo.jpg', 'PHOTO (2).jpg', 'photo (2) (2).jpg', 'photo (3).jpg', '_CON.png', 'hidden.jpg', 'photo', 'bad__name_.png', 'é.jpg', 'é (2).jpg']);
  assert.equal(new Set(files.map(file => file.name.toLowerCase())).size, files.length);
  assert.ok(files.every(file => !/[\\/:]/.test(file.name) && !Array.from(file.name).some(char => char.charCodeAt(0) < 32) && !file.name.startsWith('.')));
});

test('long UTF-8 names remain valid and bounded while retaining extension and distinct names', async () => {
  const name = '여행📷'.repeat(100) + '.heic';
  const files = await extract(await createPhotoArchive([name, name].map(name => ({ name, blob: new Blob(['x']) }))));
  for (const file of files) {
    assert.ok(new TextEncoder().encode(file.name).length <= 240);
    assert.ok(file.name.endsWith('.heic'));
  }
  assert.notEqual(files[0]!.name, files[1]!.name);
});

test('archive rejects oversized/invalid metadata before reading any original', async () => {
  validateArchiveSize([MAX_ARCHIVE_BYTES]);
  validateArchiveSize([0, MAX_ARCHIVE_BYTES - 1, 1]);
  for (const sizes of [[], [-1], [Number.NaN], [Infinity], [1.5], [MAX_ARCHIVE_BYTES, 1], new Array<number>(65536).fill(0)]) {
    assert.throws(() => validateArchiveSize(sizes));
  }
  let read = false;
  const blob = { size: MAX_ARCHIVE_BYTES + 1, stream: () => { read = true; throw new Error('must not read'); } } as unknown as Blob;
  await assert.rejects(createPhotoArchive([{ name: 'large.jpg', blob }]));
  assert.equal(read, false);
});
