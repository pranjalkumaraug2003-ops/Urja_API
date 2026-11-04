import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnergy, parsePortalTimestamp, detectIntervalMinutes } from '../src/domain/energy.js';

// Raw rows shaped like /portal/meters/{id}/energy (PDF section 3): all strings.
const row = (timestamp, kwh, kvah = '100.00', voltR = '231.0') => ({ timestamp, kwh, kvah, voltR });

function energy(rawReadings) {
  return buildEnergy({ meterId: 'J100001', from: '2026-06-01', to: '2026-06-01', rawReadings });
}

test('parses DD/MM/YYYY HH:mm to ISO 8601 with the IST offset', () => {
  assert.equal(parsePortalTimestamp('23/06/2026 23:30'), '2026-06-23T23:30:00+05:30');
  assert.equal(parsePortalTimestamp('31/02/2026 00:00'), null); // no 31 February
  assert.equal(parsePortalTimestamp('2026-06-23 23:30'), null);
  assert.equal(parsePortalTimestamp(''), null);
});

test('detects the interval as the most common gap', () => {
  const t = (h, m) => Date.UTC(2026, 5, 1, h, m);
  assert.equal(detectIntervalMinutes([t(0, 0), t(0, 30), t(1, 0), t(2, 0)]), 30);
  assert.equal(detectIntervalMinutes([Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 2), Date.UTC(2026, 5, 3)]), 1440);
  assert.equal(detectIntervalMinutes([t(0, 0)]), null);
});

test('converts strings to numbers and computes rounded deltas; first delta is null', () => {
  const result = energy([
    row('01/06/2026 00:00', '42594.12', '45120.50'),
    row('01/06/2026 00:30', '42594.61', '45121.02'),
  ]);

  assert.equal(result.intervalMinutes, 30);
  assert.deepEqual(result.readings, [
    { timestamp: '2026-06-01T00:00:00+05:30', kwh: 42594.12, kvah: 45120.5, voltageR: 231, kwhDelta: null, kvahDelta: null },
    { timestamp: '2026-06-01T00:30:00+05:30', kwh: 42594.61, kvah: 45121.02, voltageR: 231, kwhDelta: 0.49, kvahDelta: 0.52 },
  ]);
  assert.deepEqual(result.dataQuality, []);
});

test('drops the incomplete duplicate row and keeps the complete one', () => {
  // The portal quirk: a second row at the same time with kwh and voltR blank.
  const result = energy([
    row('29/06/2026 00:00', '500.00'),
    row('30/06/2026 00:00', '510.00', '120.00', '230.0'),
    row('30/06/2026 00:00', '', '120.00', ''),
  ]);

  assert.equal(result.readings.length, 2);
  assert.equal(result.readings[1].kwh, 510);
  assert.equal(result.readings[1].kwhDelta, 10);
  assert.deepEqual(result.dataQuality, [
    { timestamp: '2026-06-30T00:00:00+05:30', issue: 'duplicate_incomplete_row', action: 'dropped' },
  ]);
});

test('flags a gap and a negative delta', () => {
  const result = energy([
    row('01/06/2026 00:00', '100.00'),
    row('01/06/2026 00:30', '101.00'),
    row('01/06/2026 01:00', '102.00'),
    row('01/06/2026 02:00', '104.00'), // one reading missing before this one
    row('01/06/2026 02:30', '50.00'), // register went backwards
  ]);

  assert.equal(result.readings[3].kwhDelta, 2); // spans the gap
  assert.equal(result.readings[4].kwhDelta, null);
  assert.deepEqual(
    result.dataQuality.map((q) => `${q.timestamp.slice(11, 16)} ${q.issue}`),
    ['02:00 gap_before', '02:30 negative_delta'],
  );
});

test('sorts readings by time and flags blank values in kept rows', () => {
  const result = energy([row('01/06/2026 00:30', '101.00', '100.00', ''), row('01/06/2026 00:00', '100.00')]);

  assert.deepEqual(result.readings.map((r) => r.timestamp.slice(11, 16)), ['00:00', '00:30']);
  assert.deepEqual(result.dataQuality, [
    { timestamp: '2026-06-01T00:30:00+05:30', field: 'voltageR', issue: 'blank_in_source', action: 'left_null' },
  ]);
});

test('drops rows with an unreadable timestamp and records the source value', () => {
  const result = energy([row('garbage', '1.00')]);
  assert.deepEqual(result.readings, []);
  assert.equal(result.dataQuality[0].sourceValue, 'garbage');
});

test('an empty window gives no readings and a null interval', () => {
  const result = energy([]);
  assert.deepEqual(result.readings, []);
  assert.equal(result.intervalMinutes, null);
  assert.deepEqual(result.units, { kwh: 'kWh', kvah: 'kVAh', voltageR: 'V', kwhDelta: 'kWh', kvahDelta: 'kVAh' });
});
