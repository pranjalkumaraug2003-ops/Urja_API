import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRequest } from '../src/portal/sign.js';

// Expected value computed independently with:
// printf 'GET\n/portal/export\npage=1\n1767225600' | openssl dgst -sha256 -hmac 'test-secret-0123456789abcdef0123'
test('signRequest matches an independently computed HMAC-SHA256', () => {
  const signature = signRequest({
    method: 'GET',
    path: '/portal/export',
    query: 'page=1',
    timestamp: '1767225600',
    secret: 'test-secret-0123456789abcdef0123',
  });
  assert.equal(signature, 'ac918ab23e45064f471624bbab887d80eb051195e64e2bf73a08d5b9ae2ec947');
});

test('signRequest changes when the query string changes', () => {
  const base = { method: 'GET', path: '/portal/export', timestamp: '1767225600', secret: 's' };
  assert.notEqual(signRequest({ ...base, query: 'page=1' }), signRequest({ ...base, query: 'page=2' }));
});
