import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../src/cache.js';

// Lets a background refresh (started without await) finish before we check.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(options = {}) {
  let clock = 0;
  const cache = createCache({ now: () => clock, ...options });
  return { cache, advance: (ms) => (clock += ms) };
}

test('serves a fresh entry without calling the loader again', async () => {
  const { cache } = setup();
  let calls = 0;
  const loader = async () => ++calls;

  assert.equal((await cache.get('k', loader, { ttlMs: 1000 })).value, 1);
  const second = await cache.get('k', loader, { ttlMs: 1000 });
  assert.deepEqual([second.value, second.stale, calls], [1, false, 1]);
});

test('single flight: parallel misses share one load', async () => {
  const { cache } = setup();
  let calls = 0;
  const loader = async () => {
    calls++;
    await settle();
    return 'v';
  };
  const results = await Promise.all([1, 2, 3].map(() => cache.get('k', loader, { ttlMs: 1000 })));
  assert.equal(calls, 1);
  assert.deepEqual(results.map((r) => r.value), ['v', 'v', 'v']);
});

test('stale-while-revalidate: an expired entry is served at once and refreshed in the background', async () => {
  const { cache, advance } = setup();
  let version = 0;
  const loader = async () => ++version;

  await cache.get('k', loader, { ttlMs: 1000 });
  advance(1500);
  const stale = await cache.get('k', loader, { ttlMs: 1000 });
  assert.deepEqual([stale.value, stale.stale], [1, true]);

  await settle();
  const fresh = await cache.get('k', loader, { ttlMs: 1000 });
  assert.deepEqual([fresh.value, fresh.stale], [2, false]);
});

test('a failed refresh keeps serving the stale copy and waits before retrying', async () => {
  const errors = [];
  const { cache, advance } = setup({ retryDelayMs: 30_000, onRefreshError: (key, err) => errors.push(err.message) });
  let calls = 0;
  let fail = false;
  const loader = async () => {
    calls++;
    if (fail) throw new Error('portal down');
    return 'good';
  };

  await cache.get('k', loader, { ttlMs: 1000 });
  fail = true;
  advance(2000);
  assert.equal((await cache.get('k', loader, { ttlMs: 1000 })).value, 'good');
  await settle();
  assert.deepEqual(errors, ['portal down']);

  advance(10_000); // still inside the retry delay: no new portal call
  assert.equal((await cache.get('k', loader, { ttlMs: 1000 })).stale, true);
  await settle();
  assert.equal(calls, 2);

  advance(30_000); // retry delay over: one more attempt
  await cache.get('k', loader, { ttlMs: 1000 });
  await settle();
  assert.equal(calls, 3);
});

test('a failed first load reaches the caller and caches nothing', async () => {
  const { cache } = setup();
  await assert.rejects(cache.get('k', async () => { throw new Error('boom'); }, { ttlMs: 1000 }), /boom/);
  assert.equal(cache.size(), 0);
  assert.equal((await cache.get('k', async () => 'ok', { ttlMs: 1000 })).value, 'ok');
});

test('evicts the oldest entry beyond maxEntries', async () => {
  const { cache } = setup({ maxEntries: 2 });
  for (const key of ['a', 'b', 'c']) await cache.get(key, async () => key, { ttlMs: 1000 });
  assert.equal(cache.size(), 2);
  assert.equal(cache.peek('a'), null);
  assert.equal(cache.peek('c').value, 'c');
});

test('an infinite TTL never expires', async () => {
  const { cache, advance } = setup();
  await cache.get('k', async () => 'past day', { ttlMs: Infinity });
  advance(10 ** 12);
  assert.equal(cache.peek('k').stale, false);
});
