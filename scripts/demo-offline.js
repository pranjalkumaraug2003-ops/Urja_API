// Runs the API against the fake portal from the tests, with generated data, so the API and web client
// can be tried without the live portal. The data is synthetic. Run with: npm run demo
// (npm start is the real thing: it talks to the live portal using .env.)

import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { createMeterService } from '../src/service.js';
import { createPortalClient } from '../src/portal/client.js';
import { startFakePortal, FAKE_CREDENTIALS } from '../test/support/fake-portal.js';
import { rawMeter, rawEnergy } from '../test/support/fixtures.js';

const STATUSES = ['Installed', 'Installed', 'Installed', 'Faulty', 'Decommissioned'];
const MAKES = ['HPL', 'Genus', 'Secure', 'Allied', 'L&T'];

// A deterministic pseudo-random sequence, so every demo run shows the same data.
let seed = 42;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const dts = [];
const meters = [];
const energy = {};
for (let d = 1; d <= 8; d++) {
  const dtCode = `DT-00${d}`;
  const chain = [`Z-0${1 + (d % 2)}`, `C-0${1 + (d % 3)}`, 'D-01', `SD-0${d}`, `SS-0${d}`, `F-00${d}`];
  dts.push({ code: dtCode, name: `Demo DT ${d}`, feederCode: chain[5], capacityKva: [63, 100, 160, 250][d % 4] });
  const center = { lat: 26.85 + random() * 0.12, lng: 75.72 + random() * 0.16 };
  for (let i = 0; i < 10; i++) {
    const meterId = `J1${String(d * 100 + i).padStart(5, '0')}`;
    meters.push(
      rawMeter(meterId, dtCode, {
        chain,
        dtName: `Demo DT ${d}`,
        make: MAKES[Math.floor(random() * MAKES.length)],
        installStatus: STATUSES[Math.floor(random() * STATUSES.length)],
        phaseType: random() < 0.3 ? 'three' : 'single',
        geo: { lat: center.lat + (random() - 0.5) * 0.01, lng: center.lng + (random() - 0.5) * 0.01 },
      }),
    );
    const halfHourly = d === 1;
    energy[meterId] = rawEnergy({
      fromDate: '2026-06-01',
      toDate: '2026-06-30',
      intervalMinutes: halfHourly ? 30 : 1440,
      startKwh: 10_000 + Math.floor(random() * 30_000),
      stepKwh: halfHourly ? 0.3 + random() * 0.4 : 8 + random() * 10,
    });
  }
}

const portal = await startFakePortal({ meters, dts, energy });
const client = createPortalClient({ baseUrl: portal.url, ...FAKE_CREDENTIALS, minIntervalMs: 0 });
const openapi = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const app = createApp({ service: createMeterService({ portal: client }), openapi });

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Offline demo (synthetic data from a fake portal at ${portal.url})`);
  console.log(`Web client: http://localhost:${port}/   API docs: http://localhost:${port}/docs`);
});
