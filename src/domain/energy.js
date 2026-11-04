// Turns raw portal energy rows into clean readings with per-interval usage (D3, D4). Pure functions: no I/O.

import { cleanString, toNumber } from './values.js';

// The portal's timestamps have no timezone; the utility is in Jaipur, so we assume IST (documented).
export const IST_OFFSET = '+05:30';

export const ENERGY_UNITS = Object.freeze({
  kwh: 'kWh',
  kvah: 'kVAh',
  voltageR: 'V',
  kwhDelta: 'kWh',
  kvahDelta: 'kVAh',
});

// Our field name -> the portal's field name.
const SOURCE_FIELDS = { kwh: 'kwh', kvah: 'kvah', voltageR: 'voltR' };

// Deltas are rounded to remove floating point noise (42594.61 - 42594.12 = 0.48999999999796).
const DELTA_DECIMALS = 3;

const PORTAL_TIMESTAMP = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;

// "23/06/2026 23:30" -> "2026-06-23T23:30:00+05:30". Returns null for anything malformed or impossible.
export function parsePortalTimestamp(value) {
  const match = PORTAL_TIMESTAMP.exec(cleanString(value) ?? '');
  if (!match) return null;
  const [, dd, mm, yyyy, hh, min] = match;
  const [day, month, year, hour, minute] = [dd, mm, yyyy, hh, min].map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59) return null;
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:00${IST_OFFSET}`;
}

// Most common gap between consecutive readings, in minutes; ties go to the smaller gap. Null if under 2 readings.
export function detectIntervalMinutes(times) {
  const counts = new Map();
  for (let i = 1; i < times.length; i++) {
    const gap = Math.round((times[i] - times[i - 1]) / 60_000);
    counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [gap, count] of counts) {
    if (count > bestCount || (count === bestCount && gap < best)) {
      best = gap;
      bestCount = count;
    }
  }
  return best;
}

function countValues(row) {
  return ['kwh', 'kvah', 'voltageR'].filter((field) => row[field] !== null).length;
}

function roundDelta(value) {
  const factor = 10 ** DELTA_DECIMALS;
  return Math.round(value * factor) / factor;
}

// Usage between two register readings. Null if either is missing or the register went backwards (D4 rule 3).
function delta(previous, current, field, timestamp, dataQuality) {
  if (previous === null || current === null) return null;
  const difference = current - previous;
  if (difference < 0) {
    dataQuality.push({ timestamp, field, issue: 'negative_delta', action: 'delta_set_null' });
    return null;
  }
  return roundDelta(difference);
}

export function buildEnergy({ meterId, from, to, rawReadings }) {
  const dataQuality = [];

  // 1. Parse each row; a row without a usable timestamp cannot be placed in time, so it is dropped.
  const parsed = [];
  for (const raw of rawReadings) {
    const timestamp = parsePortalTimestamp(raw?.timestamp);
    if (timestamp === null) {
      dataQuality.push({ field: 'timestamp', issue: 'invalid_timestamp', action: 'dropped', sourceValue: String(raw?.timestamp ?? '') });
      continue;
    }
    parsed.push({
      raw,
      timestamp,
      time: Date.parse(timestamp),
      kwh: toNumber(raw.kwh),
      kvah: toNumber(raw.kvah),
      voltageR: toNumber(raw.voltR),
    });
  }

  // 2. One row per timestamp (D3 rule 6): keep the more complete row; on a tie keep the first.
  const byTime = new Map();
  for (const row of parsed) {
    const kept = byTime.get(row.time);
    if (!kept) {
      byTime.set(row.time, row);
      continue;
    }
    const keepNew = countValues(row) > countValues(kept);
    if (keepNew) byTime.set(row.time, row);
    const issue = countValues(row) === countValues(kept) ? 'duplicate_row' : 'duplicate_incomplete_row';
    dataQuality.push({ timestamp: row.timestamp, issue, action: 'dropped' });
  }
  const rows = [...byTime.values()].sort((a, b) => a.time - b.time);

  // 3. Record values that are still missing or unreadable in the rows we keep.
  for (const row of rows) {
    for (const [field, sourceField] of Object.entries(SOURCE_FIELDS)) {
      if (row[field] !== null) continue;
      const issue = cleanString(row.raw[sourceField]) === null ? 'blank_in_source' : 'not_a_number';
      dataQuality.push({ timestamp: row.timestamp, field, issue, action: 'left_null' });
    }
  }

  // 4. Interval from the data itself, never from meter ID ranges (D4).
  const intervalMinutes = detectIntervalMinutes(rows.map((r) => r.time));

  // 5. Delta = usage during the interval ending at this timestamp. voltageR is a point value, never differenced.
  const readings = rows.map((row, i) => {
    const previous = rows[i - 1];
    const reading = {
      timestamp: row.timestamp,
      kwh: row.kwh,
      kvah: row.kvah,
      voltageR: row.voltageR,
      kwhDelta: null,
      kvahDelta: null,
    };
    if (!previous) return reading; // first row in the window: no earlier reading (D4 rule 1)

    const gapMinutes = (row.time - previous.time) / 60_000;
    if (intervalMinutes !== null && gapMinutes > intervalMinutes) {
      dataQuality.push({ timestamp: row.timestamp, issue: 'gap_before', action: 'delta_spans_gap' });
    }
    reading.kwhDelta = delta(previous.kwh, row.kwh, 'kwhDelta', row.timestamp, dataQuality);
    reading.kvahDelta = delta(previous.kvah, row.kvah, 'kvahDelta', row.timestamp, dataQuality);
    return reading;
  });

  // Same offset everywhere, so ISO strings sort correctly as text. Sort is stable, so order within a timestamp is kept.
  dataQuality.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));

  return { meterId, from, to, intervalMinutes, units: { ...ENERGY_UNITS }, readings, dataQuality };
}
