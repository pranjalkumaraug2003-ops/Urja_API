// The only module that talks to the Urja Meter Ops portal.
// It handles login, the session cookie, signed export requests and portal errors,
// and returns the portal's raw data. Cleaning happens elsewhere (src/domain).

import { signRequest } from './sign.js';

// The portal session lasts exactly 1 hour and does not extend on activity.
// We log in again a little before that, so a request never races the expiry.
const SESSION_MAX_AGE_MS = 55 * 60 * 1000;

// Safety stop for paging through /portal/dts, in case "total" is ever missing or wrong.
const MAX_DT_PAGES = 50;

// After a 429 we stop calling the portal for this long. The portal sends no Retry-After;
// recovery took 10 to 25 s in tests, so 30 s is a safe pause (PROTOCOL.md, rate limiting).
const RATE_LIMIT_COOLDOWN_MS = 30_000;

// One error type for everything that can go wrong with the portal.
// "kind" is what the HTTP layer uses to choose our status code (D6).
export class PortalError extends Error {
  constructor(kind, message, { status, cause, retryAfterSeconds } = {}) {
    super(message, { cause });
    this.name = 'PortalError';
    this.kind = kind; // auth_failed | rate_limited | not_found | timeout | unreachable | bad_response
    this.status = status; // the portal's HTTP status, when there was one
    this.retryAfterSeconds = retryAfterSeconds; // set on rate_limited: how long until we call the portal again
  }
}

