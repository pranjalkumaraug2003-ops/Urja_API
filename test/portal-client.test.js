import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortalClient, PortalError } from '../src/portal/client.js';

const BASE = 'https://portal.test';

// Builds a Response like the portal's: JSON body, optional status and extra headers.
function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const LOGIN_OK = () =>
  json(
    { type: 'redirect', status: 303, location: '/meters' },
    { headers: { 'set-cookie': 'session_token=abc123; Path=/; HttpOnly; Secure' } },
  );

// A fake fetch that answers from a list of handlers in order and records every call.
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const handler = handlers.shift();
    if (!handler) throw new Error(`Unexpected request to ${url}`);
    return handler(new URL(url), init);
  };
  fn.calls = calls;
  return fn;
}

function client(fetchImpl, extra = {}) {
  return createPortalClient({ baseUrl: BASE, email: 'op@test', password: 'pw', fetchImpl, minIntervalMs: 0, ...extra });
}

test('logs in once, then sends the session cookie on data requests', async () => {
  const fetchImpl = fakeFetch([LOGIN_OK, () => json({ data: [{ code: 'DT-001' }], total: 1 })]);
  const dts = await client(fetchImpl).getDts();

  assert.deepEqual(dts, [{ code: 'DT-001' }]);
  const [login, dtsCall] = fetchImpl.calls;
  assert.equal(login.init.method, 'POST');
  assert.equal(login.init.headers.origin, BASE);
  assert.equal(login.init.body, 'email=op%40test&password=pw');
  assert.equal(dtsCall.init.headers.cookie, 'session_token=abc123');
});

test('a failed login (HTTP 200 with type "failure") becomes auth_failed', async () => {
  const fetchImpl = fakeFetch([() => json({ type: 'failure', status: 401 })]);
  await assert.rejects(client(fetchImpl).getDts(), (err) => err instanceof PortalError && err.kind === 'auth_failed');
});

test('pages through /portal/dts until total is reached', async () => {
  const page = (n, count) => () => json({ data: Array.from({ length: count }, (_, i) => ({ code: `${n}-${i}` })), total: 25 });
  const fetchImpl = fakeFetch([LOGIN_OK, page(1, 20), page(2, 5)]);
  const dts = await client(fetchImpl).getDts();

  assert.equal(dts.length, 25);
  assert.equal(fetchImpl.calls[2].url.searchParams.get('page'), '2');
});

test('on a session 401 it logs in again and retries once', async () => {
  const fetchImpl = fakeFetch([
    LOGIN_OK,
    () => json({ error: 'unauthorized' }, { status: 401 }),
    LOGIN_OK,
    () => json({ data: [], total: 0 }),
  ]);
  const dts = await client(fetchImpl).getDts();
  assert.deepEqual(dts, []);
  assert.equal(fetchImpl.calls.length, 4);
});

test('signs the export request with the secret from /portal/keys', async () => {
  const fixedNow = 1767225600 * 1000;
  const fetchImpl = fakeFetch([
    LOGIN_OK,
    () => json({ data: { signingSecret: 'test-secret-0123456789abcdef0123' } }),
    () => json({ data: [{ meterId: 'J100000' }], total: 1 }),
  ]);
  const meters = await client(fetchImpl, { now: () => fixedNow }).getMeterExport();

  assert.deepEqual(meters, [{ meterId: 'J100000' }]);
  const exportCall = fetchImpl.calls[2];
  assert.equal(exportCall.url.pathname, '/portal/export');
  assert.equal(exportCall.url.search, '?page=1');
  assert.equal(exportCall.init.headers['x-timestamp'], '1767225600');
  assert.equal(exportCall.init.headers['x-signature'], 'ac918ab23e45064f471624bbab887d80eb051195e64e2bf73a08d5b9ae2ec947');
});

test('maps 429, 404 and HTML responses to PortalError kinds', async () => {
  const cases = [
    [() => json({ error: 'rate_limited' }, { status: 429 }), 'rate_limited'],
    [() => json({ error: 'not_found' }, { status: 404 }), 'not_found'],
    [() => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'bad_response'],
  ];
  for (const [handler, kind] of cases) {
    const fetchImpl = fakeFetch([LOGIN_OK, handler]);
    await assert.rejects(
      client(fetchImpl).getEnergy('J100001', { from: '2026-06-01', to: '2026-06-01' }),
      (err) => err.kind === kind,
    );
  }
});

test('sends from and to on energy requests', async () => {
  const fetchImpl = fakeFetch([LOGIN_OK, () => json({ data: [] })]);
  await client(fetchImpl).getEnergy('J100001', { from: '2026-06-01', to: '2026-06-03' });
  const call = fetchImpl.calls[1];
  assert.equal(call.url.pathname, '/portal/meters/J100001/energy');
  assert.equal(call.url.search, '?from=2026-06-01&to=2026-06-03');
});

test('a timeout becomes a timeout PortalError', async () => {
  const fetchImpl = fakeFetch([
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        // AbortSignal.timeout() does not keep Node alive on its own, so hold the event loop open.
        const keepAlive = setTimeout(() => {}, 1000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal.reason);
        });
      }),
  ]);
  await assert.rejects(client(fetchImpl, { timeoutMs: 20 }).getDts(), (err) => err.kind === 'timeout');
});

test('after a 429 it stops calling the portal until the cooldown ends', async () => {
  let clock = 0;
  const fetchImpl = fakeFetch([LOGIN_OK, () => json({ error: 'rate_limited' }, { status: 429 }), () => json({ data: [], total: 0 })]);
  const portal = client(fetchImpl, { now: () => clock });

  await assert.rejects(portal.getDts(), (err) => err.kind === 'rate_limited' && err.retryAfterSeconds === 30);
  clock = 10_000;
  await assert.rejects(portal.getDts(), (err) => err.kind === 'rate_limited' && err.retryAfterSeconds === 20);
  assert.equal(fetchImpl.calls.length, 2); // the blocked call never reached the portal

  clock = 30_000;
  assert.deepEqual(await portal.getDts(), []);
});

test('throttle: requests start at least minIntervalMs apart', async () => {
  const starts = [];
  const fetchImpl = async () => {
    starts.push(Date.now());
    return starts.length === 1 ? LOGIN_OK() : json({ data: [], total: 0 });
  };
  const portal = client(fetchImpl, { minIntervalMs: 40 });
  await Promise.all([portal.getDts(), portal.getDts()]);

  assert.equal(starts.length, 3); // one login, two data calls
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= 35, `gap ${starts[i] - starts[i - 1]} ms is too short`);
  }
});
