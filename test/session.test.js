import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, unsign, parseCookies } from '../server/session.js';

test('sign/unsign round-trips a value', () => {
  const value = Buffer.from(JSON.stringify({ uid: 'abc' })).toString('base64url');
  assert.equal(unsign(sign(value)), value);
});

test('rejects tampered values', () => {
  const signed = sign('hello');
  assert.equal(unsign(`${signed}x`), null);
  assert.equal(unsign(signed.replace('hello', 'hacked')), null);
});

test('rejects garbage', () => {
  assert.equal(unsign('not-signed'), null);
  assert.equal(unsign(''), null);
  assert.equal(unsign(null), null);
  assert.equal(unsign('.onlymac'), null);
});

test('parses cookie headers', () => {
  assert.deepEqual(parseCookies('a=1; b=two%20words; malformed'), { a: '1', b: 'two words' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
});
