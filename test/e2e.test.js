// End to end: our API (real app, service, cache, portal client over real HTTP) against a fake portal server
// that follows the real portal's protocol and quirks. No request reaches the live portal.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createMeterService } from '../src/service.js';
import { createPortalClient } from '../src/portal/client.js';
import { startFakePortal, FAKE_CREDENTIALS } from './support/fake-portal.js';
import { rawMeter, rawEnergy } from './support/fixtures.js';

const DTS = [
  { code: 'DT-001', name: 'Malviya Nagar DT 1', feederCode: 'F-001', capacityKva: 100 },
  { code: 'DT-007', name: 'Sanganer DT 7', feederCode: 'F-007', capacityKva: 250 },
];

// Quirks from the real data: a blank circle code (J100011), a renamed DT (J100400), a corrupt duplicate row (J100089).
const CHAIN_7 = ['Z-02', 'C-03', 'D-01', 'SD-04', 'SS-05', 'F-007'];
const dt1 = { dtName: 'Malviya Nagar DT 1' };
const dt7 = { chain: CHAIN_7, dtName: 'Sanganer DT 7' };
const blankCircle = rawMeter('J100011', 'DT-001', dt1);
blankCircle.hierarchy.circle.code = '';
const METERS = [
  rawMeter('J100001', 'DT-001', dt1),
  blankCircle,
  rawMeter('J100089', 'DT-007', { ...dt7, installStatus: 'Faulty', geo: { lat: 26.85, lng: 75.79 } }),
  rawMeter('J100400', 'DT-007', { ...dt7, dtName: 'Old Malviya Nagar Xfmr', make: 'Genus', geo: { lat: 26.851, lng: 75.791 } }),
];

const dailyRows = rawEnergy({ fromDate: '2026-06-01', toDate: '2026-06-30', intervalMinutes: 1440, stepKwh: 6 });
const ENERGY = {
  J100001: rawEnergy({ fromDate: '2026-06-01', toDate: '2026-06-30', intervalMinutes: 30, stepKwh: 0.25 }),
  // The corrupt duplicate: a second 30/06 00:00 row with blank kwh and voltR.
  J100089: [...dailyRows, { timestamp: '30/06/2026 00:00', kwh: '', kvah: dailyRows.at(-1).kvah, voltR: '' }],
};

let portal;
let app;

before(async () => {
  portal = await startFakePortal({ meters: METERS, dts: DTS, energy: ENERGY });
  const client = createPortalClient({ baseUrl: portal.url, ...FAKE_CREDENTIALS, minIntervalMs: 0, timeoutMs: 2000 });
  app = createApp({ service: createMeterService({ portal: client }), openapi: { openapi: '3.0.3' } });
});
after(() => portal.close());

test('logs in, signs the export and serves cleaned meters', async () => {
  const res = await request(app).get('/v1/meters').expect(200);
  assert.equal(res.body.meta.total, 4);
  assert.equal(portal.stats.logins, 1);

  const repaired = res.body.data.find((m) => m.meterId === 'J100011');
  assert.equal(repaired.hierarchy.circle.code, 'C-01');
  assert.equal(repaired.dataQuality[0].action, 'filled_from_dt_siblings');
});

test('transformers carry the official DT name and the alias', async () => {
  const res = await request(app).get('/v1/transformers').expect(200);
  const dt7 = res.body.data.find((t) => t.code === 'DT-007');
  assert.equal(dt7.name, 'Sanganer DT 7');
  assert.deepEqual(dt7.aliases, ['Old Malviya Nagar Xfmr']);
});

test('network tree and the near-me query come from the same cached data', async () => {
  const before = portal.stats.portalRequests;
  const network = await request(app).get('/v1/network').expect(200);
  assert.deepEqual(network.body.data.tree.map((z) => z.path), ['Z-01', 'Z-02']);

  const near = await request(app).get('/v1/meters?near=26.85,75.79&radiusKm=1').expect(200);
  assert.deepEqual(near.body.data.map((m) => m.meterId), ['J100089', 'J100400']);
  assert.equal(portal.stats.portalRequests, before); // no new portal calls
});

test('half-hourly energy: readings with deltas, then the daily roll-up from the cache', async () => {
  const raw = await request(app).get('/v1/meters/J100001/energy?from=2026-06-01&to=2026-06-02').expect(200);
  assert.equal(raw.body.data.intervalMinutes, 30);
  assert.equal(raw.body.data.readings.length, 96);
  assert.equal(raw.body.data.readings[1].kwhDelta, 0.25);

  const calls = portal.stats.portalRequests;
  const daily = await request(app).get('/v1/meters/J100001/energy?from=2026-06-01&to=2026-06-02&granularity=daily').expect(200);
  assert.deepEqual(daily.body.data.days.map((d) => [d.date, d.kwh, d.complete]), [['2026-06-01', 12, true], ['2026-06-02', 11.75, false]]);
  assert.equal(portal.stats.portalRequests, calls); // served from the cached raw window
});

test('daily meter: the corrupt duplicate row is dropped and flagged', async () => {
  const res = await request(app).get('/v1/meters/j100089/energy?from=2026-06-25&to=2026-06-30').expect(200);
  assert.equal(res.body.data.intervalMinutes, 1440);
  assert.equal(res.body.data.readings.length, 6);
  assert.deepEqual(res.body.data.dataQuality, [{ timestamp: '2026-06-30T00:00:00+05:30', issue: 'duplicate_incomplete_row', action: 'dropped' }]);
});

test('health is ok after real loads', async () => {
  const res = await request(app).get('/health').expect(200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.cache.meters.count, 4);
});

test('wrong credentials surface as 503 upstream_unavailable', async () => {
  const other = await startFakePortal({ meters: METERS, dts: DTS });
  try {
    const client = createPortalClient({ baseUrl: other.url, email: 'x@y', password: 'nope', minIntervalMs: 0 });
    const badApp = createApp({ service: createMeterService({ portal: client }), openapi: {} });
    const res = await request(badApp).get('/v1/meters').expect(503);
    assert.equal(res.body.error.code, 'upstream_unavailable');
  } finally {
    await other.close();
  }
});

test('a portal 429 becomes 503 with Retry-After, and the client then stops calling', async () => {
  const limited = await startFakePortal({ meters: METERS, dts: DTS, rateLimitAfter: 0 });
  try {
    const client = createPortalClient({ baseUrl: limited.url, ...FAKE_CREDENTIALS, minIntervalMs: 0 });
    const limitedApp = createApp({ service: createMeterService({ portal: client }), openapi: {} });

    const first = await request(limitedApp).get('/v1/meters').expect(503);
    assert.equal(first.headers['retry-after'], '30');
    const callsAfterFirst = limited.stats.portalRequests;

    await request(limitedApp).get('/v1/meters').expect(503);
    assert.equal(limited.stats.portalRequests, callsAfterFirst); // cooldown: no new request reached the portal
  } finally {
    await limited.close();
  }
});
