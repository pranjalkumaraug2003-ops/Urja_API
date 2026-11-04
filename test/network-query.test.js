import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataset } from '../src/domain/normalise.js';
import { buildNetwork } from '../src/domain/network.js';
import { queryMeters, haversineKm } from '../src/domain/query.js';
import { buildEnergy, rollUpDaily } from '../src/domain/energy.js';
import { rawMeter, rawEnergy } from './support/fixtures.js';

const DTS = [
  { code: 'DT-001', name: 'DT DT-001', feederCode: 'F-001', capacityKva: 100 },
  { code: 'DT-002', name: 'DT DT-002', feederCode: 'F-001', capacityKva: 100 },
];

// D-01 appears under two circles, like the real data: the tree must keep them apart.
const RAW = [
  rawMeter('J100001', 'DT-001'),
  rawMeter('J100002', 'DT-001', { installStatus: 'Faulty' }),
  rawMeter('J100003', 'DT-002', { chain: ['Z-01', 'C-02', 'D-01', 'SD-02', 'SS-02', 'F-002'], make: 'Genus', geo: { lat: 26.95, lng: 75.85 } }),
];
const { meters } = buildDataset(RAW, DTS);

test('network: nodes are keyed by path, so a repeated code stays two nodes', () => {
  const { tree, summary } = buildNetwork(meters);
  const zone = tree[0];

  assert.equal(zone.path, 'Z-01');
  assert.deepEqual(zone.counts, { meters: 3, byStatus: { installed: 2, faulty: 1 } });
  assert.deepEqual(zone.children.map((c) => c.path), ['Z-01/C-01', 'Z-01/C-02']);
  assert.deepEqual(zone.children.map((c) => c.children[0].path), ['Z-01/C-01/D-01', 'Z-01/C-02/D-01']);

  assert.equal(summary.nodeCounts.division, 2);
  assert.equal(summary.codesUnderMultipleParents, 1); // D-01
});

test('network: DT leaves list their meters and carry a name', () => {
  const { tree } = buildNetwork(meters);
  let dt = tree[0];
  while (dt.children.length) dt = dt.children[0];

  assert.equal(dt.level, 'dt');
  assert.equal(dt.name, 'DT DT-001');
  assert.deepEqual(dt.meterIds, ['J100001', 'J100002']);
});

test('query: filters combine, enums accept lists, make is case-insensitive', () => {
  const ids = (filters) => queryMeters(meters, filters).map((m) => m.meterId);

  assert.deepEqual(ids({ installStatus: ['faulty'] }), ['J100002']);
  assert.deepEqual(ids({ installStatus: ['installed', 'faulty'], make: 'hpl' }), ['J100001', 'J100002']);
  assert.deepEqual(ids({ dt: 'DT-002' }), ['J100003']);
  assert.deepEqual(ids({ q: '0003' }), ['J100003']);
});

test('query: path matches a node and everything under it, but not a sibling with the same code', () => {
  const ids = (path) => queryMeters(meters, { path }).map((m) => m.meterId);
  assert.deepEqual(ids('Z-01/C-01/D-01'), ['J100001', 'J100002']);
  assert.deepEqual(ids('z-01/c-02'), ['J100003']);
  assert.deepEqual(ids('Z-01/C-0'), []); // a prefix of a code is not a parent
});

test('query: near returns meters within the radius, nearest first, with distanceKm', () => {
  const result = queryMeters(meters, { near: { lat: 26.95, lng: 75.85 }, radiusKm: 10 });
  assert.equal(result[0].meterId, 'J100003');
  assert.equal(result[0].distanceKm, 0);
  assert.ok(result[1].distanceKm > 5 && result[1].distanceKm < 10);

  assert.deepEqual(queryMeters(meters, { near: { lat: 26.95, lng: 75.85 }, radiusKm: 1 }).map((m) => m.meterId), ['J100003']);
});

test('haversine: one degree of latitude is about 111 km', () => {
  assert.ok(Math.abs(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111.19) < 0.05);
});

test('daily roll-up: each interval counts for the day it started; the last day is incomplete', () => {
  const energy = buildEnergy({
    meterId: 'J100001',
    from: '2026-06-01',
    to: '2026-06-03',
    rawReadings: rawEnergy({ fromDate: '2026-06-01', toDate: '2026-06-03', intervalMinutes: 30, stepKwh: 0.5 }),
  });
  const { days, granularity } = rollUpDaily(energy);

  assert.equal(granularity, 'daily');
  // The null first delta (D10) belongs to 31 May 23:30, outside the window, so day 1 is complete.
  // Day 3 misses its last interval, which ends at 04/06 00:00, after the window.
  assert.deepEqual(
    days.map((d) => [d.date, d.kwh, d.intervals, d.complete]),
    [
      ['2026-06-01', 24, 48, true],
      ['2026-06-02', 24, 48, true],
      ['2026-06-03', 23.5, 47, false],
    ],
  );
});

test('daily roll-up for a daily meter: the 02/06 reading is 1 June usage', () => {
  const energy = buildEnergy({
    meterId: 'J100100',
    from: '2026-06-01',
    to: '2026-06-03',
    rawReadings: rawEnergy({ fromDate: '2026-06-01', toDate: '2026-06-03', intervalMinutes: 1440, stepKwh: 7 }),
  });
  assert.deepEqual(
    rollUpDaily(energy).days.map((d) => [d.date, d.kwh, d.complete]),
    [
      ['2026-06-01', 7, true],
      ['2026-06-02', 7, true],
    ],
  );
});
