import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPhotos, matchesFilters, hashBlob, formatBytes, defaultAlbumName, mergeUploadedPhoto, buildPhotoStacks, representativeDownloadIds } from '../apps/web/src/domain.ts';
import type { Photo } from '../apps/web/src/domain.ts';

function photo(overrides: Partial<Photo> = {}): Photo {
  return { id: 'one', name: 'one.jpg', type: 'image/jpeg', size: 3, hash: 'abc',
    createdAt: 1, contributors: ['mina'], requestedBy: [], receivedBy: [],
    blob: new Blob(['abc']), importCount: 1, ...overrides };
}

test('complete-byte hashes ignore filenames and distinguish changed bytes', async () => {
  const a = new File(['original image'], 'a.jpg', { type: 'image/jpeg' });
  const renamed = new File(['original image'], 'b.jpg', { type: 'image/jpeg' });
  const changed = new File(['different image'], 'a.jpg', { type: 'image/jpeg' });
  assert.equal(await hashBlob(a), await hashBlob(renamed));
  assert.notEqual(await hashBlob(a), await hashBlob(changed));
  assert.equal(await hashBlob(new Blob(['abc'])), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('mine and others refer to contributions for the active member', () => {
  const shared = photo({ contributors: ['me', 'mina'] });
  assert.equal(matchesFilters(shared, ['mine'], 'me'), true);
  assert.equal(matchesFilters(shared, ['others'], 'me'), false);
  assert.equal(matchesFilters(shared, ['others'], 'jun'), true);
  assert.equal(matchesFilters(shared, ['mine'], 'mina'), true);
});

test('filter combinations use AND and all does not cancel a constraint', () => {
  const pendingDuplicate = photo({ importCount: 2 });
  const received = photo({ id: 'two', importCount: 3, receivedBy: ['me'] });
  const mine = photo({ id: 'three', contributors: ['me'], importCount: 2 });
  const filters = ['all', 'others', 'duplicates', 'unreceived'] as const;
  assert.deepEqual([pendingDuplicate, received, mine].filter((item) => matchesFilters(item, [...filters], 'me')), [pendingDuplicate]);
  assert.equal(matchesFilters(mine, ['mine', 'others'], 'me'), false);
  assert.equal(matchesFilters(pendingDuplicate, [], 'me'), true);
});

test('repeated import by one person is a duplicate without repeating contributor ids', () => {
  const repeated = photo({ contributors: ['me'], importCount: 2 });
  assert.deepEqual(filterPhotos([repeated], 'duplicates', 'me'), [repeated]);
  assert.equal(matchesFilters(photo(), ['duplicates'], 'me'), false);
  assert.equal(matchesFilters(photo({ contributors: ['me', 'mina'], importCount: undefined }), ['duplicates'], 'me'), true);
});

test('download requests are not treated as received and records are per member', () => {
  assert.equal(matchesFilters(photo({ requestedBy: ['me'] }), ['unreceived'], 'me'), true);
  const received = photo({ receivedBy: ['me'] });
  assert.equal(matchesFilters(received, ['unreceived'], 'me'), false);
  assert.equal(matchesFilters(received, ['unreceived'], 'mina'), true);
});

test('byte formatting handles units, zero and invalid values', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(50 * 1024 * 1024), '50 MB');
  assert.equal(formatBytes(-10), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
});

test('default album names use padded local calendar dates', () => {
  assert.equal(defaultAlbumName(new Date(2026, 0, 2, 0, 30)), '260102 여행');
  assert.equal(defaultAlbumName(new Date(2026, 10, 5, 23, 59)), '261105 여행');
  assert.equal(defaultAlbumName(new Date(2028, 1, 29)), '280229 여행');
});

test('out-of-order duplicate upload responses cannot reduce contributions or create another card', () => {
  const previous = photo({ importCount: 3, contributors: ['me', 'mina'] });
  const older = photo({ importCount: 2, contributors: ['jun'] });
  const result = mergeUploadedPhoto([previous, photo({ id: 'other', createdAt: 0 })], older);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.importCount, 3);
  assert.deepEqual(result[0]!.contributors, ['me', 'mina', 'jun']);
  assert.equal(previous.contributors.length, 2);
});


test('duplicates includes comparison candidates while retaining exact imports and other constraints', () => {
  const similar = photo({ id: 'similar', contributors: ['me'] });
  const exact = photo({ id: 'exact', importCount: 2 });
  const unrelated = photo({ id: 'unrelated' });
  const ids = new Set(['similar']);
  assert.deepEqual(filterPhotos([similar, exact, unrelated], 'duplicates', 'me', ids), [similar, exact]);
  assert.equal(matchesFilters(similar, ['duplicates', 'mine'], 'me', ids), true);
  assert.equal(matchesFilters(similar, ['duplicates', 'others'], 'me', ids), false);
  assert.equal(matchesFilters(similar, ['duplicates'], 'me'), false);
  assert.equal(similar.importCount, 1);
});


test('photo stacks put the stored representative first while retaining every original and stable stack order', () => {
  const first = photo({ id: 'first' }); const second = photo({ id: 'second' }); const single = photo({ id: 'single' });
  const photos = [first, single, second];
  const stacks = buildPhotoStacks(photos, [{ id: 'group', photoIds: ['first', 'second'], representativeId: 'second' }]);
  assert.deepEqual(stacks.map(stack => stack.representative.id), ['second', 'single']);
  assert.deepEqual(stacks[0]!.photos, [second, first]);
  assert.deepEqual(photos, [first, single, second]);
  assert.equal(stacks[0]!.photos[0]!.blob, second.blob);
});

test('unknown candidate ids cannot hide a lone known photo and missing representative uses a known member', () => {
  const first = photo({ id: 'first' }); const second = photo({ id: 'second' });
  assert.deepEqual(buildPhotoStacks([first], [{ id: 'foreign', photoIds: ['first', 'unknown'] }]).map(stack => stack.id), ['first']);
  const stacks = buildPhotoStacks([first, second], [{ id: 'group', photoIds: ['unknown', 'second', 'first'], representativeId: 'unknown' }]);
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0]!.representative.id, 'second');
});

