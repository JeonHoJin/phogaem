import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinchColumns, rangeSelection } from '../apps/web/src/gridSelection.ts';

const ids = ['a', 'b', 'c', 'd', 'e'];
test('range sweep extends and reverses without changing the original selection snapshot', () => {
  const baseline = new Set(['e', 'outside']);
  assert.deepEqual([...rangeSelection(ids, baseline, 1, 3)], ['e', 'outside', 'b', 'c', 'd']);
  assert.deepEqual([...rangeSelection(ids, baseline, 1, 1)], ['e', 'outside', 'b']);
  assert.deepEqual([...baseline], ['e', 'outside']);
  assert.deepEqual([...rangeSelection(ids, baseline, 3, 1)], ['e', 'outside', 'b', 'c', 'd']);
});
test('a sweep starting selected erases only its inclusive range and reversal restores untouched selections', () => {
  const baseline = new Set(ids);
  assert.deepEqual([...rangeSelection(ids, baseline, 2, 4)], ['a', 'b']);
  assert.deepEqual([...rangeSelection(ids, baseline, 2, 2)], ['a', 'b', 'd', 'e']);
  assert.deepEqual([...rangeSelection(ids, baseline, -1, 3)], ids);
  assert.deepEqual([...rangeSelection(ids, baseline, 2, 8)], ids);
});
test('pinch direction and quantized column bounds keep tiny motion stable', () => {
  assert.equal(pinchColumns(4, 100, 110), 4);
  assert.equal(pinchColumns(4, 100, 130), 3);
  assert.equal(pinchColumns(4, 100, 75), 5);
  assert.equal(pinchColumns(4, 100, 2000), 2);
  assert.equal(pinchColumns(4, 100, 1), 8);
  assert.equal(pinchColumns(4, 100, 1, 6), 6);
  assert.equal(pinchColumns(4, 0, 100), 4);
  assert.equal(pinchColumns(4, 100, NaN), 4);
});
