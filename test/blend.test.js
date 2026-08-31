import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendRecent } from '../server/blend.js';

const t = (uri) => ({ uri });
const uris = (tracks) => tracks.map((x) => x.uri);

test('interleaves members round-robin, newest first', () => {
  const result = blendRecent([
    [t('a1'), t('a2')],
    [t('b1'), t('b2')],
  ]);
  assert.deepEqual(uris(result), ['a1', 'b1', 'a2', 'b2']);
});

test('dedupes repeat plays within a single member', () => {
  const result = blendRecent([[t('x'), t('x'), t('y'), t('x')]]);
  assert.deepEqual(uris(result), ['x', 'y']);
});

test('dedupes the same track across members (first picker wins)', () => {
  const result = blendRecent([
    [t('shared'), t('a2')],
    [t('shared'), t('b2')],
  ]);
  assert.deepEqual(uris(result), ['shared', 'b2', 'a2']);
});

test('respects the limit', () => {
  const result = blendRecent(
    [
      [t('a1'), t('a2'), t('a3')],
      [t('b1'), t('b2'), t('b3')],
    ],
    { limit: 3 }
  );
  assert.deepEqual(uris(result), ['a1', 'b1', 'a2']);
});

test('drains longer lists once shorter members run out', () => {
  const result = blendRecent([[t('a1')], [t('b1'), t('b2'), t('b3')]], { limit: 10 });
  assert.deepEqual(uris(result), ['a1', 'b1', 'b2', 'b3']);
});

test('handles empty input', () => {
  assert.deepEqual(blendRecent([]), []);
  assert.deepEqual(blendRecent([[], []]), []);
});

test('skips items without a uri and carries extra fields through', () => {
  const result = blendRecent([[{ uri: 'a1', extra: 42 }, { name: 'no uri' }, null]]);
  assert.deepEqual(result, [{ uri: 'a1', extra: 42 }]);
});
