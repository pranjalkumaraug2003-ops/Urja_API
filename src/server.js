// Entry point: wires config, portal client, service and app together, then listens. Run with: npm start

import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createPortalClient } from './portal/client.js';
import { createMeterService } from './service.js';
import { createApp } from './app.js';

const config = loadConfig();
const openapi = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));

const portal = createPortalClient({
  baseUrl: config.portalUrl,
  email: config.portalEmail,
  password: config.portalPassword,
  timeoutMs: config.portalTimeoutMs,
  minIntervalMs: config.portalMinIntervalMs,
});
const service = createMeterService({ portal });
const app = createApp({ service, openapi });

const server = app.listen(config.port, () => {
  console.log(`Urja Meter Ops API on http://localhost:${config.port} (docs at /docs)`);
});

// Load meters and DTs once at startup so the first request is fast. A failure here is not fatal:
// the first request will try again.
service.warmUp().then(
  () => console.log('Meter cache warmed.'),
  (err) => console.warn(`Cache warm-up failed: [${err.kind ?? err.name}] ${err.message}`),
);

// Finish in-flight requests before exiting on Ctrl+C or a stop signal.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