test('download ids collapse selected members to one representative per stack and retain separate originals', () => {
  const first = photo({ id: 'first' }); const second = photo({ id: 'second' }); const single = photo({ id: 'single' });
  const stacks = buildPhotoStacks([first, second, single], [{ id: 'group', photoIds: ['first', 'second'], representativeId: 'second' }]);
  assert.deepEqual(representativeDownloadIds(['first', 'second', 'single', 'unknown', 'first'], stacks), ['second', 'single']);
  assert.deepEqual(representativeDownloadIds(['first'], stacks), ['second']);
  assert.deepEqual(first.requestedBy, []);
  assert.deepEqual(second.receivedBy, []);
});

test('videos never match duplicate filters or collapse into photo candidate stacks', () => {
  const video = photo({ id: 'video', type: 'video/mp4', name: 'trip.mp4', importCount: 9 });
  const first = photo({ id: 'first' }); const second = photo({ id: 'second' });
  assert.equal(matchesFilters(video, ['duplicates'], 'me', new Set(['video'])), false);
  assert.equal(matchesFilters(video, ['all', 'others'], 'me'), true);
  const stacks = buildPhotoStacks([video, first, second], [{ id: 'mixed', photoIds: ['video', 'first', 'second'], representativeId: 'video' }]);
  assert.deepEqual(stacks.map(stack => stack.representative.id), ['video', 'first']);
  assert.deepEqual(stacks[0]!.photos, [video]);
  assert.deepEqual(stacks[1]!.photos, [first, second]);
  assert.deepEqual(representativeDownloadIds(['video', 'first', 'second'], stacks), ['video', 'first']);
});
