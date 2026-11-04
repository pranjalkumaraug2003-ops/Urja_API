// HMAC request signing used by the portal's /portal/export endpoint.
// See PROTOCOL.md, "Export request signing".

import { createHmac } from 'node:crypto';

// Returns the lowercase hex HMAC-SHA256 signature the portal expects.
// The message is method, path, query string and unix timestamp, joined by newlines.
export function signRequest({ method, path, query, timestamp, secret }) {
  const message = [method, path, query, timestamp].join('\n');
  return createHmac('sha256', secret).update(message).digest('hex');
}
