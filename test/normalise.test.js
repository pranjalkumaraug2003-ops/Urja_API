import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataset } from '../src/domain/normalise.js';

// A raw export record shaped like the portal's (PDF section 3). Override any part per test.
function rawMeter(meterId, dtCode, overrides = {}) {
  const node = (name, code) => ({ name, code });
  return {
    meterId,
    serialNo: `SE${meterId.slice(1)}`,
    make: 'HPL',
    phaseType: 'single',
    installStatus: 'Installed',
    installType: 'CT Operated',
    build: 'legacy',
    dtCode,
    hierarchy: {
      zone: node('Jaipur Zone 1', 'Z-01'),
      circle: node('Circle 6', 'C-06'),
      division: node('Division 1', 'D-01'),
      subdivision: node('Subdivision 1', 'SD-01'),
      substation: node('Substation 1', 'SS-01'),
      feeder: node('Feeder 1', 'F-001'),
      dt: node(`DT ${dtCode}`, dtCode),
      ...overrides.hierarchy,
    },
    geo: { lat: 26.9389, lng: 75.8309 },
    ...overrides.top,
  };
}

const DTS = [
  { code: 'DT-001', name: 'DT DT-001', feederCode: 'F-001', capacityKva: 100 },
  { code: 'DT-007', name: 'Sanganer DT 7', feederCode: 'F-001', capacityKva: 250 },
];

test('cleans fields, maps enums to snake case and builds the path', () => {
  const { meters } = buildDataset([rawMeter('j100001', 'DT-001')], DTS);
  const [m] = meters;

  assert.equal(m.meterId, 'J100001');
  assert.equal(m.installStatus, 'installed');
  assert.equal(m.installType, 'ct_operated');
  assert.equal(m.hierarchy.path, 'Z-01/C-06/D-01/SD-01/SS-01/F-001/DT-001');
  assert.deepEqual(m.location, { lat: 26.9389, lng: 75.8309 });
  assert.deepEqual(m.dataQuality, []);
  assert.equal('dtCode' in m, false);
});

test('fills a blank code from meters on the same DT and flags it', () => {
  const blank = rawMeter('J100011', 'DT-001', { hierarchy: { circle: { name: 'Circle 6', code: '' } } });
  const { meters } = buildDataset([rawMeter('J100010', 'DT-001'), blank, rawMeter('J100012', 'DT-001')], DTS);
  const repaired = meters.find((m) => m.meterId === 'J100011');

  assert.equal(repaired.hierarchy.circle.code, 'C-06');
  assert.deepEqual(repaired.dataQuality, [
    { field: 'hierarchy.circle.code', issue: 'blank_in_source', action: 'filled_from_dt_siblings' },
  ]);
});

test('leaves a blank null and marks the path when no sibling can fill it', () => {
  const alone = rawMeter('J100020', 'DT-099', { hierarchy: { feeder: { name: '', code: '' } } });
  const [m] = buildDataset([alone], DTS).meters;

  assert.equal(m.hierarchy.feeder.code, null);
  assert.equal(m.hierarchy.path, 'Z-01/C-06/D-01/SD-01/SS-01/unknown/DT-099');
  assert.deepEqual(
    m.dataQuality.map((q) => `${q.field}:${q.action}`),
    ['hierarchy.feeder.code:left_null', 'hierarchy.feeder.name:left_null'],
  );
});

test('uses the official DT name and records the conflicting one as an alias', () => {
  const renamed = rawMeter('J100400', 'DT-007', { hierarchy: { dt: { name: 'Old Malviya Nagar Xfmr', code: 'DT-007' } } });
  const normal = rawMeter('J100060', 'DT-007', { hierarchy: { dt: { name: 'Sanganer DT 7', code: 'DT-007' } } });
  const { meters, transformers } = buildDataset([renamed, normal], DTS);

  const fixed = meters.find((m) => m.meterId === 'J100400');
  assert.equal(fixed.hierarchy.dt.name, 'Sanganer DT 7');
  assert.equal(fixed.dataQuality[0].sourceValue, 'Old Malviya Nagar Xfmr');

  const dt7 = transformers.find((t) => t.code === 'DT-007');
  assert.deepEqual(dt7.aliases, ['Old Malviya Nagar Xfmr']);
  assert.equal(dt7.meterCount, 2);
  assert.equal(dt7.dataQuality[0].action, 'portal_dts_name_kept_alias_recorded');
});

test('builds transformers from /portal/dts with counts and path, sorted by code', () => {
  const { transformers } = buildDataset([rawMeter('J100001', 'DT-001'), rawMeter('J100002', 'DT-001')], [...DTS].reverse());

  assert.deepEqual(
    transformers.map((t) => [t.code, t.meterCount, t.capacityKva]),
    [
      ['DT-001', 2, 100],
      ['DT-007', 0, 250],
    ],
  );
  assert.equal(transformers[0].path, 'Z-01/C-06/D-01/SD-01/SS-01/F-001/DT-001');
  assert.equal(transformers[1].path, null);
});

test('converts string coordinates and flags unreadable ones', () => {
  const m = rawMeter('J100030', 'DT-001', { top: { geo: { lat: '26.5', lng: 'abc' } } });
  const [meter] = buildDataset([m], DTS).meters;

  assert.deepEqual(meter.location, { lat: 26.5, lng: null });
  assert.deepEqual(meter.dataQuality, [{ field: 'location.lng', issue: 'not_a_number', action: 'left_null' }]);
});

test('returns meters sorted by meterId', () => {
  const { meters } = buildDataset([rawMeter('J100003', 'DT-001'), rawMeter('J100001', 'DT-001')], DTS);
  assert.deepEqual(meters.map((m) => m.meterId), ['J100001', 'J100003']);
});
