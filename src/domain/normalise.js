// Turns raw portal records (signed export + /portal/dts) into clean meters and transformers (D3, D5, D8).
// Every content repair is recorded in the record's dataQuality list. Pure functions: no I/O.

import { cleanString, toNumber, toEnum, groupBy, mostCommon } from './values.js';

// Network levels from top to bottom. The order defines the path.
export const LEVELS = ['zone', 'circle', 'division', 'subdivision', 'substation', 'feeder', 'dt'];

// Path segment used when a code could not be repaired (D8).
const UNKNOWN_SEGMENT = 'unknown';

function cleanHierarchy(rawHierarchy) {
  const hierarchy = {};
  for (const level of LEVELS) {
    hierarchy[level] = {
      code: cleanString(rawHierarchy?.[level]?.code),
      name: cleanString(rawHierarchy?.[level]?.name),
    };
  }
  return hierarchy;
}

function cleanLocation(rawGeo, dataQuality) {
  const location = {};
  for (const axis of ['lat', 'lng']) {
    const raw = rawGeo?.[axis];
    location[axis] = toNumber(raw);
    if (location[axis] === null) {
      const issue = cleanString(raw) === null ? 'blank_in_source' : 'not_a_number';
      dataQuality.push({ field: `location.${axis}`, issue, action: 'left_null' });
    }
  }
  return location;
}

// Pass 1: clean one export record on its own (types, blanks, enums, field names).
function cleanMeter(raw) {
  const dataQuality = [];
  const hierarchy = cleanHierarchy(raw.hierarchy);

  // The DT code anchors all repairs below, so fall back to the record's top-level dtCode.
  const dtCode = cleanString(raw.dtCode);
  if (hierarchy.dt.code === null && dtCode !== null) {
    hierarchy.dt.code = dtCode;
    dataQuality.push({ field: 'hierarchy.dt.code', issue: 'blank_in_source', action: 'filled_from_dt_code' });
  }

  return {
    meterId: cleanString(raw.meterId)?.toUpperCase() ?? null,
    serialNo: cleanString(raw.serialNo),
    make: cleanString(raw.make),
    phaseType: toEnum(raw.phaseType),
    installStatus: toEnum(raw.installStatus),
    installType: toEnum(raw.installType),
    build: toEnum(raw.build),
    location: cleanLocation(raw.geo, dataQuality),
    hierarchy,
    dataQuality,
  };
}

// Pass 2 (D3 rule 5): the /portal/dts name is official. Returns the other names seen, per DT code.
function applyOfficialDtNames(meters, officialNames) {
  const aliases = new Map();
  for (const meter of meters) {
    const dt = meter.hierarchy.dt;
    const official = dt.code === null ? null : officialNames.get(dt.code) ?? null;
    if (official === null) continue;

    if (dt.name === null) {
      meter.dataQuality.push({ field: 'hierarchy.dt.name', issue: 'blank_in_source', action: 'filled_from_portal_dts' });
    } else if (dt.name !== official) {
      meter.dataQuality.push({
        field: 'hierarchy.dt.name',
        issue: 'conflicting_name_in_source',
        action: 'replaced_with_portal_dts_name',
        sourceValue: dt.name,
      });
      if (!aliases.has(dt.code)) aliases.set(dt.code, new Set());
      aliases.get(dt.code).add(dt.name);
    }
    dt.name = official;
  }
  return aliases;
}

// Pass 3 (D3 rule 4): fill blank codes and names from other meters on the same DT.
function fillFromDtSiblings(meters) {
  for (const [dtCode, siblings] of groupBy(meters, (m) => m.hierarchy.dt.code)) {
    for (const level of LEVELS) {
      for (const key of ['code', 'name']) {
        const fill = dtCode === null ? null : mostCommon(siblings.map((m) => m.hierarchy[level][key]));
        for (const meter of siblings) {
          if (meter.hierarchy[level][key] !== null) continue;
          const field = `hierarchy.${level}.${key}`;
          if (fill !== null) {
            meter.hierarchy[level][key] = fill;
            meter.dataQuality.push({ field, issue: 'blank_in_source', action: 'filled_from_dt_siblings' });
          } else {
            meter.dataQuality.push({ field, issue: 'blank_in_source', action: 'left_null' });
          }
        }
      }
    }
  }
}

// Pass 4 (D5): the path of codes identifies a node, because codes repeat under different parents.
function addPath(meter) {
  const path = LEVELS.map((level) => meter.hierarchy[level].code ?? UNKNOWN_SEGMENT).join('/');
  meter.hierarchy = { path, ...meter.hierarchy };
}

function buildTransformers(rawDts, meters, aliasesByDt) {
  const metersByDt = groupBy(meters, (m) => m.hierarchy.dt.code);
  return rawDts
    .map((raw) => {
      const code = cleanString(raw.code);
      const onThisDt = metersByDt.get(code) ?? [];
      const aliases = [...(aliasesByDt.get(code) ?? [])].sort();
      return {
        code,
        name: cleanString(raw.name),
        aliases,
        feederCode: cleanString(raw.feederCode),
        capacityKva: toNumber(raw.capacityKva),
        path: mostCommon(onThisDt.map((m) => m.hierarchy.path)),
        meterCount: onThisDt.length,
        dataQuality: aliases.map((alias) => ({
          field: 'name',
          issue: 'conflicting_name_in_source',
          action: 'portal_dts_name_kept_alias_recorded',
          sourceValue: alias,
        })),
      };
    })
    .sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
}

// Entry point: raw export records + raw DT rows -> { meters, transformers }.
export function buildDataset(rawMeters, rawDts) {
  const officialNames = new Map(rawDts.map((dt) => [cleanString(dt.code), cleanString(dt.name)]));

  const meters = rawMeters.map(cleanMeter).sort((a, b) => (a.meterId ?? '').localeCompare(b.meterId ?? ''));
  const aliasesByDt = applyOfficialDtNames(meters, officialNames);
  fillFromDtSiblings(meters);
  meters.forEach(addPath);

  return { meters, transformers: buildTransformers(rawDts, meters, aliasesByDt) };
}
