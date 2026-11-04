// Reads settings from environment variables, validates them once at startup,
// and returns a frozen object so the rest of the code never touches process.env.

function required(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function positiveInt(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    portalUrl: env.PORTAL_URL || 'https://urja-ops.flockenergy.tech',
    portalEmail: required(env, 'PORTAL_EMAIL'),
    portalPassword: required(env, 'PORTAL_PASSWORD'),
    port: positiveInt(env, 'PORT', 3000),
    portalTimeoutMs: positiveInt(env, 'PORTAL_TIMEOUT_MS', 10_000),
  });
}
