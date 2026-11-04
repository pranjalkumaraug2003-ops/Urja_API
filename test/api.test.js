// End-to-end tests of our API through supertest: real app, real service and cache, fake portal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createMeterService } from '../src/service.js';
import { PortalError } from '../src/portal/client.js';

const node = (name, code) => ({ name, code });
const hierarchy = (dt) => ({
  zone: node('Jaipur Zone 1', 'Z-01'),
  circle: node('Circle 1', 'C-01'),
  division: node('Division 1', 'D-01'),
  subdivision: node('Subdivision 1', 'SD-01'),
  substation: node('Substation 1', 'SS-01'),
  feeder: node('Feeder 1', 'F-001'),
  dt,
});
const rawMeter = (meterId, dtCode) => ({
  meterId,
  serialNo: `SE${meterId.slice(1)}`,
  make: 'HPL',
  phaseType: 'single',
  installStatus: 'Installed',
  installType: 'Whole Current',
  build: 'legacy',
  dtCode,
  hierarchy: hierarchy(node(`DT ${dtCode}`, dtCode)),
  geo: { lat: 26.9, lng: 75.8 },
});

const RAW_DTS = [{ code: 'DT-001', name: 'DT DT-001', feederCode: 'F-001', capacityKva: 100 }];
const RAW_METERS = [rawMeter('J100002', 'DT-001'), rawMeter('J100001', 'DT-001'), rawMeter('J100003', 'DT-001')];
const RAW_ENERGY = [
  { timestamp: '01/06/2026 00:00', kwh: '100.00', kvah: '110.00', voltR: '231' },
  { timestamp: '01/06/2026 00:30', kwh: '100.50', kvah: '110.60', voltR: '232' },
];

// A portal client double: same three methods, canned data, call counts, optional failures.
function fakePortal({ failWith } = {}) {
  const calls = { dts: 0, export: 0, energy: 0 };
  const maybeFail = () => {
    if (failWith) throw failWith;
  };
  return {
    calls,
    async getDts() {
      calls.dts++;
      maybeFail();
      return RAW_DTS;
    },
    async getMeterExport() {
      calls.export++;
      maybeFail();
      return RAW_METERS;
    },
    async getEnergy() {
      calls.energy++;
      return RAW_ENERGY;
    },
  };
}

function setup(portalOptions) {
  const portal = fakePortal(portalOptions);
  // "now" is fixed in November 2026, so June 2026 windows count as past days (cached forever).
  const service = createMeterService({ portal, now: () => Date.parse('2026-11-04T06:00:00Z') });
  const app = createApp({ service, openapi: { openapi: '3.0.3', info: { title: 'test', version: '1' }, paths: {} } });
  return { app, portal };
}

