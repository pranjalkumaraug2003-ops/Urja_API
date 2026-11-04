// Local query layer over the cached meters: filters and "near me" (build stage 4). Pure functions.
// Scale note: a linear scan is fine for thousands of meters (403 here); past roughly 100k, move the data
// to a database with indexes and a spatial index (e.g. PostGIS) instead of filtering in memory.

const EARTH_RADIUS_KM = 6371;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

// Great-circle distance between two points on the Earth (haversine formula), in km.
export function haversineKm(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// A meter is under a path when its own path equals it or continues it ("Z-01/C-01" matches "Z-01/C-01/D-01/...").
// Case-insensitive, so "z-01/c-01" works too.
function isUnderPath(meter, path) {
  const own = meter.hierarchy.path.toLowerCase();
  const wanted = path.toLowerCase();
  return own === wanted || own.startsWith(`${wanted}/`);
}

// filters: { installStatus?, phaseType?, installType?, build? (arrays of allowed values), make?, dt?, path?, q?, near?, radiusKm? }
// Returns the matching meters; with "near", each result is a copy with distanceKm, sorted nearest first.
export function queryMeters(meters, filters) {
  const make = filters.make?.toLowerCase();
  const q = filters.q?.toLowerCase();

  let result = meters.filter(
    (m) =>
      (!filters.installStatus || filters.installStatus.includes(m.installStatus)) &&
      (!filters.phaseType || filters.phaseType.includes(m.phaseType)) &&
      (!filters.installType || filters.installType.includes(m.installType)) &&
      (!filters.build || filters.build.includes(m.build)) &&
      (!make || m.make?.toLowerCase() === make) &&
      (!filters.dt || m.hierarchy.dt.code === filters.dt) &&
      (!filters.path || isUnderPath(m, filters.path)) &&
      (!q || m.meterId.toLowerCase().includes(q) || (m.serialNo ?? '').toLowerCase().includes(q)),
  );

  if (filters.near) {
    result = result
      .filter((m) => m.location.lat !== null && m.location.lng !== null)
      .map((m) => ({ ...m, distanceKm: Math.round(haversineKm(filters.near, m.location) * 1000) / 1000 }))
      .filter((m) => m.distanceKm <= filters.radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm || a.meterId.localeCompare(b.meterId));
  }
  return result;
}