export function createPortalClient({
  baseUrl,
  email,
  password,
  timeoutMs = 10_000,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  let cookieHeader = null; // "name=value; name2=value2", sent on every request
  let loggedInAt = 0;
  let loginInFlight = null; // shared promise, so parallel requests trigger only one login
  let blockedUntil = 0; // set after a 429: no portal calls before this time

  // Records a 429 and returns the error to throw.
  function rateLimited(context) {
    blockedUntil = now() + RATE_LIMIT_COOLDOWN_MS;
    return new PortalError('rate_limited', `Portal rate limit reached${context}`, {
      status: 429,
      retryAfterSeconds: RATE_LIMIT_COOLDOWN_MS / 1000,
    });
  }

  // Refuses to call the portal while we are cooling down after a 429.
  function assertNotBlocked() {
    const waitMs = blockedUntil - now();
    if (waitMs > 0) {
      throw new PortalError('rate_limited', 'Waiting after a portal rate limit', {
        retryAfterSeconds: Math.ceil(waitMs / 1000),
      });
    }
  }

  // Sends one HTTP request and turns network failures into PortalErrors.
  async function send(path, { method = 'GET', query, headers = {}, body } = {}) {
    const url = new URL(path, baseUrl);
    if (query) url.search = query;
    try {
      return await fetchImpl(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') {
        throw new PortalError('timeout', `Portal did not respond within ${timeoutMs} ms`, { cause: err });
      }
      throw new PortalError('unreachable', 'Could not reach the portal', { cause: err });
    }
  }

  // Parses a JSON body, refusing HTML pages (the portal answers unknown routes with HTML).
  async function readJson(res, path) {
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) {
      throw new PortalError('bad_response', `Expected JSON from ${path}, got "${type || 'no content type'}"`, {
        status: res.status,
      });
    }
    try {
      return await res.json();
    } catch (err) {
      throw new PortalError('bad_response', `Invalid JSON from ${path}`, { status: res.status, cause: err });
    }
  }

  async function login() {
    const res = await send('/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json', // asks SvelteKit for the JSON action result instead of an HTML page
        origin: new URL(baseUrl).origin, // SvelteKit rejects form posts without a matching Origin (CSRF check)
      },
      body: new URLSearchParams({ email, password }).toString(),
    });
    if (res.status === 429) throw rateLimited(' during login');

    // Login always returns HTTP 200; the real result is in the body.
    const body = await readJson(res, '/login');
    if (body.type !== 'redirect') {
      throw new PortalError('auth_failed', 'Portal login was rejected', { status: res.status });
    }

    // Keep only "name=value" from each Set-Cookie header, without hard-coding the cookie name.
    const cookies = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0].trim())
      .filter(Boolean);
    if (cookies.length === 0) {
      throw new PortalError('auth_failed', 'Portal login succeeded but set no session cookie');
    }
    cookieHeader = cookies.join('; ');
    loggedInAt = now();
  }

  // Makes sure we have a session that is not about to expire. force=true logs in again.
  async function ensureSession({ force = false } = {}) {
    const fresh = cookieHeader !== null && now() - loggedInAt < SESSION_MAX_AGE_MS;
    if (fresh && !force) return;
    loginInFlight ??= login().finally(() => {
      loginInFlight = null;
    });
    await loginInFlight;
  }

  // Authenticated GET returning parsed JSON. On a session 401 it logs in again and retries once.
  async function getJson(path, { query, headers = {} } = {}, retried = false) {
    assertNotBlocked();
    await ensureSession();
    const res = await send(path, {
      query,
      headers: { ...headers, accept: 'application/json', cookie: cookieHeader },
    });

    if (res.status === 401) {
      const body = await res.json().catch(() => null);
      if (body?.error === 'unauthorized' && !retried) {
        await ensureSession({ force: true });
        return getJson(path, { query, headers }, true);
      }
      // A second 401, or a 401 for another reason (e.g. signature_invalid), is not fixable by retrying.
      const kind = body?.error === 'unauthorized' ? 'auth_failed' : 'bad_response';
      throw new PortalError(kind, `Portal rejected ${path}: ${body?.error ?? 'HTTP 401'}`, { status: 401 });
    }
    if (res.status === 429) throw rateLimited('');
    if (res.status === 404) throw new PortalError('not_found', `Portal has nothing at ${path}`, { status: 404 });
    if (!res.ok) throw new PortalError('bad_response', `Portal returned HTTP ${res.status} for ${path}`, { status: res.status });

    return readJson(res, path);
  }

  // Every list endpoint returns { data: [...] }; anything else means the portal changed.
  function expectArray(body, path) {
    if (!Array.isArray(body?.data)) {
      throw new PortalError('bad_response', `Expected a "data" array from ${path}`);
    }
    return body.data;
  }

  return {
    // All distribution transformers. The portal pages them 20 at a time.
    async getDts() {
      const all = [];
      for (let page = 1; page <= MAX_DT_PAGES; page++) {
        const body = await getJson('/portal/dts', { query: new URLSearchParams({ page: String(page) }).toString() });
        const rows = expectArray(body, '/portal/dts');
        all.push(...rows);
        if (rows.length === 0 || all.length >= body.total) return all;
      }
      throw new PortalError('bad_response', `/portal/dts returned more than ${MAX_DT_PAGES} pages`);
    },

    // All meters from the signed export (D1): fetch the secret, sign, request.
    async getMeterExport() {
      const keys = await getJson('/portal/keys');
      const secret = keys?.data?.signingSecret;
      if (typeof secret !== 'string' || secret === '') {
        throw new PortalError('bad_response', '/portal/keys did not return a signing secret');
      }
      const path = '/portal/export';
      const query = 'page=1'; // same as the portal UI; the portal ignores it but it is part of the signature
      const timestamp = String(Math.floor(now() / 1000));
      const signature = signRequest({ method: 'GET', path, query, timestamp, secret });
      const body = await getJson(path, { query, headers: { 'x-timestamp': timestamp, 'x-signature': signature } });
      return expectArray(body, path);
    },

    // Raw energy readings for one meter. from/to are YYYY-MM-DD; we always send both.
    async getEnergy(meterId, { from, to }) {
      const path = `/portal/meters/${encodeURIComponent(meterId)}/energy`;
      const body = await getJson(path, { query: new URLSearchParams({ from, to }).toString() });
      return expectArray(body, path);
    },
  };
}
