// A small HTTP server that behaves like the Urja Meter Ops portal (PROTOCOL.md), for end-to-end tests.
// It reproduces the parts our client depends on, including the quirks: login result in the body,
// Origin check, session cookie, HMAC-signed export, 20-row pages, JSON 401/404/429, HTML 404 elsewhere.

import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

export const FAKE_CREDENTIALS = { email: 'operator@urja.local', password: 'test-password' };
const SECRET = 'fake-signing-secret-0123456789ab';
const PAGE_SIZE = 20;

export function startFakePortal({ meters, dts, energy = {}, rateLimitAfter = Infinity } = {}) {
  const sessions = new Set();
  const stats = { requests: 0, portalRequests: 0, logins: 0 };
  let origin = '';

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const html404 = (res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<!doctype html><h1>404</h1>');
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => resolve(data));
    });
  const hasSession = (req) => {
    const cookie = req.headers.cookie ?? '';
    return cookie.split(';').some((part) => sessions.has(part.trim().replace(/^better-auth\.session_token=/, '')));
  };

  const server = createServer(async (req, res) => {
    stats.requests++;
    const url = new URL(req.url, origin);

    if (req.method === 'POST' && url.pathname === '/login') {
      stats.logins++;
      if (req.headers.origin !== origin) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('Cross-site POST form submissions are forbidden');
      }
      const form = new URLSearchParams(await readBody(req));
      if (form.get('email') !== FAKE_CREDENTIALS.email || form.get('password') !== FAKE_CREDENTIALS.password) {
        return send(res, 200, { type: 'failure', status: 401, data: '["Invalid email or password."]' });
      }
      const token = randomUUID();
      sessions.add(token);
      return send(res, 200, { type: 'redirect', status: 303, location: '/meters' }, {
        'set-cookie': `better-auth.session_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      });
    }

    if (!url.pathname.startsWith('/portal/')) return html404(res);

    stats.portalRequests++;
    if (stats.portalRequests > rateLimitAfter) return send(res, 429, { error: 'rate_limited', message: 'Rate limit exceeded; slow down.' });
    if (!hasSession(req)) return send(res, 401, { error: 'unauthorized', message: 'A valid session is required.' });

    if (url.pathname === '/portal/dts') {
      const page = Math.max(1, Number.parseInt(url.searchParams.get('page'), 10) || 1);
      return send(res, 200, { data: dts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: dts.length, page, pageSize: PAGE_SIZE });
    }

    if (url.pathname === '/portal/keys') return send(res, 200, { data: { signingSecret: SECRET } });

    if (url.pathname === '/portal/export') {
      const timestamp = req.headers['x-timestamp'] ?? '';
      const message = ['GET', '/portal/export', url.search.slice(1), timestamp].join('\n');
      const expected = createHmac('sha256', SECRET).update(message).digest('hex');
      const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (req.headers['x-signature'] !== expected || !(ageSeconds < 300)) {
        return send(res, 401, { error: 'signature_invalid', message: 'Missing or invalid request signature.' });
      }
      return send(res, 200, { data: meters, total: meters.length });
    }

    const energyMatch = /^\/portal\/meters\/([^/]+)\/energy$/.exec(url.pathname);
    if (energyMatch) {
      const id = decodeURIComponent(energyMatch[1]);
      if (!meters.some((m) => m.meterId === id)) return send(res, 404, { error: 'not_found', message: 'Meter not found' });
      // Same window rule as the portal: whole days from "from" to "to", both inclusive.
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const toIso = (ts) => `${ts.slice(6, 10)}-${ts.slice(3, 5)}-${ts.slice(0, 2)}`;
      const rows = (energy[id] ?? []).filter((r) => toIso(r.timestamp) >= from && toIso(r.timestamp) <= to);
      return send(res, 200, { data: rows });
    }

    return html404(res);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ url: origin, stats, close: () => new Promise((done) => server.close(done)) });
    });
  });
}