test('GET /v1/meters returns cleaned meters with paging meta', async () => {
  const { app } = setup();
  const res = await request(app).get('/v1/meters').expect(200);

  assert.deepEqual(res.body.data.map((m) => m.meterId), ['J100001', 'J100002', 'J100003']);
  assert.equal(res.body.data[0].installType, 'whole_current');
  assert.equal(res.body.meta.total, 3);
  assert.equal(res.body.meta.limit, 100);
  assert.equal(res.body.meta.offset, 0);
  assert.equal(res.body.meta.stale, false);
  assert.match(res.body.meta.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('limit and offset page through the list', async () => {
  const { app } = setup();
  const res = await request(app).get('/v1/meters?limit=1&offset=1').expect(200);
  assert.deepEqual(res.body.data.map((m) => m.meterId), ['J100002']);
});

test('unknown and invalid query parameters are rejected with every problem listed', async () => {
  const { app } = setup();
  const res = await request(app).get('/v1/meters?limit=0&page=2').expect(400);

  assert.equal(res.body.error.code, 'validation_error');
  assert.deepEqual(res.body.error.details, [
    { param: 'limit', issue: 'must be at least 1' },
    { param: 'page', issue: 'unknown parameter' },
  ]);
});

test('GET /v1/meters/:id is case-insensitive; an unknown id is a 404', async () => {
  const { app } = setup();
  const found = await request(app).get('/v1/meters/j100001').expect(200);
  assert.equal(found.body.data.meterId, 'J100001');

  const missing = await request(app).get('/v1/meters/J999999').expect(404);
  assert.deepEqual(missing.body, { error: { code: 'not_found', message: 'Meter J999999 not found.' } });
});

test('energy needs both dates, a real date, from before to, and at most 31 days', async () => {
  const { app, portal } = setup();
  const issues = async (query) => (await request(app).get(`/v1/meters/J100001/energy${query}`).expect(400)).body.error.details;

  assert.deepEqual(await issues(''), [
    { param: 'from', issue: 'is required' },
    { param: 'to', issue: 'is required' },
  ]);
  assert.deepEqual(await issues('?from=2026-02-31&to=2026-03-01'), [{ param: 'from', issue: 'is not a real calendar date' }]);
  assert.deepEqual(await issues('?from=2026-06-10&to=2026-06-01'), [{ param: 'to', issue: 'must not be before from' }]);
  assert.deepEqual(await issues('?from=2026-06-01&to=2026-07-02'), [{ param: 'to', issue: 'range must be at most 31 days' }]);
  assert.equal(portal.calls.energy, 0); // bad requests never reach the portal
});

test('energy returns cleaned readings with deltas, and caches past days', async () => {
  const { app, portal } = setup();
  const url = '/v1/meters/J100001/energy?from=2026-06-01&to=2026-06-01';
  const res = await request(app).get(url).expect(200);

  assert.equal(res.body.data.intervalMinutes, 30);
  assert.deepEqual(res.body.data.readings[1], {
    timestamp: '2026-06-01T00:30:00+05:30',
    kwh: 100.5,
    kvah: 110.6,
    voltageR: 232,
    kwhDelta: 0.5,
    kvahDelta: 0.6,
  });
  assert.equal(res.body.data.readings[0].kwhDelta, null); // D10: the first reading has nothing to subtract from

  await request(app).get(url).expect(200);
  assert.equal(portal.calls.energy, 1);
});

test('energy for an unknown meter is a 404 without a portal call', async () => {
  const { app, portal } = setup();
  await request(app).get('/v1/meters/J999999/energy?from=2026-06-01&to=2026-06-01').expect(404);
  assert.equal(portal.calls.energy, 0);
});

test('GET /v1/transformers lists DTs with meter counts', async () => {
  const { app } = setup();
  const res = await request(app).get('/v1/transformers').expect(200);
  assert.deepEqual(
    res.body.data.map((t) => [t.code, t.meterCount]),
    [['DT-001', 3]],
  );
});

test('the dataset is loaded once and shared by every endpoint', async () => {
  const { app, portal } = setup();
  await request(app).get('/v1/meters').expect(200);
  await request(app).get('/v1/transformers').expect(200);
  await request(app).get('/v1/meters/J100001').expect(200);
  assert.deepEqual([portal.calls.dts, portal.calls.export], [1, 1]);
});

test('portal rate limit with no cached copy is a 503 with Retry-After', async () => {
  const { app } = setup({ failWith: new PortalError('rate_limited', 'limited', { retryAfterSeconds: 25 }) });
  const res = await request(app).get('/v1/meters').expect(503);
  assert.equal(res.headers['retry-after'], '25');
  assert.equal(res.body.error.code, 'upstream_unavailable');
});

test('portal timeout is a 504 and a broken portal response is a 502', async () => {
  const timeout = setup({ failWith: new PortalError('timeout', 'slow') });
  assert.equal((await request(timeout.app).get('/v1/meters').expect(504)).body.error.code, 'upstream_timeout');

  const broken = setup({ failWith: new PortalError('bad_response', 'html') });
  assert.equal((await request(broken.app).get('/v1/meters').expect(502)).body.error.code, 'upstream_error');
});

test('/health reports the cache without calling the portal', async () => {
  const { app, portal } = setup();
  const before = await request(app).get('/health').expect(200);
  assert.equal(before.body.status, 'degraded'); // nothing loaded yet
  assert.equal(portal.calls.export, 0);

  await request(app).get('/v1/meters').expect(200);
  const after = await request(app).get('/health').expect(200);
  assert.equal(after.body.status, 'ok');
  assert.equal(after.body.cache.meters.count, 3);
  assert.notEqual(after.body.portal.lastSuccessAt, null);
});

test('unknown routes get the same error shape; the spec is served', async () => {
  const { app } = setup();
  const res = await request(app).get('/v1/feeders').expect(404);
  assert.equal(res.body.error.code, 'not_found');

  const spec = await request(app).get('/openapi.json').expect(200);
  assert.equal(spec.body.openapi, '3.0.3');
});

test('/health: a portal failure makes it degraded; a 404 for one meter does not', async () => {
  const portal = fakePortal();
  portal.getEnergy = async () => {
    throw new PortalError('not_found', 'no such meter in the portal');
  };
  const service = createMeterService({ portal, now: () => Date.parse('2026-11-04T06:00:00Z') });
  const app = createApp({ service, openapi: {} });

  await request(app).get('/v1/meters/J100001/energy?from=2026-06-01&to=2026-06-01').expect(404);
  assert.equal((await request(app).get('/health').expect(200)).body.status, 'ok');

  portal.getEnergy = async () => {
    throw new PortalError('timeout', 'slow');
  };
  await request(app).get('/v1/meters/J100002/energy?from=2026-06-01&to=2026-06-01').expect(504);
  const health = (await request(app).get('/health').expect(200)).body;
  assert.equal(health.status, 'degraded');
  assert.equal(health.portal.lastError, 'timeout');
});
