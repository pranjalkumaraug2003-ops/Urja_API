// Shared test data shaped like the portal's raw responses (PDF section 3).

export const node = (name, code) => ({ name, code });

// An export record. `chain` = codes from zone to feeder; names are derived from the codes.
export function rawMeter(meterId, dtCode, { chain = ['Z-01', 'C-01', 'D-01', 'SD-01', 'SS-01', 'F-001'], dtName = `DT ${dtCode}`, ...overrides } = {}) {
  const [zone, circle, division, subdivision, substation, feeder] = chain;
  return {
    meterId,
    serialNo: `SE${meterId.slice(1)}`,
    make: 'HPL',
    phaseType: 'single',
    installStatus: 'Installed',
    installType: 'Whole Current',
    build: 'legacy',
    dtCode,
    hierarchy: {
      zone: node(`Zone ${zone}`, zone),
      circle: node(`Circle ${circle}`, circle),
      division: node(`Division ${division}`, division),
      subdivision: node(`Subdivision ${subdivision}`, subdivision),
      substation: node(`Substation ${substation}`, substation),
      feeder: node(`Feeder ${feeder}`, feeder),
      dt: node(dtName, dtCode),
    },
    geo: { lat: 26.9, lng: 75.8 },
    ...overrides,
  };
}

// Raw energy rows for one meter: cumulative registers every `intervalMinutes` from `fromDate` 00:00
// up to and including `toDate` (the last reading of that day), as the portal returns them (all strings).
export function rawEnergy({ fromDate, toDate, intervalMinutes = 30, startKwh = 1000, stepKwh = 0.5 }) {
  const rows = [];
  const end = Date.parse(`${toDate}T23:59:59Z`);
  let kwh = startKwh;
  for (let t = Date.parse(`${fromDate}T00:00:00Z`); t <= end; t += intervalMinutes * 60_000) {
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    rows.push({ timestamp, kwh: kwh.toFixed(2), kvah: (kwh * 1.08).toFixed(2), voltR: '231' });
    kwh += stepKwh;
  }
  return rows;
}
