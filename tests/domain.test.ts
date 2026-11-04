import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPhotos, matchesFilters, hashBlob, formatBytes } from '../apps/web/src/domain.ts';
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
