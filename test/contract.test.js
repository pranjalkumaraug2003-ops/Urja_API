// Contract test: real responses from our API are validated against openapi.json, so the spec cannot
// silently drift from the code (D7). Uses the end-to-end setup: real app and client, fake portal server.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createApp } from '../src/app.js';
import { createMeterService } from '../src/service.js';
import { createPortalClient } from '../src/portal/client.js';
import { startFakePortal, FAKE_CREDENTIALS } from './support/fake-portal.js';
import { rawMeter, rawEnergy } from './support/fixtures.js';

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));

// OpenAPI 3.0 schemas are close to JSON Schema; ajv understands "nullable" and we let it ignore "example".
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec, 'spec');

// JSON pointer to the response schema for one operation and status.
function schemaFor(path, status) {
  const escaped = path.replaceAll('~', '~0').replaceAll('/', '~1');
  const response = spec.paths[path].get.responses[status];
  const pointer = response.$ref
    ? response.$ref.replace('#', 'spec#') + '/content/application~1json/schema'
    : `spec#/paths/${escaped}/get/responses/${status}/content/application~1json/schema`;
  return ajv.getSchema(pointer) ?? ajv.compile({ $ref: pointer });
}

function assertMatchesSpec(path, res) {
  const validate = schemaFor(path, String(res.status));
  const ok = validate(res.body);
  assert.ok(ok, `${path} ${res.status} does not match openapi.json: ${ajv.errorsText(validate.errors)}`);
}

let portal;
let app;

before(async () => {
  portal = await startFakePortal({
    meters: [
      rawMeter('J100001', 'DT-001', { dtName: 'DT 1' }),
      rawMeter('J100002', 'DT-001', { dtName: 'DT 1', installStatus: 'Faulty', geo: { lat: '', lng: '75.8' } }),
    ],
    dts: [{ code: 'DT-001', name: 'DT 1', feederCode: 'F-001', capacityKva: 100 }],
    energy: { J100001: rawEnergy({ fromDate: '2026-06-01', toDate: '2026-06-02' }) },
  });
  const client = createPortalClient({ baseUrl: portal.url, ...FAKE_CREDENTIALS, minIntervalMs: 0 });
  app = createApp({ service: createMeterService({ portal: client }), openapi: spec });
});
after(() => portal.close());

const cases = [
  ['/v1/meters', '/v1/meters', 200],
  ['/v1/meters', '/v1/meters?near=26.9,75.8&radiusKm=5', 200],
  ['/v1/meters', '/v1/meters?limit=abc', 400],
  ['/v1/meters/{meterId}', '/v1/meters/J100002', 200],
  ['/v1/meters/{meterId}', '/v1/meters/J999999', 404],
  ['/v1/meters/{meterId}/energy', '/v1/meters/J100001/energy?from=2026-06-01&to=2026-06-02', 200],
  ['/v1/meters/{meterId}/energy', '/v1/meters/J100001/energy?from=2026-06-01&to=2026-06-02&granularity=daily', 200],
  ['/v1/meters/{meterId}/energy', '/v1/meters/J100001/energy?from=2026-06-01&to=2026-06-01', 200],
  ['/v1/meters/{meterId}/energy', '/v1/meters/J100001/energy', 400],
  ['/v1/network', '/v1/network', 200],
  ['/v1/transformers', '/v1/transformers', 200],
  ['/health', '/health', 200],
];

for (const [specPath, url, status] of cases) {
  test(`${url} -> ${status} matches the spec`, async () => {
    const res = await request(app).get(url).expect(status);
    assertMatchesSpec(specPath, res);
  });
}

test('every path in the spec is covered by a contract case', () => {
  const covered = new Set(cases.map(([specPath]) => specPath));
  assert.deepEqual(Object.keys(spec.paths).filter((p) => !covered.has(p)), []);
});
