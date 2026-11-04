// One-off check against the real portal: login, DT list, signed export, one day of energy.
// About 6 portal requests. Run with: npm run smoke
// Prints counts and field names only; never prints the cookie or the signing secret.

import { loadConfig } from '../src/config.js';
import { createPortalClient } from '../src/portal/client.js';

const config = loadConfig();
const portal = createPortalClient({
  baseUrl: config.portalUrl,
  email: config.portalEmail,
  password: config.portalPassword,
  timeoutMs: config.portalTimeoutMs,
  minIntervalMs: config.portalMinIntervalMs,
});

try {
  const dts = await portal.getDts();
  console.log(`DTs: ${dts.length}`, dts[0]);

  const meters = await portal.getMeterExport();
  console.log(`Meters: ${meters.length}; fields:`, Object.keys(meters[0] ?? {}));

  const readings = await portal.getEnergy('J100001', { from: '2026-06-01', to: '2026-06-01' });
  console.log(`J100001 readings on 2026-06-01: ${readings.length}`, readings[0]);

  console.log('Smoke test passed.');
} catch (err) {
  console.error(`Smoke test failed: [${err.kind ?? err.name}] ${err.message}`);
  process.exitCode = 1;
}
